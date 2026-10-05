import { afterAll, beforeAll, describe, expect, it, vi, afterEach } from "vitest";
import type { Request, Response } from "express";
import { db } from "../src/db";
import { hashPassword } from "../src/auth/password";
import { requireAuth, requireRole } from "../src/auth/middleware";
import { effectiveRole, sessionUser } from "../src/auth/effective-role";
import { signAuthToken } from "../src/auth/jwt";
import { appendEvent, verifyChainIntegrity } from "../src/services/event.service";
import { ensurePrimaryFamily, makePrimaryFamily } from "../src/services/primary-family.service";
import { listFamily, revokeFamilyMember } from "../src/services/invite.service";
import { approveTask } from "../src/services/review.service";
import { getProfile } from "../src/services/profile.service";
import { notifyRolesNow } from "../src/services/household-notify.service";
import * as notify from "../src/services/notify.service";

let householdId: string;
let ids: { client: string; admin: string; ip: string; a: string; b: string; c: string; task: string };
const invites: Record<"a" | "b" | "c", string> = { a: "", b: "", c: "" };

const client = () => ({ userId: ids.client, role: "CLIENT" as const, householdId });
const admin = () => ({ userId: ids.admin, role: "ADMIN" as const, householdId });

/** Runs the real auth check for a token and tells what the rest of the server would see. */
async function authFor(userId: string, role: "FAMILY" | "CLIENT") {
  const token = signAuthToken({ userId, householdId, role });
  const captured: { auth?: { role: string; primaryFamily: boolean; canViewTimestamps: boolean }; status: number } = { status: 200 };
  const req = { headers: { authorization: `Bearer ${token}` } } as unknown as Request & { auth?: typeof captured.auth };
  const res = { status(code: number) { captured.status = code; return this; }, json() { return this; } } as unknown as Response;
  await requireAuth(req as never, res, () => undefined);
  captured.auth = req.auth;
  return captured;
}

async function pass(guard: ReturnType<typeof requireRole>, auth: { role: string } | undefined) {
  let status = 200;
  const req = { auth } as never;
  const res = { status(code: number) { status = code; return this; }, json() { return this; } } as never;
  guard(req, res, () => undefined);
  return status === 200;
}

beforeAll(async () => {
  const passwordHash = await hashPassword("test-only-password");
  const h = await db.household.create({ data: { name: "primary-family-test", apartmentLat: 0, apartmentLng: 0 } });
  householdId = h.id;
  const mk = (role: "CLIENT" | "ADMIN" | "IP" | "FAMILY", name: string, extra: object = {}) =>
    db.user.create({ data: { householdId, role, name, email: `${name.toLowerCase()}-${h.id}@test.local`, passwordHash, ...extra } });
  const day = (n: number) => new Date(Date.now() - n * 86_400_000);
  const [c, ad, ip, a, b, cc] = await Promise.all([
    mk("CLIENT", "Chris"),
    mk("ADMIN", "Morgan"),
    mk("IP", "Pat"),
    mk("FAMILY", "Ann", { activatedAt: day(30) }),
    mk("FAMILY", "Ben", { activatedAt: day(20) }),
    mk("FAMILY", "Cam", { activatedAt: day(10) }),
  ]);
  for (const [key, user] of [["a", a], ["b", b], ["c", cc]] as const) {
    const invite = await db.invite.create({
      data: {
        householdId, invitedByUserId: c.id, channel: "EMAIL", contact: user.email!, firstName: user.name, lastName: "Family",
        tokenHash: `hash-${key}-${h.id}`, expiresAt: new Date(Date.now() + 86_400_000), status: "COMPLETED", userId: user.id,
      },
    });
    invites[key] = invite.id;
  }
  const template = await db.taskTemplate.create({ data: { householdId, groupName: "Kitchen", title: "Dishes", instructions: "x", frequency: "VISIT", sortOrder: 0 } });
  const now = new Date();
  const shift = await db.scheduledShift.create({
    data: { householdId, ipUserId: ip.id, localDate: "2026-10-03", scheduledStartUtc: now, scheduledEndUtc: new Date(now.getTime() + 3_600_000), status: "SCHEDULED", createdBy: ip.id },
  });
  const task = await db.taskInstance.create({
    data: { householdId, shiftId: shift.id, templateId: template.id, assignedDate: "2026-10-03", titleSnapshot: "Dishes", instructionsSnapshot: "x", requiresPhotoSnapshot: false, state: "COMPLETED_AWAITING_REVIEW" },
  });
  await db.$transaction((tx) => appendEvent(tx, { householdId, actorUserId: ip.id, actorRole: "IP", action: "task_completed", shiftId: shift.id, taskInstanceId: task.id, payload: {} }));
  ids = { client: c.id, admin: ad.id, ip: ip.id, a: a.id, b: b.id, c: cc.id, task: task.id };
});

afterEach(() => vi.restoreAllMocks());

afterAll(async () => {
  await db.alertRead.deleteMany({ where: { alert: { householdId } } });
  await db.alert.deleteMany({ where: { householdId } });
  await db.outboundMessage.deleteMany({ where: { householdId } });
  await db.event.deleteMany({ where: { householdId } });
  await db.taskInstance.deleteMany({ where: { householdId } });
  await db.scheduledShift.deleteMany({ where: { householdId } });
  await db.taskTemplate.deleteMany({ where: { householdId } });
  await db.invite.deleteMany({ where: { householdId } });
  await db.user.deleteMany({ where: { householdId } });
  await db.household.delete({ where: { id: householdId } });
  await db.$disconnect();
});

describe("who becomes the primary family member", () => {
  it("is the earliest family member to have activated, and only one", async () => {
    // Two requests at the same moment still produce exactly one.
    const results = await Promise.all([1, 2, 3, 4].map(() => db.$transaction((tx) => ensurePrimaryFamily(tx, householdId))));
    expect(new Set(results).size).toBe(1);
    expect(results[0]).toBe(ids.a);
    const flagged = await db.user.findMany({ where: { householdId, isPrimaryFamily: true } });
    expect(flagged.map((u) => u.id)).toEqual([ids.a]);
  });

  it("is shown in the family list", async () => {
    const list = await listFamily(householdId);
    expect(list.filter((f) => f.isPrimary).map((f) => f.name)).toEqual(["Ann Family"]);
  });
});

describe("the primary family member has the client's access", () => {
  it("is treated as the client everywhere the server checks, but is still the person who acted", async () => {
    const primary = await authFor(ids.a, "FAMILY");
    expect(primary.status).toBe(200);
    expect(primary.auth).toMatchObject({ role: "CLIENT", primaryFamily: true, canViewTimestamps: true });
    expect(await pass(requireRole("CLIENT"), primary.auth)).toBe(true);

    const other = await authFor(ids.b, "FAMILY");
    expect(other.auth).toMatchObject({ role: "FAMILY", primaryFamily: false });
    expect(await pass(requireRole("CLIENT"), other.auth)).toBe(false);
  });

  it("can decide on the client's behalf, and the record shows who it was", async () => {
    await approveTask({ userId: ids.a, householdId }, ids.task);
    const event = await db.event.findFirstOrThrow({ where: { householdId, action: "task_approved" } });
    expect(event.actorUserId).toBe(ids.a);
    expect((await db.taskInstance.findUniqueOrThrow({ where: { id: ids.task } })).state).toBe("APPROVED");
  });

  it("is told the same things the client is told, and other family members are not", async () => {
    const sent = vi.spyOn(notify, "sendMessage").mockResolvedValue({ delivered: true, provider: "test" });
    await notifyRolesNow(householdId, ["CLIENT"], "Subject", "Body");
    const to = sent.mock.calls.map(([m]) => m.to).sort();
    expect(to).toEqual([`ann-${householdId}@test.local`, `chris-${householdId}@test.local`].sort());
  });

  it("is described as the client's equal in the profile and the session", async () => {
    const user = await db.user.findUniqueOrThrow({ where: { id: ids.a } });
    expect(effectiveRole(user)).toBe("CLIENT");
    expect(sessionUser(user)).toMatchObject({ role: "CLIENT", primaryFamily: true });
    expect(await getProfile(ids.a)).toMatchObject({ role: "CLIENT", primaryFamily: true, roleLabel: "Family (primary: same access as the client)", canViewTimestamps: null });
    expect(effectiveRole(await db.user.findUniqueOrThrow({ where: { id: ids.b } }))).toBe("FAMILY");
  });
});

describe("the client cannot remove the primary family member", () => {
  it("is refused for the client and for the primary family member themselves", async () => {
    await expect(revokeFamilyMember(client(), invites.a)).rejects.toMatchObject({ code: "PRIMARY_PROTECTED", status: 403 });
    await expect(revokeFamilyMember({ userId: ids.a, role: "CLIENT", householdId }, invites.a)).rejects.toMatchObject({ code: "PRIMARY_PROTECTED" });
    expect((await db.user.findUniqueOrThrow({ where: { id: ids.a } })).accessRevokedAt).toBeNull();
  });

  it("is something only an administrator can do, with a reason, and someone else steps up", async () => {
    await expect(revokeFamilyMember(admin(), invites.a)).rejects.toMatchObject({ code: "REASON_REQUIRED" });
    await revokeFamilyMember(admin(), invites.a, "Concerns raised with the case manager");
    expect((await db.user.findUniqueOrThrow({ where: { id: ids.a } })).accessRevokedAt).not.toBeNull();
    const flagged = await db.user.findMany({ where: { householdId, isPrimaryFamily: true } });
    expect(flagged.map((u) => u.id)).toEqual([ids.b]); // the next earliest to have activated
    const event = await db.event.findFirstOrThrow({ where: { householdId, action: "family_revoked" } });
    expect(event.payload).toMatchObject({ wasPrimary: true, reason: "Concerns raised with the case manager" });
  });

  it("leaves everyone else as the client's to turn off, not an administrator's", async () => {
    await expect(revokeFamilyMember(admin(), invites.c)).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
    await revokeFamilyMember(client(), invites.c);
    expect((await db.user.findUniqueOrThrow({ where: { id: ids.c } })).accessRevokedAt).not.toBeNull();
  });
});

describe("changing who the primary family member is", () => {
  let d: string;
  beforeAll(async () => {
    const user = await db.user.create({
      data: { householdId, role: "FAMILY", name: "Dee", email: `dee-${householdId}@test.local`, passwordHash: await hashPassword("test-only-password"), activatedAt: new Date() },
    });
    d = user.id;
  });

  it("is for an administrator only, needs a reason and an active family member", async () => {
    await expect(makePrimaryFamily(client(), d, "I want her")).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
    await expect(makePrimaryFamily({ userId: ids.a, role: "CLIENT", householdId }, d, "I want her")).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(makePrimaryFamily(admin(), d, " ")).rejects.toMatchObject({ code: "REASON_REQUIRED" });
    await expect(makePrimaryFamily(admin(), ids.a, "Revoked person")).rejects.toMatchObject({ code: "NOT_ELIGIBLE" }); // turned off earlier
    await expect(makePrimaryFamily(admin(), ids.b, "Already primary")).rejects.toMatchObject({ code: "ALREADY_PRIMARY" });
    await expect(makePrimaryFamily(admin(), ids.ip, "Not family")).rejects.toMatchObject({ code: "NOT_ELIGIBLE" });
  });

  it("moves the role to the chosen person, keeps exactly one, and records it", async () => {
    await makePrimaryFamily(admin(), d, "Closer to the client and available daily");
    const flagged = await db.user.findMany({ where: { householdId, isPrimaryFamily: true } });
    expect(flagged.map((u) => u.id)).toEqual([d]);
    const event = await db.event.findFirstOrThrow({ where: { householdId, action: "primary_family_changed" } });
    expect(event.actorUserId).toBe(ids.admin);
    expect(event.payload).toMatchObject({ to: d, reason: "Closer to the client and available daily" });
    // The previous primary is an ordinary family member again, so the client can now turn them off.
    expect((await authFor(ids.b, "FAMILY")).auth).toMatchObject({ role: "FAMILY" });
  });

  it("keeps the audit chain intact", async () => {
    expect((await verifyChainIntegrity(householdId)).ok).toBe(true);
  });
});
