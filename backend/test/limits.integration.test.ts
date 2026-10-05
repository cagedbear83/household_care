import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../src/db";
import { hashPassword } from "../src/auth/password";
import { checkIn, checkOut, LONG_DAY_WARN_MINUTES, rollingObservedMinutes } from "../src/services/authorization.service";
import { createRecurringRule, createShift, generateFromRules, MAX_DAILY_SCHEDULED_MINUTES, type Actor } from "../src/services/schedule.service";
import { localDateString } from "../src/services/time.service";

let householdId: string;
let ipId: string;
let adminActor: Actor;
let clientActor: Actor;
const here = { lat: 0, lng: 0, accuracyMeters: 5 };
const HOUR = 3_600_000;

beforeAll(async () => {
  const passwordHash = await hashPassword("test-only-password");
  const h = await db.household.create({ data: { name: "limits-test", apartmentLat: 0, apartmentLng: 0 } });
  householdId = h.id;
  const admin = await db.user.create({ data: { householdId, role: "ADMIN", name: "Morgan", email: `a-${h.id}@test.local`, passwordHash } });
  const client = await db.user.create({ data: { householdId, role: "CLIENT", name: "Chris", email: `c-${h.id}@test.local`, passwordHash } });
  const ip = await db.user.create({ data: { householdId, role: "IP", name: "Pat", email: `i-${h.id}@test.local`, passwordHash } });
  ipId = ip.id;
  adminActor = { userId: admin.id, role: "ADMIN", householdId };
  clientActor = { userId: client.id, role: "CLIENT", householdId };
});

afterAll(async () => {
  await db.alertRead.deleteMany({ where: { alert: { householdId } } });
  await db.alert.deleteMany({ where: { householdId } });
  await db.event.deleteMany({ where: { householdId } });
  await db.locationReading.deleteMany({ where: { householdId } });
  await db.taskInstance.deleteMany({ where: { householdId } });
  await db.scheduledShift.deleteMany({ where: { householdId } });
  await db.recurringScheduleRule.deleteMany({ where: { householdId } });
  await db.weekAllowance.deleteMany({ where: { householdId } });
  await db.taskTemplate.deleteMany({ where: { householdId } });
  await db.user.deleteMany({ where: { householdId } });
  await db.household.delete({ where: { id: householdId } });
  await db.$disconnect();
});

describe("no more than eight scheduled hours in a day", () => {
  it("allows exactly eight hours", async () => {
    const shift = await createShift(clientActor, { ipUserId: ipId, localDate: "2027-02-01", startLocal: "09:00", endLocal: "17:00", status: "SCHEDULED" });
    expect(shift.scheduledEndUtc.getTime() - shift.scheduledStartUtc.getTime()).toBe(MAX_DAILY_SCHEDULED_MINUTES * 60_000);
  });

  it("refuses more, for the client and for an administrator alike", async () => {
    for (const actor of [clientActor, adminActor]) {
      await expect(
        createShift(actor, { ipUserId: ipId, localDate: "2027-02-02", startLocal: "09:00", endLocal: "17:01", status: "SCHEDULED" })
      ).rejects.toMatchObject({ code: "DAILY_LIMIT_EXCEEDED" });
    }
    await expect(
      createShift(adminActor, { ipUserId: ipId, localDate: "2027-02-02", startLocal: "06:00", endLocal: "20:00", status: "SCHEDULED" })
    ).rejects.toMatchObject({ code: "DAILY_LIMIT_EXCEEDED", message: expect.stringContaining("at most 8 hours") });
    expect(await db.scheduledShift.count({ where: { householdId, localDate: "2027-02-02" } })).toBe(0);
  });

  it("applies to a weekly pattern too, so no day of it is created over the limit", async () => {
    await createRecurringRule(adminActor, { ipUserId: ipId, weekday: 3, startLocal: "08:00", endLocal: "18:00", effectiveFrom: "2027-03-01" });
    const results = await generateFromRules(adminActor, "2027-03-01", "2027-03-14");
    expect(results.every((r) => r.outcome !== "created")).toBe(true);
    expect(await db.scheduledShift.count({ where: { householdId, localDate: { gte: "2027-03-01", lte: "2027-03-14" } } })).toBe(0);
  });

  it("still allows time off days (they have no hours)", async () => {
    await expect(createShift(clientActor, { ipUserId: ipId, localDate: "2027-02-03", status: "VACATION" })).resolves.toBeTruthy();
  });
});

describe("a warning well before sixteen hours in twenty-four", () => {
  it("adds up the time recorded over the last 24 hours across visits", async () => {
    const now = new Date();
    const ago = (h: number) => new Date(now.getTime() - h * HOUR);
    const mk = (start: Date, end: Date | null) =>
      db.scheduledShift.create({
        data: {
          householdId, ipUserId: ipId, localDate: localDateString(start, "America/Chicago"), scheduledStartUtc: start, scheduledEndUtc: end ?? now,
          status: "SCHEDULED", createdBy: ipId, observedCheckInUtc: start, observedCheckOutUtc: end,
        },
      });
    const old = await mk(ago(40), ago(30)); // before the window: not counted
    const partlyIn = await mk(ago(26), ago(22)); // only the last 2 of its 4 hours fall inside
    const inside = await mk(ago(10), ago(6)); // 4 hours
    const minutes = await db.$transaction((tx) => rollingObservedMinutes(tx, ipId, now));
    expect(Math.round(minutes / 60)).toBe(6); // 2 + 4
    await db.scheduledShift.deleteMany({ where: { id: { in: [old.id, partlyIn.id, inside.id] } } });
  });

  it("raises one alert at checkout when 14 hours or more were recorded, and says nothing below that", async () => {
    expect(LONG_DAY_WARN_MINUTES).toBe(14 * 60);
    const now = new Date();
    const template = await db.taskTemplate.create({ data: { householdId, groupName: "Kitchen", title: "Dishes", instructions: "x", frequency: "VISIT", sortOrder: 0 } });
    void template;

    // A long visit that ended 2 hours ago (10 hours), then a visit now that has run 5 hours: 15 hours in 24.
    const earlier = new Date(now.getTime() - 12 * HOUR);
    await db.scheduledShift.create({
      data: {
        householdId, ipUserId: ipId, localDate: localDateString(earlier, "America/Chicago"), scheduledStartUtc: earlier, scheduledEndUtc: new Date(earlier.getTime() + 10 * HOUR),
        status: "SCHEDULED", createdBy: ipId, observedCheckInUtc: earlier, observedCheckOutUtc: new Date(earlier.getTime() + 10 * HOUR),
      },
    });
    const live = await db.scheduledShift.create({
      data: {
        householdId, ipUserId: ipId, localDate: localDateString(now, "America/Chicago"), scheduledStartUtc: new Date(now.getTime() - 5 * 60_000),
        scheduledEndUtc: new Date(now.getTime() + 3 * HOUR), status: "SCHEDULED", createdBy: ipId,
      },
    });
    await checkIn({ shiftId: live.id, ipUserId: ipId, ...here });
    await db.scheduledShift.update({ where: { id: live.id }, data: { observedCheckInUtc: new Date(now.getTime() - 5 * HOUR) } });
    await checkOut({ shiftId: live.id, ipUserId: ipId, ...here });

    const alerts = await db.alert.findMany({ where: { householdId, type: "long_day" } });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.audience.sort()).toEqual(["ADMIN", "CLIENT"]);
    expect(alerts[0]!.message).toMatch(/hours were recorded in the last 24 hours/);
    expect(alerts[0]!.message).toMatch(/16 hours in 24/);
  });
});
