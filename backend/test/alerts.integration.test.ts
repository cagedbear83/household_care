import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "../src/db";
import { hashPassword } from "../src/auth/password";
import { checkIn, checkOut } from "../src/services/authorization.service";
import { raiseAlert, resolveAlerts } from "../src/services/alert.service";
import {
  AlertFeedError,
  deliverPendingAlerts,
  listAlerts,
  markAllRead,
  markRead,
  unreadSummary,
} from "../src/services/alert-feed.service";
import { completeTask, declineOnClientBehalf } from "../src/services/task.service";
import { confirmDecline } from "../src/services/review.service";
import { verifyChainIntegrity } from "../src/services/event.service";
import * as notify from "../src/services/notify.service";
import { localDateString } from "../src/services/time.service";

let householdId: string;
let otherHouseholdId: string;
let ids: { client: string; admin: string; admin2: string; ip: string; other: string; shift: string };
const here = { lat: 0, lng: 0, accuracyMeters: 5 };
const tasks: Record<string, string> = {};

const asAdmin = () => ({ userId: ids.admin, role: "ADMIN" as const, householdId });
const asAdmin2 = () => ({ userId: ids.admin2, role: "ADMIN" as const, householdId });
const asClient = () => ({ userId: ids.client, role: "CLIENT" as const, householdId });
const alertsOf = (type: string) => db.alert.findMany({ where: { householdId, type }, orderBy: { createdAt: "asc" } });

beforeAll(async () => {
  const passwordHash = await hashPassword("test-only-password");
  const h = await db.household.create({ data: { name: "alerts-test", apartmentLat: 0, apartmentLng: 0 } });
  const o = await db.household.create({ data: { name: "alerts-test-other", apartmentLat: 0, apartmentLng: 0 } });
  householdId = h.id;
  otherHouseholdId = o.id;
  const mk = (hid: string, role: "CLIENT" | "ADMIN" | "IP", name: string, extra: object = {}) =>
    db.user.create({ data: { householdId: hid, role, name, email: `${name.toLowerCase()}-${h.id}@test.local`, passwordHash, ...extra } });
  const [client, admin, admin2, ip, other] = await Promise.all([
    mk(householdId, "CLIENT", "Chris"),
    mk(householdId, "ADMIN", "Morgan"),
    mk(householdId, "ADMIN", "Lee"),
    mk(householdId, "IP", "Pat"),
    mk(otherHouseholdId, "ADMIN", "Outsider"),
  ]);

  for (const [i, title] of ["T1", "T2", "T3", "T4", "T5", "T6"].entries()) {
    await db.taskTemplate.create({ data: { householdId, groupName: "Kitchen", title, instructions: "x", frequency: "VISIT", requiresPhoto: false, sortOrder: i } });
  }
  const now = new Date();
  const shift = await db.scheduledShift.create({
    data: {
      householdId,
      ipUserId: ip.id,
      localDate: localDateString(now, h.timezone),
      scheduledStartUtc: new Date(now.getTime() - 5 * 60_000),
      scheduledEndUtc: new Date(now.getTime() + 6 * 3_600_000),
      status: "SCHEDULED",
      createdBy: ip.id,
    },
  });
  ids = { client: client.id, admin: admin.id, admin2: admin2.id, ip: ip.id, other: other.id, shift: shift.id };
  await checkIn({ shiftId: shift.id, ipUserId: ip.id, ...here });
  for (const t of await db.taskInstance.findMany({ where: { shiftId: shift.id } })) tasks[t.titleSnapshot] = t.id;
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.COMPLETION_BURST_THRESHOLD;
});

afterAll(async () => {
  for (const id of [householdId, otherHouseholdId]) {
    await db.alertRead.deleteMany({ where: { alert: { householdId: id } } });
    await db.alert.deleteMany({ where: { householdId: id } });
    await db.outboundMessage.deleteMany({ where: { householdId: id } });
    await db.event.deleteMany({ where: { householdId: id } });
    await db.locationReading.deleteMany({ where: { householdId: id } });
    await db.taskInstance.deleteMany({ where: { householdId: id } });
    await db.scheduledShift.deleteMany({ where: { householdId: id } });
    await db.weekAllowance.deleteMany({ where: { householdId: id } });
    await db.taskTemplate.deleteMany({ where: { householdId: id } });
    await db.user.deleteMany({ where: { householdId: id } });
    await db.household.delete({ where: { id } });
  }
  await db.$disconnect();
});

describe("alert records", () => {
  it("shows the check-in to administrators only, newest first, with the audit event linked", async () => {
    const adminList = await listAlerts(asAdmin());
    expect(adminList.map((a) => a.type)).toContain("check_in");
    expect((await listAlerts(asClient())).map((a) => a.type)).not.toContain("check_in");

    const row = (await alertsOf("check_in"))[0]!;
    expect(row.eventId).toBeTruthy();
    const event = await db.event.findUniqueOrThrow({ where: { id: row.eventId! } });
    expect(event.action).toBe("alert_raised");
  });

  it("does not raise the same matter twice, and keeps one audit event for it", async () => {
    const make = () =>
      db.$transaction((tx) =>
        raiseAlert(tx, { householdId, actorUserId: ids.ip, actorRole: "IP", type: "low_supply", message: "Eggs is all gone.", refId: "item-1", dedupeKey: "low_supply:item-1:OUT" })
      );
    expect(await make()).not.toBeNull();
    expect(await make()).toBeNull();
    expect(await alertsOf("low_supply")).toHaveLength(1);
    const events = await db.event.count({ where: { householdId, action: "alert_raised", payload: { path: ["message"], equals: "Eggs is all gone." } } });
    expect(events).toBe(1);
  });

  it("keeps one household's alerts out of another's list and read calls", async () => {
    const outsider = { userId: ids.other, role: "ADMIN" as const, householdId: otherHouseholdId };
    expect(await listAlerts(outsider)).toEqual([]);
    const mine = (await alertsOf("check_in"))[0]!;
    await expect(markRead(outsider, mine.id)).rejects.toBeInstanceOf(AlertFeedError);
  });

  it("tracks who has read what separately for each person", async () => {
    const before = (await unreadSummary(asAdmin())).unread;
    expect(before).toBeGreaterThan(0);
    const target = (await alertsOf("check_in"))[0]!;
    await markRead(asAdmin(), target.id);
    await markRead(asAdmin(), target.id); // twice is fine
    expect((await unreadSummary(asAdmin())).unread).toBe(before - 1);
    expect((await unreadSummary(asAdmin2())).unread).toBe(before); // the other administrator still has it unread
    const list = await listAlerts(asAdmin());
    expect(list.find((a) => a.id === target.id)!.read).toBe(true);
    expect((await listAlerts(asAdmin2())).find((a) => a.id === target.id)!.read).toBe(false);
  });

  it("cannot mark read an alert meant for another role", async () => {
    const adminOnly = (await alertsOf("check_in"))[0]!;
    await expect(markRead(asClient(), adminOnly.id)).rejects.toBeInstanceOf(AlertFeedError);
  });

  it("counts urgent items separately and returns the newest unread urgent one", async () => {
    const before = await unreadSummary(asAdmin());
    await db.$transaction((tx) =>
      raiseAlert(tx, { householdId, actorUserId: ids.ip, actorRole: "IP", type: "food_hazard", message: "Mold in the refrigerator.", refId: "h1", dedupeKey: "hazard:h1" })
    );
    const after = await unreadSummary(asAdmin());
    expect(after.unread).toBe(before.unread + 1);
    expect(after.urgent).toBe(before.urgent + 1);
    expect(after.newestUrgent?.message).toBe("Mold in the refrigerator.");
    // The client hears about a hazard too.
    expect((await unreadSummary(asClient())).urgent).toBeGreaterThanOrEqual(1);
    const listed = (await listAlerts(asAdmin())).find((a) => a.message === "Mold in the refrigerator.")!;
    expect(listed.severity).toBe("URGENT");
    expect(listed.link).toBe("/food");
  });

  it("marks an action-required alert handled without losing it", async () => {
    await db.$transaction((tx) => resolveAlerts(tx, householdId, "low_supply", "item-1"));
    const row = (await listAlerts(asAdmin())).find((a) => a.message === "Eggs is all gone.")!;
    expect(row.resolved).toBe(true);
  });

  it("marks everything read in one step", async () => {
    const marked = await markAllRead(asClient());
    expect(marked).toBeGreaterThanOrEqual(0);
    expect((await unreadSummary(asClient())).unread).toBe(0);
    expect(await markAllRead(asClient())).toBe(0);
  });
});

describe("alerts raised by the work itself", () => {
  it("flags a burst of completions as 'may need a look', once, and never calls it proof", async () => {
    process.env.COMPLETION_BURST_THRESHOLD = "3";
    await completeTask(tasks.T1!, ids.ip);
    await completeTask(tasks.T2!, ids.ip);
    expect(await alertsOf("suspicious_pattern")).toHaveLength(0);
    await completeTask(tasks.T3!, ids.ip);
    await completeTask(tasks.T4!, ids.ip);
    const burst = await alertsOf("suspicious_pattern");
    expect(burst).toHaveLength(1);
    expect(burst[0]!.severity).toBe("URGENT");
    expect(burst[0]!.message).toMatch(/may need a look/);
    expect(burst[0]!.message.toLowerCase()).not.toMatch(/proof|fraud|fake|cheat/);
    expect(burst[0]!.audience).toEqual(["ADMIN"]);
  });

  it("does not flag an ordinary pace", async () => {
    // Default threshold (15) is far above what the tests did.
    const all = await alertsOf("suspicious_pattern");
    expect(all).toHaveLength(1);
  });

  it("tells the client and administrators about an IP-reported decline, and clears it when the client answers", async () => {
    await declineOnClientBehalf(tasks.T5!, ids.ip, "No appetite");
    const [reported] = await alertsOf("task_decline_reported");
    expect(reported).toBeTruthy();
    expect(reported!.audience.sort()).toEqual(["ADMIN", "CLIENT"]);
    expect(reported!.resolvedAt).toBeNull();

    await confirmDecline({ userId: ids.client, householdId }, tasks.T5!);
    const [after] = await alertsOf("task_decline_reported");
    expect(after!.resolvedAt).not.toBeNull();
  });

  it("raises early-checkout and tasks-left-undone alerts when the IP leaves with work open", async () => {
    await checkOut({ shiftId: ids.shift, ipUserId: ids.ip, ...here });
    const early = await alertsOf("early_checkout");
    expect(early).toHaveLength(1);
    expect(early[0]!.message).toMatch(/minute\(s\) before the scheduled end/);
    const left = await alertsOf("unresolved_tasks_near_checkout");
    expect(left).toHaveLength(1);
    expect(left[0]!.message).toContain("1 task not done"); // only T6 was never touched
    expect(left[0]!.audience.sort()).toEqual(["ADMIN", "CLIENT"]);
  });

  it("keeps the audit trail intact after all of that", async () => {
    expect((await verifyChainIntegrity(householdId)).ok).toBe(true);
  });
});

describe("text and email delivery", () => {
  const ADMIN_EMAIL = () => `morgan-${householdId}@test.local`;

  it("sends each pending alert once to the people it is for, and not again", async () => {
    const sent = vi.spyOn(notify, "sendMessage").mockResolvedValue({ delivered: true, provider: "test" });
    const first = await deliverPendingAlerts(householdId);
    expect(first).toBeGreaterThan(0);
    const calls = sent.mock.calls.length;
    expect(calls).toBeGreaterThan(0);
    expect(sent.mock.calls.some(([m]) => m.to === ADMIN_EMAIL())).toBe(true);
    // Food-type alerts notify at the moment they happen, so the queue leaves them alone.
    const hazard = (await alertsOf("food_hazard"))[0]!;
    expect(hazard.notifyPending).toBe(false);

    expect(await deliverPendingAlerts(householdId)).toBe(0);
    expect(sent.mock.calls.length).toBe(calls);
    const stillPending = await db.alert.count({ where: { householdId, notifyPending: true, notifiedAt: null } });
    expect(stillPending).toBe(0);
  });

  it("retries a failed delivery up to three times and then stops", async () => {
    await db.$transaction((tx) =>
      raiseAlert(tx, { householdId, actorUserId: ids.ip, actorRole: "IP", type: "location_verification_failed", message: "Retry me.", dedupeKey: "retry-me" })
    );
    const failing = vi.spyOn(notify, "sendMessage").mockResolvedValue({ delivered: false, provider: "test" });
    for (let i = 0; i < 5; i++) await deliverPendingAlerts(householdId);
    const row = await db.alert.findFirstOrThrow({ where: { householdId, dedupeKey: "retry-me" } });
    expect(row.notifyAttempts).toBe(3);
    expect(row.notifiedAt).toBeNull();
    const callsAfterThree = failing.mock.calls.length;
    await deliverPendingAlerts(householdId);
    expect(failing.mock.calls.length).toBe(callsAfterThree);
  });

  it("sends it on a later attempt if the first one fails", async () => {
    await db.$transaction((tx) =>
      raiseAlert(tx, { householdId, actorUserId: ids.ip, actorRole: "IP", type: "excess_time", message: "Second chance.", dedupeKey: "second-chance" })
    );
    vi.spyOn(notify, "sendMessage").mockResolvedValueOnce({ delivered: false, provider: "test" }).mockResolvedValue({ delivered: true, provider: "test" });
    expect(await deliverPendingAlerts(householdId)).toBe(0);
    expect(await deliverPendingAlerts(householdId)).toBe(1);
    const row = await db.alert.findFirstOrThrow({ where: { householdId, dedupeKey: "second-chance" } });
    expect(row.notifiedAt).not.toBeNull();
    expect(row.notifyAttempts).toBe(2);
  });
});
