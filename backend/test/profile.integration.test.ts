import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Request, Response } from "express";
import { db } from "../src/db";
import { hashPassword, verifyPassword } from "../src/auth/password";
import { requireAuth } from "../src/auth/middleware";
import { signAuthToken } from "../src/auth/jwt";
import { verifyChainIntegrity } from "../src/services/event.service";
import { changePassword, confirmContactChange, getProfile, ProfileError, startContactChange, updateName } from "../src/services/profile.service";

let householdId: string;
let ids: { me: string; other: string; family: string };
const emails = { me: "", other: "" };
const OLD_PASSWORD = "old-password-123";

const outboundTo = (to: string) => db.outboundMessage.findMany({ where: { toAddress: to }, orderBy: { createdAt: "asc" } });
const phone = () => `+1312555${String(Math.floor(1000 + Math.random() * 9000))}`;

async function authCheck(token: string): Promise<number> {
  let status = 200;
  const req = { headers: { authorization: `Bearer ${token}` } } as unknown as Request;
  const res = { status(code: number) { status = code; return this; }, json() { return this; } } as unknown as Response;
  await requireAuth(req as never, res, () => undefined);
  return status;
}

/** Skip the one-minute wait between codes, as time would. */
const skipCooldown = (userId: string) => db.contactChange.updateMany({ where: { userId }, data: { createdAt: new Date(Date.now() - 3 * 60_000) } });

beforeAll(async () => {
  const passwordHash = await hashPassword(OLD_PASSWORD);
  const h = await db.household.create({ data: { name: "profile-test", apartmentLat: 0, apartmentLng: 0 } });
  householdId = h.id;
  emails.me = `me-${h.id}@test.local`;
  emails.other = `other-${h.id}@test.local`;
  const [me, other, family] = await Promise.all([
    db.user.create({ data: { householdId, role: "CLIENT", name: "Chris Client", email: emails.me, passwordHash } }),
    db.user.create({ data: { householdId, role: "ADMIN", name: "Morgan", email: emails.other, passwordHash } }),
    db.user.create({ data: { householdId, role: "FAMILY", name: "Sam Sister", firstName: "Sam", lastName: "Sister", email: `fam-${h.id}@test.local`, passwordHash, relationship: "Sister", canViewTimestamps: true } }),
  ]);
  ids = { me: me.id, other: other.id, family: family.id };
});

afterAll(async () => {
  await db.contactChange.deleteMany({ where: { userId: { in: Object.values(ids) } } });
  await db.outboundMessage.deleteMany({ where: { householdId } });
  await db.event.deleteMany({ where: { householdId } });
  await db.user.deleteMany({ where: { householdId } });
  await db.household.delete({ where: { id: householdId } });
  await db.$disconnect();
});

describe("profile", () => {
  it("shows the person their own information", async () => {
    const p = await getProfile(ids.me);
    expect(p).toMatchObject({ name: "Chris Client", firstName: "Chris", lastName: "Client", role: "CLIENT", roleLabel: "Client", email: emails.me, phone: null, canViewTimestamps: null });
    expect(await getProfile(ids.family)).toMatchObject({ relationship: "Sister", canViewTimestamps: true });
  });

  it("changes the name, tidies spaces, and records before and after", async () => {
    const p = await updateName(ids.me, { firstName: "  Christine ", lastName: "  Client   Jones " });
    expect(p).toMatchObject({ name: "Christine Client Jones", firstName: "Christine", lastName: "Client Jones" });
    const event = await db.event.findFirst({ where: { householdId, action: "profile_name_changed" }, orderBy: { serverTimestampUtc: "desc" } });
    expect(event!.payload).toEqual({ from: "Chris Client", to: "Christine Client Jones" });
    // Saving the same name again records nothing new.
    const count = await db.event.count({ where: { householdId, action: "profile_name_changed" } });
    await updateName(ids.me, { firstName: "Christine", lastName: "Client Jones" });
    expect(await db.event.count({ where: { householdId, action: "profile_name_changed" } })).toBe(count);
  });

  it("needs a first name and refuses an absurdly long one", async () => {
    await expect(updateName(ids.me, { firstName: "   " })).rejects.toMatchObject({ code: "INVALID_NAME" });
    await expect(updateName(ids.me, { firstName: "x".repeat(61) })).rejects.toMatchObject({ code: "INVALID_NAME" });
  });
});

describe("password", () => {
  it("needs the current password, a long enough new one, and a different one", async () => {
    await expect(changePassword(ids.me, "not-my-password", "brand-new-password-1")).rejects.toMatchObject({ code: "WRONG_PASSWORD", status: 403 });
    await expect(changePassword(ids.me, OLD_PASSWORD, "short")).rejects.toMatchObject({ code: "WEAK_PASSWORD" });
    await expect(changePassword(ids.me, OLD_PASSWORD, OLD_PASSWORD)).rejects.toMatchObject({ code: "SAME_PASSWORD" });
    expect(await verifyPassword(OLD_PASSWORD, (await db.user.findUniqueOrThrow({ where: { id: ids.me } })).passwordHash)).toBe(true);
  });

  it("changes it, ends other sessions, and keeps this device signed in with a new token", async () => {
    const oldToken = signAuthToken({ userId: ids.me, householdId, role: "CLIENT" });
    expect(await authCheck(oldToken)).toBe(200);
    await new Promise((r) => setTimeout(r, 2200)); // the old session must be older than the two-second cut-off

    const { token } = await changePassword(ids.me, OLD_PASSWORD, "brand-new-password-1");
    const user = await db.user.findUniqueOrThrow({ where: { id: ids.me } });
    expect(await verifyPassword("brand-new-password-1", user.passwordHash)).toBe(true);
    expect(await verifyPassword(OLD_PASSWORD, user.passwordHash)).toBe(false);
    expect(await authCheck(oldToken)).toBe(401);
    expect(await authCheck(token)).toBe(200);

    const event = await db.event.findFirst({ where: { householdId, action: "password_changed" } });
    expect(JSON.stringify(event!.payload)).not.toContain("brand-new");
    // A notice went to the address on the account.
    expect((await outboundTo(emails.me)).some((m) => /password was just changed/.test(m.body))).toBe(true);
  });
});

describe("changing an email address or phone number", () => {
  it("refuses something that is not an email or phone, the same one, or one another account uses", async () => {
    await expect(startContactChange(ids.me, "not a contact")).rejects.toMatchObject({ code: "INVALID_CONTACT" });
    await expect(startContactChange(ids.me, emails.me.toUpperCase())).rejects.toMatchObject({ code: "SAME_CONTACT" });
    await expect(startContactChange(ids.me, emails.other)).rejects.toMatchObject({ code: "CONTACT_IN_USE", status: 409 });
  });

  it("sends a code to the NEW address, and changes nothing until it is entered", async () => {
    const newEmail = `new-${householdId}@test.local`;
    const started = await startContactChange(ids.me, ` ${newEmail.toUpperCase()} `);
    expect(started.channel).toBe("EMAIL");
    expect(started.maskedTo).toBe(`ne***@${newEmail.split("@")[1]}`);
    expect(started.devCode).toMatch(/^\d{6}$/);
    expect((await outboundTo(newEmail)).length).toBe(1);
    expect((await db.user.findUniqueOrThrow({ where: { id: ids.me } })).email).toBe(emails.me);

    // The wrong code does nothing.
    await expect(confirmContactChange(ids.me, started.devCode === "000000" ? "111111" : "000000")).rejects.toMatchObject({ code: "CODE_INVALID" });
    expect((await db.user.findUniqueOrThrow({ where: { id: ids.me } })).email).toBe(emails.me);

    // The right one switches it, marks it verified, tells the old address, and is single use.
    const profile = await confirmContactChange(ids.me, started.devCode!);
    expect(profile.email).toBe(newEmail);
    expect(profile.emailVerified).toBe(true);
    expect((await outboundTo(emails.me)).some((m) => /was just changed/.test(m.body))).toBe(true);
    await expect(confirmContactChange(ids.me, started.devCode!)).rejects.toMatchObject({ code: "CODE_INVALID" });

    const event = await db.event.findFirst({ where: { householdId, action: "contact_changed" } });
    expect(event!.payload).toMatchObject({ channel: "EMAIL", from: `${emails.me.slice(0, 2)}***@test.local`, to: `ne***@test.local` });
    expect(JSON.stringify(event!.payload)).not.toContain(newEmail);
    emails.me = newEmail;
  });

  it("makes you wait between codes", async () => {
    await skipCooldown(ids.me);
    await startContactChange(ids.me, `again-${householdId}@test.local`);
    await expect(startContactChange(ids.me, `again2-${householdId}@test.local`)).rejects.toMatchObject({ code: "WAIT", status: 429 });
  });

  it("locks a code after five wrong tries", async () => {
    await skipCooldown(ids.me);
    const started = await startContactChange(ids.me, `locked-${householdId}@test.local`);
    const wrong = started.devCode === "123456" ? "654321" : "123456";
    for (let i = 0; i < 5; i++) await expect(confirmContactChange(ids.me, wrong)).rejects.toBeInstanceOf(ProfileError);
    await expect(confirmContactChange(ids.me, started.devCode!)).rejects.toMatchObject({ code: "CODE_INVALID" });
    expect((await db.user.findUniqueOrThrow({ where: { id: ids.me } })).email).toBe(emails.me);
  });

  it("adds a phone number the same way, in a standard format", async () => {
    await skipCooldown(ids.me);
    const number = phone();
    const started = await startContactChange(ids.me, `(${number.slice(2, 5)}) ${number.slice(5, 8)}-${number.slice(8)}`);
    expect(started.channel).toBe("SMS");
    const profile = await confirmContactChange(ids.me, started.devCode!);
    expect(profile.phone).toBe(number);
    expect(profile.phoneVerified).toBe(true);
    expect((await outboundTo(number)).length).toBe(1);
  });

  it("a newer request replaces an older one, so an old code stops working", async () => {
    await skipCooldown(ids.family);
    const first = await startContactChange(ids.family, `first-${householdId}@test.local`);
    await skipCooldown(ids.family);
    const second = await startContactChange(ids.family, `second-${householdId}@test.local`);
    await expect(confirmContactChange(ids.family, first.devCode === second.devCode ? "999999" : first.devCode!)).rejects.toMatchObject({ code: "CODE_INVALID" });
    expect((await confirmContactChange(ids.family, second.devCode!)).email).toBe(`second-${householdId}@test.local`);
  });

  it("keeps the audit chain intact", async () => {
    expect((await verifyChainIntegrity(householdId)).ok).toBe(true);
  });
});
