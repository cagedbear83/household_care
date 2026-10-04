import { afterAll, beforeAll, describe, expect, it } from "vitest";
import sharp from "sharp";
import { db } from "../src/db";
import { hashPassword } from "../src/auth/password";
import { checkIn } from "../src/services/authorization.service";
import { verifyChainIntegrity } from "../src/services/event.service";
import { acceptEvidence, issueChallenge } from "../src/services/evidence.service";
import { removeHouseholdFiles } from "../src/services/evidence-store";
import { addComment } from "../src/services/comment.service";
import {
  acceptInvite,
  createInvite,
  getInvitePublic,
  listFamily,
  resendInvite,
  revokeFamilyMember,
  setFamilyVisibility,
  startOtherContact,
  verifyOtherContact,
} from "../src/services/invite.service";
import { getReviewDay } from "../src/services/review.service";
import { completeTask } from "../src/services/task.service";
import { localDateString } from "../src/services/time.service";
import { getMessages, listConversations, listPeople, markRead, sendMessage, startDirect, unreadTotal } from "../src/services/chat.service";
import { normalizePhone } from "../src/services/contact.service";

let householdId: string;
let otherHouseholdId: string;
let ids: { client: string; admin: string; ip: string; otherUser: string };
let taskId: string;
let evidenceId: string;
let localDate: string;

const rand = () => String(Math.floor(1000 + Math.random() * 9000));
const phone = () => `+1312555${rand()}`;
const client = () => ({ userId: ids.client, role: "CLIENT" as const, householdId });
const admin = () => ({ userId: ids.admin, role: "ADMIN" as const, householdId });
const me = (userId: string) => ({ userId, householdId });

async function lastOutbound(to: string) {
  return db.outboundMessage.findFirstOrThrow({ where: { toAddress: to }, orderBy: { createdAt: "desc" } });
}
const tokenFor = async (to: string) => (await lastOutbound(to)).body.match(/invite\?token=([\w-]+)/)![1]!;
const codeFor = async (to: string) => (await lastOutbound(to)).body.match(/\b(\d{6})\b/)![1]!;

async function expectCode(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toMatchObject({ code });
}

/** Runs the whole signup for a family member invited by email and returns their user id. */
async function fullSignup(email: string, newPhone: string, opts: { visibility?: boolean } = {}) {
  await createInvite(client(), { firstName: "Fam", lastName: "Member", email, canViewTimestamps: opts.visibility });
  const token = await tokenFor(email);
  await acceptInvite(token, { firstName: "Fam", lastName: "Member", password: "a-long-password", confirmContact: true });
  await startOtherContact(token, newPhone);
  const done = await verifyOtherContact(token, await codeFor(newPhone));
  return done.user.id;
}

beforeAll(async () => {
  const passwordHash = await hashPassword("test-only-password");
  const h = await db.household.create({ data: { name: "family-test", apartmentLat: 0, apartmentLng: 0 } });
  const other = await db.household.create({ data: { name: "family-test-other", apartmentLat: 0, apartmentLng: 0 } });
  householdId = h.id;
  otherHouseholdId = other.id;
  localDate = localDateString(new Date(), h.timezone);

  const mk = (hid: string, role: "CLIENT" | "ADMIN" | "IP", name: string) =>
    db.user.create({ data: { householdId: hid, role, name, email: `${hid}-${role}@test.local`, passwordHash } });
  const [c, a, ip, o] = await Promise.all([mk(householdId, "CLIENT", "Chris"), mk(householdId, "ADMIN", "Morgan"), mk(householdId, "IP", "Pat"), mk(otherHouseholdId, "CLIENT", "Outsider")]);
  ids = { client: c.id, admin: a.id, ip: ip.id, otherUser: o.id };

  await db.taskTemplate.create({ data: { householdId, groupName: "Kitchen", title: "Clean sink", instructions: "x", frequency: "VISIT", requiresPhoto: true } });
  const now = new Date();
  const shift = await db.scheduledShift.create({
    data: {
      householdId, ipUserId: ids.ip, localDate,
      scheduledStartUtc: new Date(now.getTime() - 5 * 60_000), scheduledEndUtc: new Date(now.getTime() + 6 * 3_600_000),
      status: "SCHEDULED", createdBy: ids.ip,
    },
  });
  await checkIn({ shiftId: shift.id, ipUserId: ids.ip, lat: 0, lng: 0, accuracyMeters: 5 });
  taskId = (await db.taskInstance.findFirstOrThrow({ where: { shiftId: shift.id } })).id;

  const { challengeId } = await issueChallenge(ids.ip, householdId, taskId);
  const jpeg = await sharp({ create: { width: 320, height: 240, channels: 3, background: "#789" } }).jpeg().toBuffer();
  await acceptEvidence({ userId: ids.ip, householdId, taskInstanceId: taskId, challengeId, imageBase64: jpeg.toString("base64"), lat: 0, lng: 0, accuracyMeters: 5 });
  evidenceId = (await db.evidence.findFirstOrThrow({ where: { taskInstanceId: taskId } })).id;
  await completeTask(taskId, ids.ip);
});

afterAll(async () => {
  for (const id of [householdId, otherHouseholdId]) {
    const users = await db.user.findMany({ where: { householdId: id }, select: { id: true } });
    const userIds = users.map((u) => u.id);
    const convs = await db.conversation.findMany({ where: { householdId: id }, select: { id: true } });
    await db.message.deleteMany({ where: { conversationId: { in: convs.map((c) => c.id) } } });
    await db.conversationRead.deleteMany({ where: { userId: { in: userIds } } });
    await db.conversation.deleteMany({ where: { householdId: id } });
    await db.comment.deleteMany({ where: { householdId: id } });
    await db.invite.deleteMany({ where: { householdId: id } });
    await db.outboundMessage.deleteMany({ where: { householdId: id } });
    await db.evidence.deleteMany({ where: { taskInstance: { householdId: id } } });
    await db.captureChallenge.deleteMany({ where: { householdId: id } });
    await db.alertRead.deleteMany({ where: { alert: { householdId: id } } });
    await db.alert.deleteMany({ where: { householdId: id } });
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

describe("phone number handling", () => {
  it("normalizes common US formats and rejects junk", () => {
    expect(normalizePhone("(312) 555-0123")).toBe("+13125550123");
    expect(normalizePhone("1-312-555-0123")).toBe("+13125550123");
    expect(normalizePhone("+44 20 7946 0958")).toBe("+442079460958");
    expect(normalizePhone("12345")).toBeNull();
  });
});

describe("inviting a family member", () => {
  const email = `invitee-${rand()}@test.local`;

  it("needs exactly one of email or phone, and both names", async () => {
    await expectCode(createInvite(client(), { firstName: "A", lastName: "B" }), "CONTACT_REQUIRED");
    await expectCode(createInvite(client(), { firstName: "A", lastName: "B", email, phone: phone() }), "CONTACT_REQUIRED");
    await expectCode(createInvite(client(), { firstName: "A", lastName: "B", email: "not-an-email" }), "INVALID_CONTACT");
    await expectCode(createInvite(client(), { firstName: "A", lastName: "B", phone: "123" }), "INVALID_CONTACT");
    await expectCode(createInvite(client(), { firstName: "", lastName: "B", email }), "INVALID_NAME");
  });

  it("sends the invitation by email with a one-use link, and stores only a hash of it", async () => {
    const { delivery } = await createInvite(client(), { firstName: "Sam", lastName: "Sister", email, relationship: "Sister", canViewTimestamps: true });
    expect(delivery).toMatchObject({ delivered: true, provider: "dev-outbox" });

    const sent = await lastOutbound(email);
    expect(sent).toMatchObject({ channel: "EMAIL", kind: "invite", status: "SENT" });
    const token = await tokenFor(email);
    const invite = await db.invite.findFirstOrThrow({ where: { contact: email } });
    expect(invite.tokenHash).not.toContain(token);
    expect(invite.canViewTimestamps).toBe(true);
  });

  it("will not invite the same person twice, or someone who already has an account", async () => {
    await expectCode(createInvite(client(), { firstName: "Sam", lastName: "Sister", email }), "INVITE_EXISTS");
    await expectCode(createInvite(client(), { firstName: "X", lastName: "Y", email: `${householdId}-CLIENT@test.local` }), "ALREADY_MEMBER");
  });

  it("an administrator can help with setup but cannot grant photo/time access", async () => {
    const e = `admin-invitee-${rand()}@test.local`;
    await createInvite(admin(), { firstName: "Ann", lastName: "Aunt", email: e, canViewTimestamps: true });
    expect((await db.invite.findFirstOrThrow({ where: { contact: e } })).canViewTimestamps).toBe(false);
  });

  it("can go to a phone number as a text message", async () => {
    const p = phone();
    await createInvite(client(), { firstName: "Tex", lastName: "Ting", phone: p });
    expect(await lastOutbound(p)).toMatchObject({ channel: "SMS", kind: "invite" });
    expect((await lastOutbound(p)).body).toMatch(/invite\?token=/);
  });
});

describe("signing up from the invitation", () => {
  const email = `signup-${rand()}@test.local`;
  const second = phone();
  let token: string;

  it("shows what the invitation is for, with the contact masked", async () => {
    await createInvite(client(), { firstName: "Sue", lastName: "Sibling", email });
    token = await tokenFor(email);
    const info = await getInvitePublic(token);
    expect(info).toMatchObject({ stage: "PENDING", inviterName: "Chris", invitedVia: "EMAIL", firstName: "Sue", lastName: "Sibling", otherChannel: "SMS" });
    expect(info.contactMasked).not.toBe(email);
    expect(info.contactMasked).toContain("***@");
    await expectCode(getInvitePublic("not-a-real-token"), "INVITE_INVALID");
  });

  it("requires confirming the contact, a real name and a decent password", async () => {
    const base = { firstName: "Sue", lastName: "Sibling", password: "a-long-password", confirmContact: true };
    await expectCode(acceptInvite(token, { ...base, confirmContact: false }), "CONFIRM_REQUIRED");
    await expectCode(acceptInvite(token, { ...base, firstName: " " }), "INVALID_NAME");
    await expectCode(acceptInvite(token, { ...base, lastName: "" }), "INVALID_NAME");
    await expectCode(acceptInvite(token, { ...base, password: "short" }), "WEAK_PASSWORD");
  });

  it("creates the account but keeps it inactive until the second contact is verified", async () => {
    await acceptInvite(token, { firstName: "Susan", lastName: "Sibling-Smith", password: "a-long-password", confirmContact: true });
    const user = await db.user.findFirstOrThrow({ where: { email } });
    expect(user).toMatchObject({ role: "FAMILY", active: false, name: "Susan Sibling-Smith", firstName: "Susan", lastName: "Sibling-Smith", phone: null });
    expect(user.emailVerifiedAt).not.toBeNull();
    expect(user.passwordHash).not.toContain("a-long-password");
    expect((await getInvitePublic(token)).stage).toBe("ACCEPTED");
    await expectCode(acceptInvite(token, { firstName: "S", lastName: "S", password: "a-long-password", confirmContact: true }), "ALREADY_ACCEPTED");
  });

  it("requires the OTHER kind of contact, not already used by someone else", async () => {
    await expectCode(startOtherContact(token, "someone@test.local"), "INVALID_CONTACT"); // the invite used email, so a phone is needed
    await expectCode(startOtherContact(token, "12345"), "INVALID_CONTACT");
    const taken = phone();
    await db.user.update({ where: { id: ids.ip }, data: { phone: taken } });
    await expectCode(startOtherContact(token, taken), "ALREADY_IN_USE");
    await db.user.update({ where: { id: ids.ip }, data: { phone: null } });
  });

  it("texts a 6-digit code, limits how fast another can be requested, and limits wrong guesses", async () => {
    const sent = await startOtherContact(token, second);
    expect(sent.sent).toBe(true);
    expect(await lastOutbound(second)).toMatchObject({ channel: "SMS", kind: "verification" });
    expect(sent.devCode).toMatch(/^\d{6}$/);
    await expectCode(startOtherContact(token, second), "TOO_SOON");

    const wrong = sent.devCode === "000000" ? "111111" : "000000";
    await expectCode(verifyOtherContact(token, wrong), "INVALID_CODE");
    for (let i = 0; i < 4; i++) await expect(verifyOtherContact(token, wrong)).rejects.toBeDefined();
    // Five wrong guesses: even the correct code is now refused until a new one is requested.
    await expectCode(verifyOtherContact(token, sent.devCode!), "TOO_MANY_ATTEMPTS");
  });

  it("activates the account and signs them in once the code is right", async () => {
    await db.invite.updateMany({ where: { contact: email }, data: { pendingCodeSentAt: new Date(Date.now() - 60_000) } }); // past the cooldown
    const again = await startOtherContact(token, second);
    const result = await verifyOtherContact(token, again.devCode!);

    expect(result.token).toBeTruthy();
    expect(result.user).toMatchObject({ role: "FAMILY", name: "Susan Sibling-Smith" });
    const user = await db.user.findFirstOrThrow({ where: { email } });
    expect(user).toMatchObject({ active: true, phone: second });
    expect(user.phoneVerifiedAt).not.toBeNull();
    expect(user.emailVerifiedAt).not.toBeNull();
    expect(user.activatedAt).not.toBeNull();
    expect((await db.invite.findFirstOrThrow({ where: { contact: email } })).status).toBe("COMPLETED");
  });

  it("the link stops working once signup is complete", async () => {
    await expectCode(getInvitePublic(token), "INVITE_INVALID");
    await expectCode(verifyOtherContact(token, "123456"), "INVITE_INVALID");
  });
});

describe("signing up from a text-message invitation", () => {
  it("confirms the phone, then adds and verifies an email", async () => {
    const p = phone();
    const e = `second-${rand()}@test.local`;
    await createInvite(client(), { firstName: "Pat", lastName: "Phone", phone: p });
    const token = await tokenFor(p);
    expect(await getInvitePublic(token)).toMatchObject({ invitedVia: "SMS", otherChannel: "EMAIL" });

    await acceptInvite(token, { firstName: "Pat", lastName: "Phone", password: "a-long-password", confirmContact: true });
    expect(await db.user.findFirstOrThrow({ where: { phone: p } })).toMatchObject({ email: null, active: false });

    const sent = await startOtherContact(token, e);
    expect(await lastOutbound(e)).toMatchObject({ channel: "EMAIL", kind: "verification" });
    await verifyOtherContact(token, sent.devCode!);
    expect(await db.user.findFirstOrThrow({ where: { phone: p } })).toMatchObject({ email: e, active: true });
  });
});

describe("resending, turning access off, and approvals", () => {
  it("a resent invitation replaces the old link", async () => {
    const e = `resend-${rand()}@test.local`;
    await createInvite(client(), { firstName: "Re", lastName: "Send", email: e });
    const oldToken = await tokenFor(e);
    const { id } = await db.invite.findFirstOrThrow({ where: { contact: e } });
    await resendInvite(client(), id);
    const newToken = await tokenFor(e);
    expect(newToken).not.toBe(oldToken);
    await expectCode(getInvitePublic(oldToken), "INVITE_INVALID");
    expect((await getInvitePublic(newToken)).stage).toBe("PENDING");
  });

  it("an expired link is refused", async () => {
    const e = `expired-${rand()}@test.local`;
    await createInvite(client(), { firstName: "Ex", lastName: "Pired", email: e });
    const token = await tokenFor(e);
    await db.invite.updateMany({ where: { contact: e }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await expectCode(getInvitePublic(token), "INVITE_INVALID");
    expect((await listFamily(householdId)).find((f) => f.email === e)?.status).toBe("EXPIRED");
  });

  it("turning access off takes effect immediately, kills the link, and cannot be repeated", async () => {
    const e = `revoke-${rand()}@test.local`;
    const userId = await fullSignup(e, phone());
    const entry = (await listFamily(householdId)).find((f) => f.email === e)!;
    expect(entry.status).toBe("ACTIVE");

    await revokeFamilyMember(client(), entry.id);
    expect((await db.user.findUniqueOrThrow({ where: { id: userId } })).accessRevokedAt).not.toBeNull();
    expect((await listFamily(householdId)).find((f) => f.email === e)?.status).toBe("REVOKED");
    await expectCode(revokeFamilyMember(client(), entry.id), "ALREADY_REVOKED");
    await expectCode(resendInvite(client(), entry.id), "INVALID_STATE");
  });

  it("the client approves (or withdraws) photo and time access", async () => {
    const e = `approve-${rand()}@test.local`;
    const userId = await fullSignup(e, phone());
    const entry = (await listFamily(householdId)).find((f) => f.email === e)!;
    expect(entry.canViewTimestamps).toBe(false);

    await setFamilyVisibility(client(), entry.id, true);
    expect((await db.user.findUniqueOrThrow({ where: { id: userId } })).canViewTimestamps).toBe(true);
    await setFamilyVisibility(client(), entry.id, false);
    expect((await db.user.findUniqueOrThrow({ where: { id: userId } })).canViewTimestamps).toBe(false);
  });

  it("is limited to the household", async () => {
    const e = `scoped-${rand()}@test.local`;
    await createInvite(client(), { firstName: "Sc", lastName: "Oped", email: e });
    const { id } = await db.invite.findFirstOrThrow({ where: { contact: e } });
    const outsider = { userId: ids.otherUser, role: "CLIENT" as const, householdId: otherHouseholdId };
    await expectCode(resendInvite(outsider, id), "NOT_FOUND");
    await expectCode(revokeFamilyMember(outsider, id), "NOT_FOUND");
    expect(await listFamily(otherHouseholdId)).toHaveLength(0);
  });
});

describe("what a family member can see", () => {
  const unapproved = { role: "FAMILY" as const, canViewTimestamps: false };
  const approved = { role: "FAMILY" as const, canViewTimestamps: true };

  it("sees status and history but no times and no photos without the client's approval", async () => {
    const [shift] = await getReviewDay(householdId, localDate, unapproved);
    expect(shift!.observedCheckInUtc).toBeNull();
    expect(shift!.checkedIn).toBe(true); // that they came is status; when they came is a timestamp
    const task = shift!.tasks[0]!;
    expect(task.state).toBe("COMPLETED_AWAITING_REVIEW");
    expect(task.photoCount).toBe(1);
    expect(task.evidence).toEqual([]);
    expect(task.history.length).toBeGreaterThan(0);
    expect(task.history.every((h) => h.at === null)).toBe(true);
  });

  it("sees photos and times once approved", async () => {
    const [shift] = await getReviewDay(householdId, localDate, approved);
    expect(shift!.observedCheckInUtc).not.toBeNull();
    const task = shift!.tasks[0]!;
    expect(task.evidence).toHaveLength(1);
    expect(task.history.every((h) => h.at !== null)).toBe(true);
  });
});

describe("comments", () => {
  let famApproved: string;
  let famPlain: string;
  beforeAll(async () => {
    famApproved = await fullSignup(`approved-${rand()}@test.local`, phone(), { visibility: true });
    famPlain = await fullSignup(`plain-${rand()}@test.local`, phone());
  });
  const familyUnapproved = () => ({ userId: famPlain, householdId, role: "FAMILY" as const, canViewTimestamps: false });
  const familyApproved = () => ({ userId: famApproved, householdId, role: "FAMILY" as const, canViewTimestamps: true });

  it("family can comment on a task that is complete or not", async () => {
    const task = await addComment(familyUnapproved(), taskId, "  Thank you for doing this!  ");
    expect(task.comments).toHaveLength(1);
    expect(task.comments[0]).toMatchObject({ body: "Thank you for doing this!", evidenceId: null, at: null });

    const notDone = await db.taskInstance.create({
      data: { householdId, shiftId: (await db.taskInstance.findUniqueOrThrow({ where: { id: taskId } })).shiftId, templateId: (await db.taskTemplate.findFirstOrThrow({ where: { householdId } })).id, assignedDate: localDate, titleSnapshot: "Open task", instructionsSnapshot: "x", requiresPhotoSnapshot: false },
    });
    expect((await addComment(familyUnapproved(), notDone.id, "Is this still planned?")).comments).toHaveLength(1);
  });

  it("a photo comment needs approval to see photos, and the photo must belong to the task", async () => {
    await expectCode(addComment(familyUnapproved(), taskId, "Nice sink", evidenceId), "FORBIDDEN");
    const withPhoto = await addComment(familyApproved(), taskId, "Looks great", evidenceId);
    expect(withPhoto.comments.find((c) => c.evidenceId === evidenceId)).toMatchObject({ body: "Looks great", authorRoleLabel: "Family" });

    const otherTask = await db.taskInstance.findFirstOrThrow({ where: { householdId, id: { not: taskId } } });
    await expectCode(addComment(familyApproved(), otherTask.id, "x", evidenceId), "NOT_FOUND");
  });

  it("photo comments are hidden from someone who cannot see photos", async () => {
    const [shift] = await getReviewDay(householdId, localDate, { role: "FAMILY", canViewTimestamps: false });
    const task = shift!.tasks.find((t) => t.id === taskId)!;
    expect(task.comments.every((c) => c.evidenceId === null)).toBe(true);
    const [full] = await getReviewDay(householdId, localDate, { role: "CLIENT", canViewTimestamps: true });
    expect(full!.tasks.find((t) => t.id === taskId)!.comments.some((c) => c.evidenceId === evidenceId)).toBe(true);
  });

  it("IPs cannot comment, empty or oversized comments are refused, and other households cannot reach the task", async () => {
    await expectCode(addComment({ userId: ids.ip, householdId, role: "IP", canViewTimestamps: false }, taskId, "hi"), "FORBIDDEN");
    await expectCode(addComment(client() as never, taskId, "   "), "INVALID_BODY");
    await expectCode(addComment({ ...client(), canViewTimestamps: true }, taskId, "x".repeat(2001)), "INVALID_BODY");
    await expectCode(addComment({ userId: ids.otherUser, householdId: otherHouseholdId, role: "CLIENT", canViewTimestamps: true }, taskId, "hi"), "NOT_FOUND");
  });

  it("each comment is recorded as an audit event", async () => {
    expect(await db.event.count({ where: { householdId, action: "comment_added" } })).toBeGreaterThanOrEqual(3);
  });
});

describe("chat", () => {
  let familyId: string;
  const otherMe = () => ({ userId: ids.otherUser, householdId: otherHouseholdId });

  it("everyone in the household can see each other, and nobody from another household", async () => {
    const people = await listPeople(me(ids.ip));
    const names = people.map((p) => p.name);
    expect(names).toContain("Chris");
    expect(names).toContain("Morgan");
    expect(names).not.toContain("Outsider");
    expect(people.find((p) => p.name === "Morgan")?.roleLabel).toBe("Administrator (Case Manager)");
    expect(people.find((p) => p.name === "Chris")?.roleLabel).toBe("Client");
  });

  it("the group chat reaches everyone, with unread counts that clear when read", async () => {
    const group = (await listConversations(me(ids.client))).find((c) => c.kind === "GROUP")!;
    await sendMessage(me(ids.ip), group.id, "  Good morning everyone  ");
    await sendMessage(me(ids.admin), group.id, "Morning!");

    const msgs = await getMessages(me(ids.client), group.id);
    expect(msgs.map((m) => m.body)).toEqual(["Good morning everyone", "Morning!"]);
    expect(msgs[0]).toMatchObject({ senderName: "Pat", senderRoleLabel: "Individual Provider", mine: false });

    expect(await unreadTotal(me(ids.client))).toBe(2);
    expect(await unreadTotal(me(ids.ip))).toBe(1); // their own message does not count
    await markRead(me(ids.client), group.id);
    expect(await unreadTotal(me(ids.client))).toBe(0);
  });

  it("a person who joins later does not see earlier group messages", async () => {
    familyId = await fullSignup(`joiner-${rand()}@test.local`, phone()); // activated after the messages above
    const group = (await listConversations(me(familyId))).find((c) => c.kind === "GROUP")!;
    expect(await getMessages(me(familyId), group.id)).toEqual([]);
    expect(await unreadTotal(me(familyId))).toBe(0);
    await sendMessage(me(familyId), group.id, "Hi, I just joined");
    expect((await getMessages(me(ids.client), group.id)).at(-1)?.body).toBe("Hi, I just joined");
  });

  it("direct messages are one conversation per pair and private to the two people", async () => {
    const a = await startDirect(me(ids.ip), familyId);
    const b = await startDirect(me(familyId), ids.ip);
    expect(a.id).toBe(b.id);

    await sendMessage(me(ids.ip), a.id, "Hello, I am Pat");
    expect((await getMessages(me(familyId), a.id)).map((m) => m.body)).toEqual(["Hello, I am Pat"]);

    await expect(getMessages(me(ids.client), a.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(sendMessage(me(ids.admin), a.id, "snooping")).rejects.toMatchObject({ code: "NOT_FOUND" });

    const forFamily = (await listConversations(me(familyId))).find((c) => c.id === a.id)!;
    expect(forFamily).toMatchObject({ kind: "DIRECT", title: "Pat", subtitle: "Individual Provider", unread: 1 });
    expect((await listConversations(me(ids.client))).some((c) => c.id === a.id)).toBe(false);
  });

  it("cannot message yourself, someone from another household, or someone whose access is off", async () => {
    await expect(startDirect(me(ids.ip), ids.ip)).rejects.toMatchObject({ code: "INVALID" });
    await expect(startDirect(me(ids.ip), ids.otherUser)).rejects.toMatchObject({ code: "NOT_FOUND" });

    const dm = await startDirect(me(ids.client), familyId);
    await db.user.update({ where: { id: familyId }, data: { accessRevokedAt: new Date() } });
    await expect(sendMessage(me(ids.client), dm.id, "still there?")).rejects.toMatchObject({ code: "RECIPIENT_UNAVAILABLE" });
    await expect(sendMessage(me(familyId), dm.id, "hi")).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await listPeople(me(ids.client))).some((p) => p.id === familyId)).toBe(false);
    await db.user.update({ where: { id: familyId }, data: { accessRevokedAt: null } });
  });

  it("returns only newer messages when given a cursor, and refuses empty or oversized messages", async () => {
    const group = (await listConversations(me(ids.client))).find((c) => c.kind === "GROUP")!;
    const all = await getMessages(me(ids.client), group.id);
    const newer = await getMessages(me(ids.client), group.id, { afterId: all[0]!.id });
    expect(newer.map((m) => m.id)).toEqual(all.slice(1).map((m) => m.id));
    expect(await getMessages(me(ids.client), group.id, { afterId: all.at(-1)!.id })).toEqual([]);

    await expect(sendMessage(me(ids.client), group.id, "   ")).rejects.toMatchObject({ code: "INVALID_BODY" });
    await expect(sendMessage(me(ids.client), group.id, "x".repeat(2001))).rejects.toMatchObject({ code: "INVALID_BODY" });
  });

  it("another household's group chat is separate", async () => {
    const theirs = (await listConversations(otherMe())).find((c) => c.kind === "GROUP")!;
    expect(await getMessages(otherMe(), theirs.id)).toEqual([]);
    const ours = (await listConversations(me(ids.client))).find((c) => c.kind === "GROUP")!;
    expect(theirs.id).not.toBe(ours.id);
    await expect(getMessages(otherMe(), ours.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("the audit log", () => {
  it("records invitations, signups and approvals, and stays intact", async () => {
    const actions = (await db.event.findMany({ where: { householdId, action: { startsWith: "family_" } }, select: { action: true } })).map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(["family_invited", "family_invite_accepted", "family_onboarding_completed", "family_revoked", "family_visibility_changed", "family_invite_resent"]));
    expect(await verifyChainIntegrity(householdId)).toEqual({ ok: true });
  });

  it("never stores a full email or phone number in the audit log", async () => {
    const invited = await db.event.findMany({ where: { householdId, action: "family_invited" } });
    expect(invited.length).toBeGreaterThan(0);
    for (const e of invited) {
      const payload = e.payload as { contact: string; inviteId: string };
      const real = await db.invite.findFirstOrThrow({ where: { id: payload.inviteId } });
      expect(payload.contact).toMatch(/[*•]/);
      expect(payload.contact).not.toBe(real.contact);
    }
  });
});
