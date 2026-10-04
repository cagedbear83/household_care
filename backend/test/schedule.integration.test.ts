import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../src/db";
import { hashPassword } from "../src/auth/password";
import { verifyChainIntegrity } from "../src/services/event.service";
import {
  cancelShift,
  createRecurringRule,
  createShift,
  generateFromRules,
  listActiveShifts,
  replaceShift,
  ScheduleRejectedError,
  type Actor,
} from "../src/services/schedule.service";
import { checkIn } from "../src/services/authorization.service";
import { createTemplate, updateTemplate } from "../src/services/task-template.service";

// Runs against the local dev database inside its own throwaway household, so
// it never touches the seeded demo data. Cleaned up in afterAll.
let householdId: string;
let otherHouseholdId: string;
let actor: Actor;
let ipId: string;
let otherIpId: string;

// Week of Mon 2027-01-04 .. Sun 2027-01-10 (America/Chicago, no DST nearby).
const day = (n: number) => `2027-01-${String(4 + n).padStart(2, "0")}`;

async function expectRejected(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toMatchObject({ code });
  await promise.catch((e) => expect(e).toBeInstanceOf(ScheduleRejectedError));
}

beforeAll(async () => {
  const passwordHash = await hashPassword("test-only-password");
  const mk = async (name: string) => {
    const h = await db.household.create({ data: { name, apartmentLat: 0, apartmentLng: 0 } });
    const admin = await db.user.create({
      data: { householdId: h.id, role: "ADMIN", name: "A", email: `${h.id}-admin@test.local`, passwordHash },
    });
    const ip = await db.user.create({
      data: { householdId: h.id, role: "IP", name: "I", email: `${h.id}-ip@test.local`, passwordHash },
    });
    return { h, admin, ip };
  };
  const main = await mk("schedule-test");
  const other = await mk("schedule-test-other");
  householdId = main.h.id;
  otherHouseholdId = other.h.id;
  ipId = main.ip.id;
  otherIpId = other.ip.id;
  actor = { userId: main.admin.id, role: "ADMIN", householdId };
});

afterAll(async () => {
  for (const id of [householdId, otherHouseholdId]) {
    await db.alertRead.deleteMany({ where: { alert: { householdId: id } } });
    await db.alert.deleteMany({ where: { householdId: id } });
    await db.event.deleteMany({ where: { householdId: id } });
    await db.scheduledShift.deleteMany({ where: { householdId: id } });
    await db.recurringScheduleRule.deleteMany({ where: { householdId: id } });
    await db.weekAllowance.deleteMany({ where: { householdId: id } });
    await db.taskTemplate.deleteMany({ where: { householdId: id } });
    await db.user.deleteMany({ where: { householdId: id } });
    await db.household.delete({ where: { id } });
  }
  await db.$disconnect();
});

describe("createShift", () => {
  it("creates a shift and writes an audit event", async () => {
    const shift = await createShift(actor, {
      ipUserId: ipId, localDate: day(0), startLocal: "09:00", endLocal: "15:00", status: "SCHEDULED",
    });
    expect(shift.scheduledEndUtc.getTime() - shift.scheduledStartUtc.getTime()).toBe(6 * 3_600_000);
    const events = await db.event.findMany({ where: { householdId, action: "shift_scheduled" } });
    expect(events).toHaveLength(1);
  });

  it("rejects a second entry on the same day", async () => {
    await expectRejected(
      createShift(actor, { ipUserId: ipId, localDate: day(0), startLocal: "16:00", endLocal: "17:00", status: "SCHEDULED" }),
      "DUPLICATE_DAY"
    );
  });

  it("allows exactly 36 hours in a workweek and rejects anything past it", async () => {
    for (let i = 1; i <= 5; i++) {
      await createShift(actor, { ipUserId: ipId, localDate: day(i), startLocal: "09:00", endLocal: "15:00", status: "SCHEDULED" });
    }
    // Mon-Sat is now 6 x 6h = 36h.
    await expectRejected(
      createShift(actor, { ipUserId: ipId, localDate: day(6), startLocal: "09:00", endLocal: "09:01", status: "SCHEDULED" }),
      "WEEKLY_CAP_EXCEEDED"
    );
  });

  it("does not count vacation/sick days toward the cap", async () => {
    const sick = await createShift(actor, { ipUserId: ipId, localDate: day(6), status: "SICK" });
    expect(sick.scheduledEndUtc.getTime()).toBe(sick.scheduledStartUtc.getTime());
  });

  it("applies the cap per workweek, not across weeks", async () => {
    await createShift(actor, { ipUserId: ipId, localDate: "2027-01-11", startLocal: "09:00", endLocal: "15:00", status: "SCHEDULED" });
  });

  it("rejects an end time that is not after the start", async () => {
    await expectRejected(
      createShift(actor, { ipUserId: ipId, localDate: "2027-01-12", startLocal: "15:00", endLocal: "09:00", status: "SCHEDULED" }),
      "END_BEFORE_START"
    );
  });

  it("rejects a wall-clock time that does not exist during spring-forward", async () => {
    // America/Chicago, 2027-03-14: 02:00 jumps straight to 03:00.
    await expectRejected(
      createShift(actor, { ipUserId: ipId, localDate: "2027-03-14", startLocal: "02:30", endLocal: "08:30", status: "SCHEDULED" }),
      "INVALID_TIME"
    );
  });

  it("computes real elapsed time across spring-forward", async () => {
    const shift = await createShift(actor, {
      ipUserId: ipId, localDate: "2027-03-14", startLocal: "00:30", endLocal: "06:30", status: "SCHEDULED",
    });
    // 00:30 -> 06:30 local is only 5 real hours that night.
    expect(shift.scheduledEndUtc.getTime() - shift.scheduledStartUtc.getTime()).toBe(5 * 3_600_000);
  });

  it("will not schedule an IP from another household", async () => {
    await expectRejected(
      createShift(actor, { ipUserId: otherIpId, localDate: "2027-02-01", startLocal: "09:00", endLocal: "10:00", status: "SCHEDULED" }),
      "IP_NOT_FOUND"
    );
  });

  it("cannot be raced past the weekly cap by concurrent requests", async () => {
    const week = ["2027-05-03", "2027-05-04", "2027-05-05", "2027-05-06", "2027-05-07", "2027-05-08", "2027-05-09"];
    // Seven 6h shifts submitted at once: only six (36h) may succeed.
    const settled = await Promise.allSettled(
      week.map((d) => createShift(actor, { ipUserId: ipId, localDate: d, startLocal: "09:00", endLocal: "15:00", status: "SCHEDULED" }))
    );
    expect(settled.filter((r) => r.status === "fulfilled")).toHaveLength(6);
    const rejected = settled.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toMatchObject({ code: "WEEKLY_CAP_EXCEEDED" });
  });
});

describe("recurring rules", () => {
  it("expands into shifts, and re-running skips days that already exist", async () => {
    await createRecurringRule(actor, {
      ipUserId: ipId, weekday: 1, startLocal: "10:00", endLocal: "14:00", effectiveFrom: "2027-06-01",
    });
    const first = await generateFromRules(actor, "2027-06-01", "2027-06-21");
    const created = first.filter((r) => r.outcome === "created").map((r) => r.localDate);
    expect(created).toEqual(["2027-06-07", "2027-06-14", "2027-06-21"]); // Mondays

    const second = await generateFromRules(actor, "2027-06-01", "2027-06-21");
    expect(second.every((r) => r.outcome === "skipped" && r.code === "DUPLICATE_DAY")).toBe(true);
  });
});

describe("task templates", () => {
  it("records before/after on edit without touching past snapshots", async () => {
    const t = await createTemplate(actor, {
      groupName: "Kitchen", title: "Wipe counters", instructions: "Old text", frequency: "VISIT", requiresPhoto: false, sortOrder: 1,
    });
    await updateTemplate(actor, t.id, { instructions: "New text" });
    const ev = await db.event.findFirst({ where: { householdId, action: "task_template_updated" } });
    const payload = ev!.payload as { before: { instructions: string }; changes: { instructions: string } };
    expect(payload.before.instructions).toBe("Old text");
    expect(payload.changes.instructions).toBe("New text");
  });
});

describe("changing and cancelling shifts", () => {
  // Week of Mon 2027-09-06 .. Sun 2027-09-12 — safely in the future.
  const d = (n: number) => `2027-09-${String(6 + n).padStart(2, "0")}`;
  const ids: string[] = [];

  it("replaces a shift while keeping the old version and recording why", async () => {
    for (let i = 0; i <= 5; i++) {
      const s = await createShift(actor, { ipUserId: ipId, localDate: d(i), startLocal: "09:00", endLocal: "15:00", status: "SCHEDULED" });
      ids.push(s.id);
    }
    const replaced = await replaceShift(actor, ids[0]!, { localDate: d(0), startLocal: "09:00", endLocal: "14:00", status: "SCHEDULED" }, "Client asked for a shorter day");

    const old = await db.scheduledShift.findUniqueOrThrow({ where: { id: ids[0]! } });
    expect(old.supersededAt).not.toBeNull();
    expect(old.supersededByShiftId).toBe(replaced.id);
    expect(replaced.supersedesShiftId).toBe(ids[0]);

    const active = await listActiveShifts(householdId, d(0), d(0));
    expect(active).toHaveLength(1);
    expect(active[0]!.id).toBe(replaced.id);
    expect(active[0]!.previous?.id).toBe(ids[0]);

    const ev = await db.event.findFirst({ where: { householdId, action: "shift_replaced", shiftId: replaced.id } });
    const payload = ev!.payload as { reason: string; oldShiftId: string; before: { endUtc: string } };
    expect(payload.reason).toBe("Client asked for a shorter day");
    expect(payload.oldShiftId).toBe(ids[0]);
    expect(new Date(payload.before.endUtc).getTime() - old.scheduledStartUtc.getTime()).toBe(6 * 3_600_000);
    ids[0] = replaced.id;
  });

  it("requires a reason", async () => {
    await expectRejected(cancelShift(actor, ids[1]!, "  "), "REASON_REQUIRED");
  });

  it("still enforces the weekly cap on a replacement, and leaves the original intact if refused", async () => {
    // Mon is now 5h, Tue-Sat 6h each = 35h. Making Tuesday 8h would reach 37h.
    await expectRejected(
      replaceShift(actor, ids[1]!, { localDate: d(1), startLocal: "09:00", endLocal: "17:00", status: "SCHEDULED" }, "Longer day"),
      "WEEKLY_CAP_EXCEEDED"
    );
    const still = await db.scheduledShift.findUniqueOrThrow({ where: { id: ids[1]! } });
    expect(still.supersededAt).toBeNull();
  });

  it("frees the hours when a shift is cancelled, and the day can be scheduled again", async () => {
    await cancelShift(actor, ids[1]!, "IP is unavailable");
    expect((await listActiveShifts(householdId, d(1), d(1)))).toHaveLength(0);
    expect((await db.scheduledShift.findUnique({ where: { id: ids[1]! } }))).not.toBeNull(); // history kept
    await createShift(actor, { ipUserId: ipId, localDate: d(1), startLocal: "09:00", endLocal: "15:00", status: "SCHEDULED" });
    await expectRejected(cancelShift(actor, ids[1]!, "again"), "ALREADY_SUPERSEDED");
  });

  it("refuses to change a shift that has already been checked in", async () => {
    await db.scheduledShift.update({ where: { id: ids[2]! }, data: { checkInEventId: "started" } });
    await expectRejected(cancelShift(actor, ids[2]!, "too late"), "SHIFT_STARTED");
    await expectRejected(
      replaceShift(actor, ids[2]!, { localDate: d(2), startLocal: "10:00", endLocal: "14:00", status: "SCHEDULED" }, "too late"),
      "SHIFT_STARTED"
    );
  });

  it("will not erase or backdate a shift that has already ended", async () => {
    const past = await createShift(actor, { ipUserId: ipId, localDate: "2026-01-05", startLocal: "09:00", endLocal: "15:00", status: "SCHEDULED" });
    await expectRejected(cancelShift(actor, past.id, "cleanup"), "SHIFT_IN_PAST");
    await expectRejected(
      replaceShift(actor, ids[3]!, { localDate: "2026-01-06", startLocal: "09:00", endLocal: "15:00", status: "SCHEDULED" }, "backdate"),
      "NEW_SHIFT_IN_PAST"
    );
  });

  it("cannot be used across households", async () => {
    const otherActor: Actor = { userId: actor.userId, role: "ADMIN", householdId: otherHouseholdId };
    await expectRejected(cancelShift(otherActor, ids[4]!, "not yours"), "NOT_FOUND");
  });

  it("blocks check-in to a cancelled shift", async () => {
    await expect(
      checkIn({ shiftId: ids[1]!, ipUserId: ipId, lat: 0, lng: 0, accuracyMeters: 5 })
    ).rejects.toMatchObject({ code: "SHIFT_CHANGED" });
  });
});

describe("audit chain", () => {
  it("stays intact after all of the above", async () => {
    expect(await verifyChainIntegrity(householdId)).toEqual({ ok: true });
  });
});
