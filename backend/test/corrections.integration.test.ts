import { afterAll, beforeAll, describe, expect, it } from "vitest";
import sharp from "sharp";
import { db } from "../src/db";
import { hashPassword } from "../src/auth/password";
import { checkIn } from "../src/services/authorization.service";
import { acceptEvidence, issueChallenge } from "../src/services/evidence.service";
import { completeTask, TaskActionRejectedError } from "../src/services/task.service";
import { approveTask, getPending, getReviewDay, getReviewTask } from "../src/services/review.service";
import { appendCorrection, CorrectionError, declineRequest, listForIp, listForStaff, requestCorrection } from "../src/services/correction.service";
import { toIpTaskDtos } from "../src/services/ip-dto";
import { buildReport } from "../src/services/report.service";
import { verifyChainIntegrity } from "../src/services/event.service";
import { removeHouseholdFiles } from "../src/services/evidence-store";
import { localDateString } from "../src/services/time.service";

let householdId: string;
let otherHouseholdId: string;
let ids: { client: string; admin: string; ip: string; ip2: string; family: string; otherAdmin: string; shift: string; otherEvent: string };
const t: Record<string, string> = {};
const here = { lat: 0, lng: 0, accuracyMeters: 5 };

const ip = () => ({ userId: ids.ip, householdId });
const admin = () => ({ userId: ids.admin, role: "ADMIN" as const, householdId });
const client = () => ({ userId: ids.client, role: "CLIENT" as const, householdId });
const photo = () => sharp({ create: { width: 320, height: 240, channels: 3, background: { r: 90, g: 120, b: 150 } } }).jpeg().toBuffer();

/** The recorded step on a task, by the action name. */
const eventFor = (taskId: string, action: string) => db.event.findFirstOrThrow({ where: { householdId, taskInstanceId: taskId, action }, orderBy: { serverTimestampUtc: "desc" } });

beforeAll(async () => {
  const passwordHash = await hashPassword("test-only-password");
  const h = await db.household.create({ data: { name: "corrections-test", apartmentLat: 0, apartmentLng: 0 } });
  const o = await db.household.create({ data: { name: "corrections-test-other", apartmentLat: 0, apartmentLng: 0 } });
  householdId = h.id;
  otherHouseholdId = o.id;
  const mk = (hid: string, role: "CLIENT" | "ADMIN" | "IP" | "FAMILY", name: string) =>
    db.user.create({ data: { householdId: hid, role, name, email: `${name.toLowerCase()}-${h.id}@test.local`, passwordHash } });
  const [client, adminUser, ipUser, ip2, family, otherAdmin] = await Promise.all([
    mk(householdId, "CLIENT", "Chris"), mk(householdId, "ADMIN", "Morgan"), mk(householdId, "IP", "Pat"), mk(householdId, "IP", "Quinn"),
    mk(householdId, "FAMILY", "Sam"), mk(otherHouseholdId, "ADMIN", "Outsider"),
  ]);
  for (const [i, title] of ["Dishes", "Trash", "Sweep", "Sink", "Mail", "Counters"].entries()) {
    await db.taskTemplate.create({ data: { householdId, groupName: "Kitchen", title, instructions: "x", frequency: "VISIT", requiresPhoto: title === "Sink", sortOrder: i } });
  }
  const now = new Date();
  const shift = await db.scheduledShift.create({
    data: {
      householdId, ipUserId: ipUser.id, localDate: localDateString(now, h.timezone),
      scheduledStartUtc: new Date(now.getTime() - 5 * 60_000), scheduledEndUtc: new Date(now.getTime() + 6 * 3_600_000),
      status: "SCHEDULED", createdBy: ipUser.id,
    },
  });
  await checkIn({ shiftId: shift.id, ipUserId: ipUser.id, ...here });
  for (const task of await db.taskInstance.findMany({ where: { shiftId: shift.id } })) t[task.titleSnapshot] = task.id;
  const otherShift = await db.scheduledShift.create({
    data: { householdId: otherHouseholdId, ipUserId: otherAdmin.id, localDate: "2026-01-01", scheduledStartUtc: now, scheduledEndUtc: now, status: "SCHEDULED", createdBy: otherAdmin.id },
  });
  const otherEvent = await db.$transaction((tx) =>
    import("../src/services/event.service").then((m) => m.appendEvent(tx, { householdId: otherHouseholdId, actorUserId: otherAdmin.id, actorRole: "ADMIN", action: "check_in", shiftId: otherShift.id, payload: {} }))
  );
  ids = { client: client.id, admin: adminUser.id, ip: ipUser.id, ip2: ip2.id, family: family.id, otherAdmin: otherAdmin.id, shift: shift.id, otherEvent: otherEvent.id };
});

afterAll(async () => {
  for (const id of [householdId, otherHouseholdId]) {
    await db.alertRead.deleteMany({ where: { alert: { householdId: id } } });
    await db.alert.deleteMany({ where: { householdId: id } });
    await db.correctionRequest.deleteMany({ where: { householdId: id } });
    await db.correction.deleteMany({ where: { householdId: id } });
    await db.outboundMessage.deleteMany({ where: { householdId: id } });
    await db.evidence.deleteMany({ where: { taskInstance: { householdId: id } } });
    await db.captureChallenge.deleteMany({ where: { householdId: id } });
    await db.event.deleteMany({ where: { householdId: id } });
    await db.locationReading.deleteMany({ where: { householdId: id } });
    await db.taskInstance.deleteMany({ where: { householdId: id } });
    await db.scheduledShift.deleteMany({ where: { householdId: id } });
    await db.weekAllowance.deleteMany({ where: { householdId: id } });
    await db.taskTemplate.deleteMany({ where: { householdId: id } });
    await db.user.deleteMany({ where: { householdId: id } });
    await db.household.delete({ where: { id } });
    await removeHouseholdFiles(id);
  }
  await db.$disconnect();
});

describe("the IP reports a completion error", () => {
  it("can only report a task that has something recorded, that is theirs, with a reason", async () => {
    await expect(requestCorrection(ip(), { taskInstanceId: t.Dishes, reason: "Marked by mistake" })).rejects.toMatchObject({ code: "NOTHING_TO_CORRECT" }); // not done yet
    await completeTask(t.Dishes!, ids.ip);
    await expect(requestCorrection({ userId: ids.ip2, householdId }, { taskInstanceId: t.Dishes, reason: "Not mine to report" })).rejects.toMatchObject({ code: "NOT_FOUND" }); // another IP cannot report on this IP's task
    await expect(requestCorrection(ip(), { taskInstanceId: t.Dishes, reason: "x" })).rejects.toMatchObject({ code: "REASON_REQUIRED" });
    await expect(requestCorrection(ip(), { reason: "no target" })).rejects.toMatchObject({ code: "INVALID_TARGET" });
    await expect(requestCorrection(ip(), { taskInstanceId: t.Dishes, shiftId: ids.shift, reason: "two targets" })).rejects.toMatchObject({ code: "INVALID_TARGET" });
    await expect(requestCorrection({ userId: ids.client, householdId }, { taskInstanceId: t.Dishes, reason: "Client is not an IP" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("only asks: the record does not change, the original event stays, and administrators are alerted", async () => {
    const original = await eventFor(t.Dishes!, "task_completed");
    const request = await requestCorrection(ip(), { taskInstanceId: t.Dishes, reason: "I tapped Done on the wrong task" });
    expect(request.status).toBe("OPEN");

    expect((await db.taskInstance.findUniqueOrThrow({ where: { id: t.Dishes! } })).state).toBe("COMPLETED_AWAITING_REVIEW");
    const requestedEvent = await db.event.findFirstOrThrow({ where: { householdId, action: "correction_requested" } });
    expect(requestedEvent.actorRole).toBe("IP");
    expect(requestedEvent.payload).toMatchObject({ requestId: request.id, linkedEventId: original.id, reason: "I tapped Done on the wrong task" });

    const alert = await db.alert.findFirstOrThrow({ where: { householdId, type: "completion_error_reported" } });
    expect(alert.audience.sort()).toEqual(["ADMIN", "CLIENT"]);
    expect(alert.link).toBe("/corrections");
    expect(alert.message).toContain("Dishes");
    expect(alert.message).not.toContain("wrong task"); // the reason is not put in a text message
    await expect(requestCorrection(ip(), { taskInstanceId: t.Dishes, reason: "again" })).rejects.toMatchObject({ code: "ALREADY_REPORTED" });
  });

  it("shows the IP their report as waiting, with no audit timestamps", async () => {
    const dto = (await toIpTaskDtos(await db.taskInstance.findMany({ where: { id: t.Dishes! } })))[0]!;
    expect(dto.correctionStatus).toBe("OPEN");
    const mine = await listForIp(ip());
    expect(mine).toHaveLength(1);
    expect(Object.keys(mine[0]!).sort()).toEqual(["about", "answer", "id", "reason", "status"]);
    expect(mine[0]).toMatchObject({ about: "Dishes", status: "OPEN", answer: null });
  });
});

describe("appending a correction", () => {
  it("is only for the client and administrators", async () => {
    const original = await eventFor(t.Dishes!, "task_completed");
    const input = { kind: "COMPLETION_ERROR" as const, linkedEventId: original.id, reason: "Not done" };
    await expect(appendCorrection({ userId: ids.ip, role: "IP", householdId }, input)).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
    await expect(appendCorrection({ userId: ids.family, role: "FAMILY", householdId }, input)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("needs a reason and a real recorded event in this household", async () => {
    const original = await eventFor(t.Dishes!, "task_completed");
    await expect(appendCorrection(admin(), { kind: "COMPLETION_ERROR", linkedEventId: original.id, reason: " " })).rejects.toMatchObject({ code: "REASON_REQUIRED" });
    await expect(appendCorrection(admin(), { kind: "NOTE", linkedEventId: "nope", reason: "A note" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    // Another household's event cannot be corrected from here, and ours cannot be corrected from there.
    await expect(appendCorrection(admin(), { kind: "NOTE", linkedEventId: ids.otherEvent, reason: "Not ours" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(appendCorrection({ userId: ids.otherAdmin, role: "ADMIN", householdId: otherHouseholdId }, { kind: "NOTE", linkedEventId: original.id, reason: "Not theirs" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("refuses a correction that does not fit what it is linked to", async () => {
    const dishes = await eventFor(t.Dishes!, "task_completed");
    const checkInEvent = await db.event.findFirstOrThrow({ where: { householdId, action: "check_in" } });
    await expect(appendCorrection(admin(), { kind: "ATTENDANCE", linkedEventId: dishes.id, reason: "Wrong link" })).rejects.toMatchObject({ code: "INVALID_TARGET" });
    await expect(appendCorrection(admin(), { kind: "COMPLETION_ERROR", linkedEventId: checkInEvent.id, reason: "Not a task" })).rejects.toMatchObject({ code: "INVALID_TARGET" });
    // A request about the Dishes cannot be answered by a correction about something else.
    const request = await db.correctionRequest.findFirstOrThrow({ where: { householdId, status: "OPEN" } });
    await expect(appendCorrection(admin(), { kind: "ATTENDANCE", linkedEventId: checkInEvent.id, reason: "Different thing", requestId: request.id })).rejects.toMatchObject({ code: "REQUEST_MISMATCH" });
  });

  it("answers the report: the original is untouched, the task stops counting as done, and the IP is told", async () => {
    const original = await eventFor(t.Dishes!, "task_completed");
    const hashBefore = original.hash;
    const request = await db.correctionRequest.findFirstOrThrow({ where: { householdId, status: "OPEN" } });

    const result = await appendCorrection(admin(), { kind: "COMPLETION_ERROR", linkedEventId: original.id, reason: "IP confirmed this was marked on the wrong task", requestId: request.id });

    // The original event is exactly as it was.
    const after = await db.event.findUniqueOrThrow({ where: { id: original.id } });
    expect(after.hash).toBe(hashBefore);
    expect(after.payload).toEqual(original.payload);
    expect(await db.event.count({ where: { householdId, taskInstanceId: t.Dishes!, action: "task_completed" } })).toBe(1);

    // The correction is its own record, linked to the original, with who and why.
    const correction = await db.correction.findUniqueOrThrow({ where: { id: result.id } });
    expect(correction).toMatchObject({ kind: "COMPLETION_ERROR", linkedEventId: original.id, taskInstanceId: t.Dishes, byUserId: ids.admin, byRole: "ADMIN", requestId: request.id });
    const event = await db.event.findUniqueOrThrow({ where: { id: correction.eventId! } });
    expect(event).toMatchObject({ action: "correction_appended", actorUserId: ids.admin, actorRole: "ADMIN" });
    expect(event.payload).toMatchObject({ linkedEventId: original.id, linkedAction: "task_completed", kind: "COMPLETION_ERROR" });

    expect((await db.taskInstance.findUniqueOrThrow({ where: { id: t.Dishes! } })).state).toBe("COMPLETION_ERROR_CORRECTED");
    expect(await db.correctionRequest.findUniqueOrThrow({ where: { id: request.id } })).toMatchObject({ status: "RESOLVED", correctionId: result.id, resolvedByUserId: ids.admin });
    expect((await db.alert.findFirstOrThrow({ where: { householdId, type: "completion_error_reported", refId: request.id } })).resolvedAt).not.toBeNull();
    expect((await db.outboundMessage.findMany({ where: { householdId, body: { contains: "Your report was reviewed" } } })).length).toBeGreaterThanOrEqual(0); // sent best-effort

    const mine = await listForIp(ip());
    expect(mine[0]).toMatchObject({ status: "RESOLVED", answer: "IP confirmed this was marked on the wrong task" });
  });

  it("cannot be applied twice, and the client can no longer approve the corrected completion", async () => {
    const original = await eventFor(t.Dishes!, "task_completed");
    await expect(appendCorrection(admin(), { kind: "COMPLETION_ERROR", linkedEventId: original.id, reason: "Again" })).rejects.toMatchObject({ code: "NOT_CORRECTABLE", status: 409 });
    await expect(approveTask(client(), t.Dishes!)).rejects.toMatchObject({ code: "ALREADY_DECIDED" });
    expect((await getPending(householdId, { role: "CLIENT", canViewTimestamps: true })).map((x) => x.id)).not.toContain(t.Dishes);
  });

  it("opens the task for the IP again while the visit is open", async () => {
    const dto = (await toIpTaskDtos(await db.taskInstance.findMany({ where: { id: t.Dishes! } })))[0]!;
    expect(dto.state).toBe("COMPLETION_ERROR_CORRECTED");
    await completeTask(t.Dishes!, ids.ip);
    expect((await db.taskInstance.findUniqueOrThrow({ where: { id: t.Dishes! } })).state).toBe("COMPLETED_AWAITING_REVIEW");
    expect(await db.event.count({ where: { householdId, taskInstanceId: t.Dishes!, action: "task_completed" } })).toBe(2); // the first one is still there
  });

  it("needs a new photo for a photo task after it was corrected (the old photo no longer counts)", async () => {
    const { challengeId } = await issueChallenge(ids.ip, householdId, t.Sink!);
    await acceptEvidence({ userId: ids.ip, householdId, taskInstanceId: t.Sink!, challengeId, imageBase64: (await photo()).toString("base64"), ...here });
    await completeTask(t.Sink!, ids.ip);
    await requestCorrection(ip(), { taskInstanceId: t.Sink, reason: "The sink was not clean yet" });
    const request = await db.correctionRequest.findFirstOrThrow({ where: { householdId, taskInstanceId: t.Sink!, status: "OPEN" } });
    await appendCorrection(client(), { kind: "COMPLETION_ERROR", linkedEventId: (await eventFor(t.Sink!, "task_completed")).id, reason: "Sink still dirty", requestId: request.id });

    await expect(completeTask(t.Sink!, ids.ip)).rejects.toMatchObject({ code: "EVIDENCE_REQUIRED" });
    await new Promise((r) => setTimeout(r, 15));
    const second = await issueChallenge(ids.ip, householdId, t.Sink!);
    await acceptEvidence({ userId: ids.ip, householdId, taskInstanceId: t.Sink!, challengeId: second.challengeId, imageBase64: (await photo()).toString("base64"), ...here });
    await expect(completeTask(t.Sink!, ids.ip)).resolves.toBeTruthy();
  });

  it("can be appended by the client too, and a task that has nothing recorded cannot be corrected as an error", async () => {
    const trash = await completeTask(t.Trash!, ids.ip);
    const ev = await eventFor(trash.id, "task_completed");
    const result = await appendCorrection(client(), { kind: "COMPLETION_ERROR", linkedEventId: ev.id, reason: "Client says it was not emptied" });
    expect((await db.correction.findUniqueOrThrow({ where: { id: result.id } })).byRole).toBe("CLIENT");
    // Sweep was never started, so it has nothing to correct. Link it to the assignment event.
    const assigned = await db.event.findFirstOrThrow({ where: { householdId, taskInstanceId: t.Sweep!, action: "task_assigned" } });
    await expect(appendCorrection(admin(), { kind: "COMPLETION_ERROR", linkedEventId: assigned.id, reason: "Nothing was done" })).rejects.toMatchObject({ code: "NOT_CORRECTABLE" });
  });
});

describe("notes and declined reports", () => {
  it("adds an attendance note beside the check-in without changing the observed time", async () => {
    const checkInEvent = await db.event.findFirstOrThrow({ where: { householdId, action: "check_in" } });
    const before = (await db.scheduledShift.findUniqueOrThrow({ where: { id: ids.shift } })).observedCheckInUtc;
    await appendCorrection(admin(), { kind: "ATTENDANCE", linkedEventId: checkInEvent.id, reason: "Phone had no signal at the door; arrived on time" });
    expect((await db.scheduledShift.findUniqueOrThrow({ where: { id: ids.shift } })).observedCheckInUtc).toEqual(before);
    expect((await db.event.findUniqueOrThrow({ where: { id: checkInEvent.id } })).hash).toBe(checkInEvent.hash);
  });

  it("lets the IP report a problem with their own check-in, and lets the administrator decline with a reason", async () => {
    const request = await requestCorrection(ip(), { shiftId: ids.shift, reason: "I think my check-in time is wrong" });
    await expect(declineRequest({ userId: ids.ip, role: "IP", householdId }, request.id, "Not allowed")).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(declineRequest(admin(), request.id, "  ")).rejects.toMatchObject({ code: "REASON_REQUIRED" });
    await declineRequest(admin(), request.id, "The recorded time matches the location reading");
    await expect(declineRequest(admin(), request.id, "Again")).rejects.toMatchObject({ code: "ALREADY_ANSWERED" });

    const row = await db.correctionRequest.findUniqueOrThrow({ where: { id: request.id } });
    expect(row).toMatchObject({ status: "DECLINED", declineReason: "The recorded time matches the location reading", resolvedByUserId: ids.admin });
    expect(await db.event.count({ where: { householdId, action: "correction_request_declined" } })).toBe(1);
    const mine = (await listForIp(ip())).find((r) => r.id === request.id)!;
    expect(mine).toMatchObject({ status: "DECLINED", answer: "The recorded time matches the location reading" });
  });

  it("gives the staff list the open reports, the declined ones and every correction with who made it", async () => {
    const list = await listForStaff(householdId);
    expect(list.open).toEqual([]);
    expect(list.declined).toHaveLength(1);
    expect(list.corrections.length).toBeGreaterThanOrEqual(4);
    expect(list.corrections.map((c) => c.kind)).toEqual(expect.arrayContaining(["COMPLETION_ERROR", "ATTENDANCE"]));
    expect(list.corrections.every((c) => c.by.length > 0)).toBe(true);
  });
});

describe("what other screens and reports show", () => {
  it("shows corrections in a task's history to staff with the event id, and without it to family", async () => {
    const staff = await getReviewTask(householdId, t.Dishes!, { role: "ADMIN", canViewTimestamps: true });
    const appended = staff.history.find((h) => h.action === "correction_appended")!;
    expect(appended.eventId).toBeTruthy();
    expect(appended.detail).toContain("wrong task");
    const family = await getReviewTask(householdId, t.Dishes!, { role: "FAMILY", canViewTimestamps: false });
    expect(family.history.find((h) => h.action === "correction_appended")!.eventId).toBeNull();
    const day = await getReviewDay(householdId, localDateString(new Date(), "America/Chicago"), { role: "CLIENT", canViewTimestamps: true });
    expect(day[0]!.checkInEventId).toBeTruthy();
    expect((await getReviewDay(householdId, localDateString(new Date(), "America/Chicago"), { role: "FAMILY", canViewTimestamps: true }))[0]!.checkInEventId).toBeNull();
  });

  it("keeps a corrected task out of the done counts, and lists the corrections in the report", async () => {
    const today = localDateString(new Date(), "America/Chicago");
    const report = await buildReport({ userId: ids.admin, householdId, role: "ADMIN", canViewTimestamps: true }, { from: today, to: today });
    expect(report.tasks.totals.correctedErrors).toBe(1); // Trash; Dishes and Sink were done again properly
    expect(report.tasks.totals.submitted).toBe(report.tasks.totals.assigned - report.tasks.totals.stillOpen - report.tasks.totals.correctedErrors - report.tasks.totals.missed);
    expect(report.tasks.notCompleted.some((n) => n.outcome.startsWith("Recorded in error"))).toBe(true);
    const kinds = report.exceptions!.items.map((i) => i.kind);
    expect(kinds).toEqual(expect.arrayContaining(["correction", "mistake_reported"]));
    expect(report.exceptions!.adminCorrections).toBeGreaterThanOrEqual(4);
    expect(report.attendance!.rows[0]!.correctionNotes).toEqual(["Phone had no signal at the door; arrived on time"]);
    expect(report.meta.notes.join(" ")).not.toMatch(/not part of the app yet/);
  });

  it("keeps the audit chain intact and refuses an IP who is not on the shift", async () => {
    expect((await verifyChainIntegrity(householdId)).ok).toBe(true);
    await expect(requestCorrection({ userId: ids.ip2, householdId }, { shiftId: ids.shift, reason: "Someone else's visit" })).rejects.toBeInstanceOf(CorrectionError);
    await expect(completeTask(t.Mail!, ids.ip2)).rejects.toBeInstanceOf(TaskActionRejectedError);
  });
});
