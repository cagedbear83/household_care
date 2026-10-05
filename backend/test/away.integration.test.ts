import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "../src/db";
import { hashPassword } from "../src/auth/password";
import { checkIn, checkOut } from "../src/services/authorization.service";
import { AWAY_MESSAGE, clientIsAway, endAway, getAway, startAway } from "../src/services/away.service";
import { completeTask } from "../src/services/task.service";
import { issueChallenge } from "../src/services/evidence.service";
import { verifyChainIntegrity } from "../src/services/event.service";
import { localDateString } from "../src/services/time.service";
import * as notify from "../src/services/notify.service";

let householdId: string;
let ids: { client: string; admin: string; ip: string; primary: string; other: string; shift: string; plain: string; photo: string };
const here = { lat: 0, lng: 0, accuracyMeters: 5 };

const as = (userId: string, role: "CLIENT" | "ADMIN" | "IP" | "FAMILY") => ({ userId, role, householdId });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  const passwordHash = await hashPassword("test-only-password");
  const h = await db.household.create({ data: { name: "away-test", apartmentLat: 0, apartmentLng: 0 } });
  householdId = h.id;
  const mk = (role: "CLIENT" | "ADMIN" | "IP" | "FAMILY", name: string, extra: object = {}) =>
    db.user.create({ data: { householdId, role, name, email: `${name.toLowerCase()}-${h.id}@test.local`, passwordHash, ...extra } });
  const [client, admin, ip, primary, other] = await Promise.all([
    mk("CLIENT", "Chris"), mk("ADMIN", "Morgan"), mk("IP", "Pat"),
    mk("FAMILY", "Ann", { isPrimaryFamily: true, activatedAt: new Date() }),
    mk("FAMILY", "Ben", { activatedAt: new Date() }),
  ]);
  await db.taskTemplate.create({ data: { householdId, groupName: "Kitchen", title: "Dishes", instructions: "x", frequency: "VISIT", requiresPhoto: false, sortOrder: 0 } });
  await db.taskTemplate.create({ data: { householdId, groupName: "Kitchen", title: "Sink", instructions: "x", frequency: "VISIT", requiresPhoto: true, sortOrder: 1 } });
  const now = new Date();
  const shift = await db.scheduledShift.create({
    data: {
      householdId, ipUserId: ip.id, localDate: localDateString(now, h.timezone),
      scheduledStartUtc: new Date(now.getTime() - 5 * 60_000), scheduledEndUtc: new Date(now.getTime() + 6 * 3_600_000),
      status: "SCHEDULED", createdBy: ip.id,
    },
  });
  ids = { client: client.id, admin: admin.id, ip: ip.id, primary: primary.id, other: other.id, shift: shift.id, plain: "", photo: "" };
});

afterEach(() => vi.restoreAllMocks());

afterAll(async () => {
  await db.alertRead.deleteMany({ where: { alert: { householdId } } });
  await db.alert.deleteMany({ where: { householdId } });
  await db.outboundMessage.deleteMany({ where: { householdId } });
  await db.captureChallenge.deleteMany({ where: { householdId } });
  await db.event.deleteMany({ where: { householdId } });
  await db.locationReading.deleteMany({ where: { householdId } });
  await db.taskInstance.deleteMany({ where: { householdId } });
  await db.scheduledShift.deleteMany({ where: { householdId } });
  await db.weekAllowance.deleteMany({ where: { householdId } });
  await db.awayPeriod.deleteMany({ where: { householdId } });
  await db.taskTemplate.deleteMany({ where: { householdId } });
  await db.user.deleteMany({ where: { householdId } });
  await db.household.delete({ where: { id: householdId } });
  await db.$disconnect();
});

describe("who can turn away mode on and off", () => {
  it("is refused for the IP and for a family member who is not the primary one", async () => {
    await expect(startAway(as(ids.ip, "IP"), { kind: "HOSPITAL" })).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
    await expect(startAway(as(ids.other, "FAMILY"), { kind: "HOSPITAL" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await clientIsAway(householdId)).toBe(false);
  });

  it("checks the date, and ending when not away says so", async () => {
    await expect(startAway(as(ids.client, "CLIENT"), { kind: "VACATION", expectedReturnDate: "2026-13-40" })).rejects.toMatchObject({ code: "INVALID_DATE" });
    await expect(endAway(as(ids.client, "CLIENT"))).rejects.toMatchObject({ code: "NOT_AWAY" });
  });
});

describe("before anyone is away", () => {
  it("lets the IP check in and work", async () => {
    // (the visit is started here so the next group can show it being cut off mid-visit)
    await checkIn({ shiftId: ids.shift, ipUserId: ids.ip, ...here });
    const tasks = await db.taskInstance.findMany({ where: { shiftId: ids.shift }, orderBy: { createdAt: "asc" } });
    ids.plain = tasks.find((t) => t.titleSnapshot === "Dishes")!.id;
    ids.photo = tasks.find((t) => t.titleSnapshot === "Sink")!.id;
    expect(await getAway({ role: "IP", householdId })).toEqual({ away: false });
  });
});

describe("when the client is away", () => {
  it("can be turned on by the primary family member (who acts with the client's access)", async () => {
    const sent = vi.spyOn(notify, "sendMessage").mockResolvedValue({ delivered: true, provider: "test" });
    const result = await startAway({ userId: ids.primary, role: "CLIENT", householdId }, { kind: "HOSPITAL", expectedReturnDate: "2099-01-01", note: "Admitted tonight" });
    expect(result.id).toBeTruthy();
    expect(await clientIsAway(householdId)).toBe(true);

    // The IP is told work is paused, and only that: nothing about why.
    await wait(300);
    const toIp = sent.mock.calls.map(([m]) => m).filter((m) => m.to === `pat-${householdId}@test.local`);
    expect(toIp).toHaveLength(1);
    expect(toIp[0]!.body).toBe(AWAY_MESSAGE);
    expect(JSON.stringify(sent.mock.calls)).not.toMatch(/hospital|admitted/i);

    const event = await db.event.findFirstOrThrow({ where: { householdId, action: "client_away_started" } });
    expect(event.actorUserId).toBe(ids.primary);
    expect(await db.alert.count({ where: { householdId, type: "client_away" } })).toBe(1);
  });

  it("shows the details to the client's side and only yes-or-no to everyone else", async () => {
    expect(await getAway({ role: "CLIENT", householdId })).toMatchObject({ away: true, kind: "HOSPITAL", expectedReturnDate: "2099-01-01", note: "Admitted tonight", setBy: "Ann" });
    expect(await getAway({ role: "ADMIN", householdId })).toMatchObject({ away: true, kind: "HOSPITAL" });
    expect(await getAway({ role: "IP", householdId })).toEqual({ away: true });
    expect(await getAway({ role: "FAMILY", householdId })).toEqual({ away: true });
  });

  it("allows only one at a time, even when two people press the button together", async () => {
    await expect(startAway(as(ids.client, "CLIENT"), { kind: "VACATION" })).rejects.toMatchObject({ code: "ALREADY_AWAY" });
    expect(await db.awayPeriod.count({ where: { householdId, endedAt: null } })).toBe(1);
  });

  it("stops tasks and photos, but never checkout", async () => {
    await expect(completeTask(ids.plain, ids.ip)).rejects.toMatchObject({ code: "CLIENT_AWAY" });
    await expect(issueChallenge(ids.ip, householdId, ids.photo)).rejects.toMatchObject({ code: "CLIENT_AWAY" });
    const out = await checkOut({ shiftId: ids.shift, ipUserId: ids.ip, lat: 0, lng: 0, accuracyMeters: 5 });
    expect(out.observedCheckOutUtc).not.toBeNull();
    expect((await db.taskInstance.findUniqueOrThrow({ where: { id: ids.plain } })).state).toBe("NOT_STARTED");
  });

  it("stops a new check-in", async () => {
    const later = await db.scheduledShift.create({
      data: {
        householdId, ipUserId: ids.ip, localDate: localDateString(new Date(), "America/Chicago"),
        scheduledStartUtc: new Date(Date.now() - 60_000), scheduledEndUtc: new Date(Date.now() + 3_600_000), status: "SCHEDULED", createdBy: ids.ip,
      },
    });
    await expect(checkIn({ shiftId: later.id, ipUserId: ids.ip, ...here })).rejects.toMatchObject({ code: "CLIENT_AWAY", message: AWAY_MESSAGE });
    expect((await db.scheduledShift.findUniqueOrThrow({ where: { id: later.id } })).checkInEventId).toBeNull();
    await db.scheduledShift.delete({ where: { id: later.id } });
  });
});

describe("when the client is back", () => {
  it("can be ended by the client's side, and work can start again", async () => {
    const sent = vi.spyOn(notify, "sendMessage").mockResolvedValue({ delivered: true, provider: "test" });
    await endAway(as(ids.admin, "ADMIN"));
    expect(await clientIsAway(householdId)).toBe(false);
    expect(await getAway({ role: "CLIENT", householdId })).toEqual({ away: false });
    await wait(300);
    expect(sent.mock.calls.some(([m]) => m.to === `pat-${householdId}@test.local` && /can start again/.test(m.body))).toBe(true);

    const again = await db.scheduledShift.create({
      data: {
        householdId, ipUserId: ids.ip, localDate: localDateString(new Date(), "America/Chicago"),
        scheduledStartUtc: new Date(Date.now() - 60_000), scheduledEndUtc: new Date(Date.now() + 3_600_000), status: "SCHEDULED", createdBy: ids.ip,
      },
    });
    await expect(checkIn({ shiftId: again.id, ipUserId: ids.ip, ...here })).resolves.toBeTruthy();
    expect(await db.awayPeriod.findFirstOrThrow({ where: { householdId } })).toMatchObject({ endedByUserId: ids.admin });
  });

  it("keeps the audit chain intact", async () => {
    expect((await verifyChainIntegrity(householdId)).ok).toBe(true);
    expect(await db.event.count({ where: { householdId, action: { in: ["client_away_started", "client_away_ended"] } } })).toBe(2);
  });
});
