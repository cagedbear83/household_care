import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import type { TaskState } from "@prisma/client";
import { db } from "../src/db";
import { hashPassword } from "../src/auth/password";
import { buildReport, ReportError, type ReportViewer } from "../src/services/report.service";
import { appendEvent, verifyChainIntegrity } from "../src/services/event.service";
import { addLocalDays, localDateString } from "../src/services/time.service";

let householdId: string;
let otherHouseholdId: string;
let ids: { client: string; admin: string; ip: string; famHidden: string; famTimes: string };
let templateId: string;
let tz: string;
let today: string;
const day = { late: "", missed: "", excess: "", noCheckout: "" } as Record<string, string>;

const viewer = (userId: string, role: ReportViewer["role"], canViewTimestamps = role !== "FAMILY"): ReportViewer => ({ userId, householdId, role, canViewTimestamps });
const asClient = () => viewer(ids.client, "CLIENT");
const at = (date: string, time: string) => DateTime.fromFormat(`${date} ${time}`, "yyyy-MM-dd HH:mm", { zone: tz }).toJSDate();

async function makeShift(date: string, start: string, end: string, extra: object = {}) {
  return db.scheduledShift.create({
    data: {
      householdId, ipUserId: ids.ip, localDate: date, scheduledStartUtc: at(date, start), scheduledEndUtc: at(date, end),
      authorizedEndUtc: at(date, end), status: "SCHEDULED", createdBy: ids.admin, ...extra,
    },
  });
}

async function addTasks(shiftId: string, date: string, states: TaskState[], titlePrefix = "Task") {
  for (const [i, state] of states.entries()) {
    await db.taskInstance.create({
      data: { householdId, shiftId, templateId, assignedDate: date, titleSnapshot: `${titlePrefix} ${i + 1}`, instructionsSnapshot: "x", requiresPhotoSnapshot: false, state },
    });
  }
}

beforeAll(async () => {
  const passwordHash = await hashPassword("test-only-password");
  const h = await db.household.create({ data: { name: "reports-test", apartmentLat: 0, apartmentLng: 0 } });
  const o = await db.household.create({ data: { name: "reports-test-other", apartmentLat: 0, apartmentLng: 0 } });
  householdId = h.id;
  otherHouseholdId = o.id;
  tz = h.timezone;
  today = localDateString(new Date(), tz);
  const mk = (hid: string, role: "CLIENT" | "ADMIN" | "IP" | "FAMILY", name: string, extra: object = {}) =>
    db.user.create({ data: { householdId: hid, role, name, email: `${name.toLowerCase()}-${h.id}@test.local`, passwordHash, ...extra } });
  const [client, admin, ip, famHidden, famTimes, otherIp] = await Promise.all([
    mk(householdId, "CLIENT", "Chris"),
    mk(householdId, "ADMIN", "Morgan"),
    mk(householdId, "IP", "Pat"),
    mk(householdId, "FAMILY", "Sam", { canViewTimestamps: false }),
    mk(householdId, "FAMILY", "Alex", { canViewTimestamps: true }),
    mk(otherHouseholdId, "IP", "Outsider"),
  ]);
  ids = { client: client.id, admin: admin.id, ip: ip.id, famHidden: famHidden.id, famTimes: famTimes.id };
  const template = await db.taskTemplate.create({ data: { householdId, groupName: "Kitchen", title: "Original title", instructions: "x", frequency: "VISIT", requiresPhoto: false, sortOrder: 0 } });
  templateId = template.id;

  day.excess = addLocalDays(today, -4);
  day.late = addLocalDays(today, -3);
  day.missed = addLocalDays(today, -2);
  day.noCheckout = addLocalDays(today, -1);

  // Checked in 40 minutes early, out 30 minutes past the authorized end.
  await makeShift(day.excess, "09:00", "17:00", { observedCheckInUtc: at(day.excess, "08:20"), observedCheckOutUtc: at(day.excess, "17:30") });

  // 20 minutes late in, 30 minutes early out, with a mix of task outcomes.
  const late = await makeShift(day.late, "09:00", "17:00", { observedCheckInUtc: at(day.late, "09:20"), observedCheckOutUtc: at(day.late, "16:30") });
  await addTasks(late.id, day.late, [
    "APPROVED", "APPROVED", "APPROVED", "APPROVED", "COMPLETED_AWAITING_REVIEW", "DISPUTED",
    "CLIENT_DECLINED_CONFIRMED", "NOT_NEEDED", "UNABLE_TO_COMPLETE", "MISSED_AT_SHIFT_END",
  ]);
  await db.taskInstance.updateMany({ where: { shiftId: late.id, state: "UNABLE_TO_COMPLETE" }, data: { reasonCode: "supplies_unavailable" } });

  // Never checked in.
  await makeShift(day.missed, "09:00", "17:00");

  // Checked in, never checked out; the system closed authorization.
  const noCheckout = await makeShift(day.noCheckout, "09:00", "17:00", { observedCheckInUtc: at(day.noCheckout, "09:00"), authorizationClosedAt: at(day.noCheckout, "17:00"), authorizationClosedReason: "SCHEDULED_END" });
  await addTasks(noCheckout.id, day.noCheckout, ["NOT_STARTED", "APPROVED"], "Evening task");

  // Someone else's household: must never appear.
  const stray = await db.scheduledShift.create({
    data: { householdId: otherHouseholdId, ipUserId: otherIp.id, localDate: day.late, scheduledStartUtc: at(day.late, "09:00"), scheduledEndUtc: at(day.late, "17:00"), status: "SCHEDULED", createdBy: otherIp.id },
  });
  await db.taskInstance.create({
    data: { householdId: otherHouseholdId, shiftId: stray.id, templateId: (await db.taskTemplate.create({ data: { householdId: otherHouseholdId, groupName: "X", title: "X", instructions: "x", frequency: "VISIT", sortOrder: 0 } })).id, assignedDate: day.late, titleSnapshot: "Outsider task", instructionsSnapshot: "x", requiresPhotoSnapshot: false, state: "APPROVED" },
  });

  // A dispute recorded in the audit log (today).
  const disputed = (await db.taskInstance.findFirst({ where: { shiftId: late.id, state: "DISPUTED" } }))!;
  await db.$transaction((tx) =>
    appendEvent(tx, { householdId, actorUserId: ids.client, actorRole: "CLIENT", action: "task_disputed", shiftId: late.id, taskInstanceId: disputed.id, payload: { reason: "Counter still sticky" } })
  );
});

afterAll(async () => {
  for (const id of [householdId, otherHouseholdId]) {
    await db.event.deleteMany({ where: { householdId: id } });
    await db.taskInstance.deleteMany({ where: { householdId: id } });
    await db.scheduledShift.deleteMany({ where: { householdId: id } });
    await db.taskTemplate.deleteMany({ where: { householdId: id } });
    await db.user.deleteMany({ where: { householdId: id } });
    await db.household.delete({ where: { id } });
  }
  await db.$disconnect();
});

describe("asking for a report", () => {
  it("rejects bad dates, backwards ranges and ranges that are too long", async () => {
    await expect(buildReport(asClient(), { from: "2026-13-40", to: "2026-10-01" })).rejects.toMatchObject({ code: "INVALID_RANGE" });
    await expect(buildReport(asClient(), { from: "2026-10-05", to: "2026-10-01" })).rejects.toMatchObject({ code: "INVALID_RANGE" });
    await expect(buildReport(asClient(), { from: "2025-01-01", to: "2026-10-01" })).rejects.toMatchObject({ code: "RANGE_TOO_LONG" });
    await expect(buildReport(asClient(), { from: "2026-10-01", to: "2026-10-01" })).resolves.toBeTruthy();
  });

  it("is not available to the IP", async () => {
    await expect(buildReport(viewer(ids.ip, "IP"), { from: today, to: today })).rejects.toBeInstanceOf(ReportError);
  });

  it("states when it was made, for which dates, in which timezone, and by whom", async () => {
    const r = await buildReport(asClient(), { from: day.late, to: day.late }, new Date("2026-10-03T12:00:00Z"));
    expect(r.meta).toMatchObject({ from: day.late, to: day.late, days: 1, timezone: tz, generatedAt: "2026-10-03T12:00:00.000Z", generatedBy: { name: "Chris", role: "CLIENT" }, scope: "full" });
    expect(r.meta.notes.join(" ")).toMatch(/not saved by the app/);
  });
});

describe("task outcomes", () => {
  it("counts each outcome separately and never counts declines as work done", async () => {
    const t = (await buildReport(asClient(), { from: day.late, to: day.late })).tasks;
    expect(t.totals).toMatchObject({
      assigned: 10, submitted: 6, approved: 4, awaitingReview: 1, disputed: 1,
      confirmedDeclined: 1, notNeeded: 1, unableToComplete: 1, missed: 1, stillOpen: 0,
    });
    expect(t.percentages.completion).toBe(60); // 6 submitted (incl. the disputed one) of 10 assigned
    expect(t.percentages.approved).toBe(40);
    expect(t.percentages.coverage).toBe(90); // everything except the one missed
    expect(t.percentages.resolution).toBe(70); // approved 4 + declined 1 + not needed 1 + unable 1
    expect(t.resolved).toBe(7);
    expect(t.unresolved).toBe(3);
  });

  it("lists what was not completed with the reason, using the snapshot taken at check-in", async () => {
    await db.taskTemplate.update({ where: { id: templateId }, data: { title: "Renamed later" } });
    const t = (await buildReport(asClient(), { from: day.late, to: day.late })).tasks;
    const unable = t.notCompleted.find((x) => x.outcome === "Marked unable to complete")!;
    expect(unable.reason).toBe("supplies unavailable");
    expect(unable.title).toMatch(/^Task \d+$/);
    expect(JSON.stringify(t)).not.toContain("Renamed later");
    expect(t.notCompleted.map((x) => x.outcome)).toEqual(expect.arrayContaining(["Disputed by the client", "Client confirmed they declined", "Marked not needed", "Not done by the end of the visit"]));
  });

  it("treats tasks left open after a visit ended as missed, and gives a day-by-day table", async () => {
    const t = (await buildReport(asClient(), { from: day.late, to: day.noCheckout })).tasks;
    expect(t.totals.assigned).toBe(12);
    expect(t.totals.missed).toBe(2); // the missed one and the NOT_STARTED one after authorization closed
    expect(t.byDay.map((d) => d.date)).toEqual([day.late, day.noCheckout]);
    expect(t.byGroup).toHaveLength(1);
  });

  it("reports no percentage when nothing was assigned, and never includes another household", async () => {
    const empty = (await buildReport(asClient(), { from: day.missed, to: day.missed })).tasks;
    expect(empty.totals.assigned).toBe(0);
    expect(empty.percentages.completion).toBeNull();
    expect(JSON.stringify(await buildReport(asClient(), { from: day.late, to: today }))).not.toContain("Outsider");
  });
});

describe("attendance: authorized and observed totals", () => {
  it("keeps observed time and the minutes counted toward the limit apart", async () => {
    const r = await buildReport(asClient(), { from: day.excess, to: day.excess });
    const row = r.attendance!.rows[0]!;
    expect(row.scheduledMinutes).toBe(480);
    expect(row.observedMinutes).toBe(550); // 8:20 to 17:30
    expect(row.authorizedMinutes).toBe(520); // 8:20 to the 17:00 authorized end; the extra 30 minutes are not counted
    expect(r.attendance!.totals).toMatchObject({ scheduledMinutes: 480, observedMinutes: 550, authorizedMinutes: 520 });
  });

  it("flags early and late arrivals, early departures, time past the window, missed visits and missing checkouts", async () => {
    const r = await buildReport(asClient(), { from: day.excess, to: day.noCheckout });
    const kinds = (r.exceptions!.items).map((i) => i.kind);
    expect(kinds).toEqual(expect.arrayContaining(["early_check_in", "excess_time", "late_check_in", "early_checkout", "no_check_in", "missing_checkout", "tasks_not_done"]));
    expect(r.exceptions!.items.find((i) => i.kind === "late_check_in")!.text).toMatch(/20 minutes after the scheduled start/);
    expect(r.exceptions!.items.find((i) => i.kind === "early_checkout")!.text).toMatch(/30 minutes before the scheduled end/);
    expect(r.attendance!.totals).toMatchObject({ visitsScheduled: 4, visitsMissed: 1, visitsWithoutCheckout: 1 });
    expect(r.attendance!.rows.find((x) => x.status === "no_checkout")!.observedMinutes).toBeNull(); // no checkout to measure to
  });

  it("includes disputes from the audit log with the client's reason", async () => {
    const r = await buildReport(asClient(), { from: day.late, to: today });
    const dispute = r.exceptions!.items.find((i) => i.kind === "dispute")!;
    expect(dispute.text).toContain("Counter still sticky");
  });

  it("shows weekly totals against the 36-hour limit, marking partial weeks", async () => {
    const r = await buildReport(asClient(), { from: day.late, to: day.late });
    expect(r.attendance!.weeks.length).toBeGreaterThanOrEqual(1);
    for (const w of r.attendance!.weeks) {
      expect(w.capMinutes).toBe(2160);
      expect(w.overCap).toBe(false);
    }
    expect(r.attendance!.weeks.some((w) => w.partial)).toBe(true);
  });
});

describe("who sees what", () => {
  it("gives a family member without approval the task counts only: no times, no attendance, no exceptions", async () => {
    const r = await buildReport(viewer(ids.famHidden, "FAMILY", false), { from: day.excess, to: today });
    expect(r.meta.scope).toBe("tasks_only");
    expect(r.attendance).toBeNull();
    expect(r.exceptions).toBeNull();
    expect(r.tasks.totals.assigned).toBe(12);
    expect(r.meta.notes.join(" ")).toMatch(/not shown because the client has not approved/);
    const text = JSON.stringify(r);
    expect(text).not.toMatch(/checkIn|checkOut|observed/);
  });

  it("gives an approved family member and the administrator the full report", async () => {
    expect((await buildReport(viewer(ids.famTimes, "FAMILY", true), { from: day.late, to: day.late })).meta.scope).toBe("full");
    expect((await buildReport(viewer(ids.admin, "ADMIN"), { from: day.late, to: day.late })).attendance).not.toBeNull();
  });

  it("records only who made a report and for which dates, and the audit chain stays intact", async () => {
    const before = await db.event.count({ where: { householdId, action: "report_generated" } });
    await buildReport(asClient(), { from: day.late, to: today });
    const events = await db.event.findMany({ where: { householdId, action: "report_generated" }, orderBy: { serverTimestampUtc: "desc" }, take: 1 });
    expect(await db.event.count({ where: { householdId, action: "report_generated" } })).toBe(before + 1);
    expect(events[0]!.payload).toEqual({ from: day.late, to: today, sections: ["attendance", "tasks", "exceptions"] });
    expect(JSON.stringify(events[0]!.payload)).not.toContain("Counter still sticky");
    expect((await verifyChainIntegrity(householdId)).ok).toBe(true);
  });
});
