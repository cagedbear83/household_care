import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../src/db";
import { hashPassword } from "../src/auth/password";
import { appendEvent, verifyChainIntegrity } from "../src/services/event.service";
import * as retention from "../src/services/retention";

const YEAR = 365.25 * 86_400_000;
let householdId: string;
let otherHouseholdId: string;
let disputedTaskId: string;

const inYears = (n: number) => new Date(Date.now() + n * YEAR);
const record = (extra: { taskInstanceId?: string } = {}) =>
  db.$transaction((tx) => appendEvent(tx, { householdId, actorUserId: null, actorRole: "ADMIN", action: "test_event", payload: {}, ...extra }));

beforeAll(async () => {
  const h = await db.household.create({ data: { name: "retention-test", apartmentLat: 0, apartmentLng: 0 } });
  const o = await db.household.create({ data: { name: "retention-test-other", apartmentLat: 0, apartmentLng: 0 } });
  householdId = h.id;
  otherHouseholdId = o.id;
  const passwordHash = await hashPassword("test-only-password");
  const ip = await db.user.create({ data: { householdId, role: "IP", name: "Pat", email: `pat-${h.id}@test.local`, passwordHash } });
  const template = await db.taskTemplate.create({ data: { householdId, groupName: "Kitchen", title: "Dishes", instructions: "x", frequency: "VISIT", sortOrder: 0 } });
  const now = new Date();
  const shift = await db.scheduledShift.create({
    data: { householdId, ipUserId: ip.id, localDate: "2026-10-03", scheduledStartUtc: now, scheduledEndUtc: new Date(now.getTime() + 3_600_000), status: "SCHEDULED", createdBy: ip.id },
  });
  const disputed = await db.taskInstance.create({
    data: { householdId, shiftId: shift.id, templateId: template.id, assignedDate: "2026-10-03", titleSnapshot: "Dishes", instructionsSnapshot: "x", requiresPhotoSnapshot: false, state: "DISPUTED" },
  });
  disputedTaskId = disputed.id;
  await record();
  await record();
  await record();
  await record({ taskInstanceId: disputedTaskId }); // tied to a dispute that is still open
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

describe("the fixed ten-year rule", () => {
  it("is ten years", () => {
    expect(retention.RETENTION_YEARS).toBe(10);
  });

  it("protects a record until the same moment ten calendar years later", () => {
    expect(retention.retainUntil(new Date("2026-10-04T12:30:00.000Z")).toISOString()).toBe("2036-10-04T12:30:00.000Z");
    // A leap day lands on the last day of February, never in March.
    expect(retention.retainUntil(new Date("2024-02-29T08:00:00.000Z")).toISOString()).toBe("2034-02-28T08:00:00.000Z");
  });

  it("is past retention only once the ten years are over", () => {
    const recorded = new Date("2026-10-04T12:30:00.000Z");
    expect(retention.isPastRetention(recorded, new Date("2036-10-04T12:29:59.999Z"))).toBe(false);
    expect(retention.isPastRetention(recorded, new Date("2036-10-04T12:30:00.000Z"))).toBe(true);
    expect(retention.isPastRetention(recorded, new Date("2030-01-01T00:00:00.000Z"))).toBe(false);
  });

  it("cannot be changed: the module only offers the rule and a read-only count", async () => {
    // If someone adds a way to change the period, this fails and has to be discussed first.
    expect(Object.keys(retention).sort()).toEqual(["RETENTION_YEARS", "archiveCandidates", "isPastRetention", "retainUntil"]);
    const household = await db.household.findUniqueOrThrow({ where: { id: householdId } });
    expect(Object.keys(household)).not.toContain("retentionDays");
  });
});

describe("what could be archived", () => {
  it("is nothing while every record is inside the ten years", async () => {
    expect(await retention.archiveCandidates(householdId, inYears(9.9))).toEqual({ pastRetention: 0, keptForOpenDispute: 0, eligible: 0 });
    expect(await retention.archiveCandidates(householdId)).toEqual({ pastRetention: 0, keptForOpenDispute: 0, eligible: 0 });
  });

  it("counts records past ten years, and always keeps the ones tied to a dispute that is still open", async () => {
    const result = await retention.archiveCandidates(householdId, inYears(10.1));
    expect(result).toEqual({ pastRetention: 4, keptForOpenDispute: 1, eligible: 3 });
  });

  it("frees those records once the dispute is resolved", async () => {
    await db.taskInstance.update({ where: { id: disputedTaskId }, data: { state: "APPROVED" } });
    expect(await retention.archiveCandidates(householdId, inYears(10.1))).toEqual({ pastRetention: 4, keptForOpenDispute: 0, eligible: 4 });
    await db.taskInstance.update({ where: { id: disputedTaskId }, data: { state: "DISPUTED" } });
  });

  it("only looks at its own household, never deletes, and leaves the audit chain intact", async () => {
    expect(await retention.archiveCandidates(otherHouseholdId, inYears(20))).toEqual({ pastRetention: 0, keptForOpenDispute: 0, eligible: 0 });
    await retention.archiveCandidates(householdId, inYears(20));
    expect(await db.event.count({ where: { householdId } })).toBe(4);
    expect((await verifyChainIntegrity(householdId)).ok).toBe(true);
  });
});
