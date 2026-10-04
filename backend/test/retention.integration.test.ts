import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../src/db";
import { hashPassword } from "../src/auth/password";
import { appendEvent, verifyChainIntegrity } from "../src/services/event.service";
import { getRetentionStatus, placeHold, releaseHold, retainUntil, RetentionError, setRetentionPolicy, RECOMMENDED_DAYS } from "../src/services/retention.service";

const PASSWORD = "retention-test-password";
const DAY = 86_400_000;
let householdId: string;
let otherHouseholdId: string;
let ids: { admin: string; client: string; ip: string; family: string; otherAdmin: string; disputedTask: string };

const admin = () => ({ userId: ids.admin, role: "ADMIN" as const, householdId });
const client = () => ({ userId: ids.client, role: "CLIENT" as const, householdId });
const inDays = (n: number) => new Date(Date.now() + n * DAY);
const status = (days = 0) => getRetentionStatus(householdId, inDays(days));

async function recordEvent(extra: { taskInstanceId?: string } = {}) {
  return db.$transaction((tx) => appendEvent(tx, { householdId, actorUserId: ids.admin, actorRole: "ADMIN", action: "test_event", payload: {}, ...extra }));
}

beforeAll(async () => {
  const passwordHash = await hashPassword(PASSWORD);
  const h = await db.household.create({ data: { name: "retention-test", apartmentLat: 0, apartmentLng: 0 } });
  const o = await db.household.create({ data: { name: "retention-test-other", apartmentLat: 0, apartmentLng: 0 } });
  householdId = h.id;
  otherHouseholdId = o.id;
  const mk = (hid: string, role: "CLIENT" | "ADMIN" | "IP" | "FAMILY", name: string) =>
    db.user.create({ data: { householdId: hid, role, name, email: `${name.toLowerCase()}-${h.id}@test.local`, passwordHash } });
  const [adminUser, clientUser, ip, family, otherAdmin] = await Promise.all([
    mk(householdId, "ADMIN", "Morgan"), mk(householdId, "CLIENT", "Chris"), mk(householdId, "IP", "Pat"), mk(householdId, "FAMILY", "Sam"), mk(otherHouseholdId, "ADMIN", "Outsider"),
  ]);
  const template = await db.taskTemplate.create({ data: { householdId, groupName: "Kitchen", title: "Dishes", instructions: "x", frequency: "VISIT", sortOrder: 0 } });
  const now = new Date();
  const shift = await db.scheduledShift.create({
    data: { householdId, ipUserId: ip.id, localDate: "2026-10-03", scheduledStartUtc: now, scheduledEndUtc: new Date(now.getTime() + 3_600_000), status: "SCHEDULED", createdBy: ip.id },
  });
  const disputed = await db.taskInstance.create({
    data: { householdId, shiftId: shift.id, templateId: template.id, assignedDate: "2026-10-03", titleSnapshot: "Dishes", instructionsSnapshot: "x", requiresPhotoSnapshot: false, state: "DISPUTED" },
  });
  ids = { admin: adminUser.id, client: clientUser.id, ip: ip.id, family: family.id, otherAdmin: otherAdmin.id, disputedTask: disputed.id };
  await recordEvent(); // three ordinary records
  await recordEvent();
  await recordEvent();
  await recordEvent({ taskInstanceId: disputed.id }); // one tied to a dispute that is still open
});

afterAll(async () => {
  for (const id of [householdId, otherHouseholdId]) {
    await db.outboundMessage.deleteMany({ where: { householdId: id } });
    await db.retentionHold.deleteMany({ where: { householdId: id } });
    await db.retentionPolicy.deleteMany({ where: { householdId: id } });
    await db.event.deleteMany({ where: { householdId: id } });
    await db.taskInstance.deleteMany({ where: { householdId: id } });
    await db.scheduledShift.deleteMany({ where: { householdId: id } });
    await db.taskTemplate.deleteMany({ where: { householdId: id } });
    await db.user.deleteMany({ where: { householdId: id } });
    await db.household.delete({ where: { id } });
  }
  await db.$disconnect();
});

describe("before anyone chooses", () => {
  it("shows the two-year recommendation as not yet confirmed, with nothing past its period", async () => {
    const s = await status();
    expect(s.policy).toMatchObject({ days: RECOMMENDED_DAYS, confirmed: false, recommendedDays: 730, minDays: 365, reducedFrom: null });
    expect(s.history).toHaveLength(1);
    expect(s.records.events).toBe(4);
    expect(s.records.pastRetention.events).toBe(0);
    expect(s.records.unresolvedDisputes).toBe(1);
    expect(s.notes.join(" ")).toMatch(/never deletes/);
  });

  it("counts records as past their period only once the full period has gone by, and keeps the disputed one back", async () => {
    const early = await status(729);
    expect(early.records.pastRetention.events).toBe(0);
    const late = await status(731);
    expect(late.records.pastRetention.events).toBe(4);
    expect(late.records.reviewable.events).toBe(3); // the one tied to the open dispute is kept
    expect(late.records.heldBack.events).toBe(1);
    expect(late.records.earliestExpiry).not.toBeNull();
  });
});

describe("choosing the period", () => {
  it("is only for the client and administrators, needs the password, and a period in range", async () => {
    await expect(setRetentionPolicy({ userId: ids.ip, role: "IP", householdId }, { days: 730, password: PASSWORD })).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
    await expect(setRetentionPolicy({ userId: ids.family, role: "FAMILY", householdId }, { days: 730, password: PASSWORD })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(setRetentionPolicy(admin(), { days: 730, password: "wrong" })).rejects.toMatchObject({ code: "REAUTH_FAILED", status: 403 });
    await expect(setRetentionPolicy(admin(), { days: 730, password: "" })).rejects.toMatchObject({ code: "REAUTH_FAILED" });
    await expect(setRetentionPolicy(admin(), { days: 100, password: PASSWORD })).rejects.toMatchObject({ code: "INVALID_DAYS" });
    await expect(setRetentionPolicy(admin(), { days: 20_000, password: PASSWORD })).rejects.toMatchObject({ code: "INVALID_DAYS" });
    await expect(setRetentionPolicy(admin(), { days: 730.5, password: PASSWORD })).rejects.toMatchObject({ code: "INVALID_DAYS" });
    expect(await db.retentionPolicy.count({ where: { householdId } })).toBe(0);
  });

  it("confirms the recommendation itself, recording who and when", async () => {
    const s = await setRetentionPolicy(client(), { days: 730, password: PASSWORD });
    expect(s.policy).toMatchObject({ days: 730, confirmed: true, setBy: "Chris", reducedFrom: null });
    const event = await db.event.findFirstOrThrow({ where: { householdId, action: "retention_policy_changed" }, orderBy: { serverTimestampUtc: "desc" } });
    expect(event.payload).toMatchObject({ from: 730, to: 730, reduced: false, confirmedFirstTime: true });
    await expect(setRetentionPolicy(client(), { days: 730, password: PASSWORD })).rejects.toMatchObject({ code: "UNCHANGED", status: 409 });
  });

  it("needs a reason to shorten it, and then keeps already-protected records protected for the longer period", async () => {
    await expect(setRetentionPolicy(admin(), { days: 365, password: PASSWORD })).rejects.toMatchObject({ code: "REASON_REQUIRED" });
    const s = await setRetentionPolicy(admin(), { days: 365, reason: "Program guidance says one year", password: PASSWORD });
    expect(s.policy).toMatchObject({ days: 365, reducedFrom: 730, setBy: "Morgan" });
    expect((await db.household.findUniqueOrThrow({ where: { id: householdId } })).retentionDays).toBe(365);
    expect(s.history.map((h) => h.retentionDays)).toEqual([365, 730, 730]);

    // Everything recorded before the shortening is still protected for two years. (The one record the
    // shortening itself created is in the new, shorter period, so it is the only one past a year.)
    expect((await status(400)).records.pastRetention.events).toBe(1);
    expect((await status(729)).records.pastRetention.events).toBe(1); // still only that one: the older ones are held to two years
    expect((await status(731)).records.pastRetention.events).toBeGreaterThanOrEqual(4);

    const event = await db.event.findFirstOrThrow({ where: { householdId, action: "retention_policy_changed" }, orderBy: { serverTimestampUtc: "desc" } });
    expect(event.payload).toMatchObject({ from: 730, to: 365, reduced: true, reason: "Program guidance says one year", existingRecordsKeepLongerProtection: true });
  });

  it("protects newly recorded records only for the shorter period that is now in force", async () => {
    const before = (await status(400)).records.pastRetention.events;
    await new Promise((r) => setTimeout(r, 15));
    await recordEvent();
    await recordEvent();
    const after = await status(400);
    expect(after.records.pastRetention.events).toBeGreaterThan(before); // the new ones expire at one year, the old ones at two
    expect(after.records.pastRetention.events - before).toBeGreaterThanOrEqual(2);
    const recorded = new Date();
    const until = await retainUntil(householdId, recorded);
    expect(Math.round((until.getTime() - recorded.getTime()) / DAY)).toBe(365);
  });

  it("lengthening it extends protection for everything already recorded", async () => {
    const s = await setRetentionPolicy(admin(), { days: 1095, password: PASSWORD });
    expect(s.policy.days).toBe(1095);
    expect(s.policy.reducedFrom).toBeNull();
    expect((await status(800)).records.pastRetention.events).toBe(0); // all now protected for three years
    expect((await status(1100)).records.pastRetention.events).toBeGreaterThan(0);
    expect(Math.round(((await retainUntil(householdId, new Date(Date.now() - 1000 * DAY))).getTime() - (Date.now() - 1000 * DAY)) / DAY)).toBe(1095);
  });
});

describe("preservation holds", () => {
  it("needs the password, a reason and sensible dates", async () => {
    await expect(placeHold(admin(), { reason: "Program review", password: "wrong" })).rejects.toMatchObject({ code: "REAUTH_FAILED" });
    await expect(placeHold(admin(), { reason: " ", password: PASSWORD })).rejects.toMatchObject({ code: "REASON_REQUIRED" });
    await expect(placeHold(admin(), { reason: "Review", fromDate: "2026-13-01", password: PASSWORD })).rejects.toMatchObject({ code: "INVALID_DATE" });
    await expect(placeHold(admin(), { reason: "Review", fromDate: "2026-10-05", toDate: "2026-10-01", password: PASSWORD })).rejects.toMatchObject({ code: "INVALID_DATE" });
    await expect(placeHold({ userId: ids.ip, role: "IP", householdId }, { reason: "Review", password: PASSWORD })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("keeps records past their period while it is active, and stops once released", async () => {
    // Back to a one-year rule so records are past their period well within the test.
    await setRetentionPolicy(client(), { days: 365, reason: "Test: shorter period", password: PASSWORD });
    const farOut = 1100; // past even the longest protection recorded earlier
    const open = await status(farOut);
    expect(open.records.reviewable.events).toBeGreaterThan(0);

    const placed = await placeHold(admin(), { reason: "Program review of October 2026", password: PASSWORD });
    const hold = placed.holds.find((h) => h.active)!;
    expect(hold).toMatchObject({ reason: "Program review of October 2026", placedBy: "Morgan", fromDate: null, toDate: null });
    const held = await status(farOut);
    expect(held.records.reviewable.events).toBe(0); // a hold with no dates covers everything
    expect(held.records.heldBack.events).toBe(held.records.pastRetention.events);

    const event = await db.event.findFirstOrThrow({ where: { householdId, action: "retention_hold_placed" } });
    expect(event.payload).toMatchObject({ holdId: hold.id, reason: "Program review of October 2026" });

    await expect(releaseHold(admin(), hold.id, { reason: "Review finished", password: "wrong" })).rejects.toMatchObject({ code: "REAUTH_FAILED" });
    await expect(releaseHold(admin(), "missing", { reason: "Review finished", password: PASSWORD })).rejects.toMatchObject({ code: "NOT_FOUND" });
    const released = await releaseHold(client(), hold.id, { reason: "Review finished", password: PASSWORD });
    expect(released.holds.find((h) => h.id === hold.id)).toMatchObject({ active: false, releasedBy: "Chris", releaseReason: "Review finished" });
    expect((await status(farOut)).records.reviewable.events).toBeGreaterThan(0);
    await expect(releaseHold(client(), hold.id, { reason: "Again", password: PASSWORD })).rejects.toMatchObject({ code: "ALREADY_RELEASED", status: 409 });
  });

  it("can cover just a range of dates", async () => {
    const placed = await placeHold(admin(), { reason: "Dispute on 2020 records", fromDate: "2020-01-01", toDate: "2020-12-31", password: PASSWORD });
    expect(placed.holds.find((h) => h.active)).toMatchObject({ fromDate: "2020-01-01", toDate: "2020-12-31" });
    // None of this household's records are from 2020, so nothing extra is held back.
    const s = await status(1100);
    expect(s.records.heldBack.events).toBe(1); // only the one tied to the open dispute
  });
});

describe("safety", () => {
  it("never deletes anything and keeps the audit chain intact", async () => {
    expect(await db.event.count({ where: { householdId } })).toBeGreaterThanOrEqual(10);
    expect((await verifyChainIntegrity(householdId)).ok).toBe(true);
  });

  it("is household-scoped", async () => {
    const other = await getRetentionStatus(otherHouseholdId);
    expect(other.records.events).toBe(0);
    expect(other.policy.confirmed).toBe(false);
    await expect(setRetentionPolicy({ userId: ids.otherAdmin, role: "ADMIN", householdId: otherHouseholdId }, { days: 365, password: PASSWORD })).rejects.toBeInstanceOf(RetentionError);
  });
});
