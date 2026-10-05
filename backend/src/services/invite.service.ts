import { createHash, randomBytes, randomInt, timingSafeEqual } from "crypto";
import { Prisma, type ContactChannel, type Invite, type Role } from "@prisma/client";
import { db } from "../db";
import { hashPassword } from "../auth/password";
import { signAuthToken } from "../auth/jwt";
import { sessionUser } from "../auth/effective-role";
import { ensurePrimaryFamily } from "./primary-family.service";
import { appendEvent } from "./event.service";
import { maskContact, normalizeEmail, normalizePhone } from "./contact.service";
import { devOutboxEnabled, sendMessage } from "./notify.service";

export class InviteError extends Error {
  constructor(public code: string, message: string, public status = 409) {
    super(message);
  }
}

export interface InviteActor {
  userId: string;
  role: Role;
  householdId: string;
}

const INVITE_DAYS = 7;
const CODE_MINUTES = 10;
const CODE_COOLDOWN_SECONDS = 30;
const MAX_CODE_ATTEMPTS = 5;
const MIN_PASSWORD_LENGTH = 10;

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const newToken = () => randomBytes(32).toString("base64url");
const appBase = () => (process.env.APP_BASE_URL ?? "http://localhost:8081").replace(/\/$/, "");
const inviteLink = (token: string) => `${appBase()}/invite?token=${token}`;
const expiry = () => new Date(Date.now() + INVITE_DAYS * 24 * 3_600_000);

function parseContact(channel: ContactChannel, raw: string): string {
  const value = channel === "EMAIL" ? normalizeEmail(raw) : normalizePhone(raw);
  if (!value) {
    throw new InviteError(
      "INVALID_CONTACT",
      channel === "EMAIL" ? "Enter a valid email address." : "Enter a valid phone number (10 digits, or start with + and the country code).",
      400
    );
  }
  return value;
}

function cleanName(value: string, label: string): string {
  const trimmed = value.trim().replace(/\s+/g, " ");
  if (trimmed.length < 1 || trimmed.length > 60) throw new InviteError("INVALID_NAME", `Enter ${label} (up to 60 characters).`, 400);
  return trimmed;
}

async function contactInUse(channel: ContactChannel, value: string, exceptUserId?: string) {
  const user = await db.user.findFirst({
    // Email addresses are compared without regard to capitalization.
    where: {
      ...(channel === "EMAIL" ? { email: { equals: value, mode: "insensitive" as const } } : { phone: value }),
      ...(exceptUserId ? { id: { not: exceptUserId } } : {}),
    },
    select: { id: true },
  });
  return Boolean(user);
}

async function deliverInvite(invite: Invite, token: string, inviterName: string) {
  const link = inviteLink(token);
  const sent = await sendMessage(
    invite.channel === "EMAIL"
      ? {
          householdId: invite.householdId,
          channel: "EMAIL",
          to: invite.contact,
          subject: "You're invited to Household Care",
          body: `${inviterName} invited you to join Household Care as a family member.\n\nOpen this link to set up your account. It works once and expires in ${INVITE_DAYS} days:\n${link}\n\nIf you were not expecting this, you can ignore this message.`,
          kind: "invite",
        }
      : {
          householdId: invite.householdId,
          channel: "SMS",
          to: invite.contact,
          body: `Household Care: ${inviterName} invited you as a family member. Set up your account (link expires in ${INVITE_DAYS} days): ${link}`,
          kind: "invite",
        }
  );
  // Handing the link back is only for development, where nothing is really sent.
  return { delivered: sent.delivered, provider: sent.provider, devLink: devOutboxEnabled() && sent.provider === "dev-outbox" ? link : undefined };
}

export interface CreateInviteInput {
  firstName: string;
  lastName: string;
  email?: string;
  phone?: string;
  relationship?: string;
  canViewTimestamps?: boolean;
}

/**
 * The client (or an administrator helping with setup) adds a family member by
 * email address OR phone number; the invite goes to that one contact. Only the
 * client can approve photo/time access, so an administrator's invite never grants it.
 */
export async function createInvite(actor: InviteActor, input: CreateInviteInput) {
  const hasEmail = Boolean(input.email?.trim());
  const hasPhone = Boolean(input.phone?.trim());
  if (hasEmail === hasPhone) {
    throw new InviteError("CONTACT_REQUIRED", "Enter either an email address or a phone number for the invitation.", 400);
  }
  const channel: ContactChannel = hasEmail ? "EMAIL" : "SMS";
  const contact = parseContact(channel, (hasEmail ? input.email : input.phone)!);
  const firstName = cleanName(input.firstName, "a first name");
  const lastName = cleanName(input.lastName, "a last name");

  if (await contactInUse(channel, contact)) {
    throw new InviteError("ALREADY_MEMBER", "Someone with that email or phone number already has an account.");
  }
  const open = await db.invite.findFirst({
    where: { householdId: actor.householdId, contact, status: { in: ["PENDING", "ACCEPTED"] } },
    select: { id: true },
  });
  if (open) throw new InviteError("INVITE_EXISTS", "That person has already been invited. Use Resend on their entry instead.");

  const token = newToken();
  const invite = await db.$transaction(async (tx) => {
    const created = await tx.invite.create({
      data: {
        householdId: actor.householdId,
        invitedByUserId: actor.userId,
        channel,
        contact,
        firstName,
        lastName,
        relationship: input.relationship?.trim().slice(0, 40) || null,
        canViewTimestamps: actor.role === "CLIENT" ? Boolean(input.canViewTimestamps) : false,
        tokenHash: sha(token),
        expiresAt: expiry(),
      },
    });
    await appendEvent(tx, {
      householdId: actor.householdId,
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: "family_invited",
      payload: { inviteId: created.id, channel, contact: maskContact(channel, contact), canViewTimestamps: created.canViewTimestamps },
    });
    return created;
  });

  const inviter = await db.user.findUniqueOrThrow({ where: { id: actor.userId }, select: { name: true } });
  return { invite, delivery: await deliverInvite(invite, token, inviter.name) };
}

/** New link (the old one stops working) and a fresh 7 days. Also used when someone stalled before finishing. */
export async function resendInvite(actor: InviteActor, inviteId: string) {
  const existing = await db.invite.findFirst({ where: { id: inviteId, householdId: actor.householdId } });
  if (!existing) throw new InviteError("NOT_FOUND", "Invitation not found.", 404);
  if (existing.status !== "PENDING" && existing.status !== "ACCEPTED") {
    throw new InviteError("INVALID_STATE", "This person has already finished signing up, or their access was turned off.");
  }

  const token = newToken();
  const invite = await db.$transaction(async (tx) => {
    const updated = await tx.invite.update({ where: { id: existing.id }, data: { tokenHash: sha(token), expiresAt: expiry() } });
    await appendEvent(tx, {
      householdId: actor.householdId,
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: "family_invite_resent",
      payload: { inviteId: existing.id },
    });
    return updated;
  });
  const inviter = await db.user.findUniqueOrThrow({ where: { id: actor.userId }, select: { name: true } });
  return { invite, delivery: await deliverInvite(invite, token, inviter.name) };
}

/** Turns access off immediately (the auth check reads this on every request). Client only; enforced by the route. */
export async function revokeFamilyMember(actor: InviteActor, inviteId: string, rawReason?: string) {
  return db.$transaction(async (tx) => {
    const invite = await tx.invite.findFirst({ where: { id: inviteId, householdId: actor.householdId } });
    if (!invite) throw new InviteError("NOT_FOUND", "Invitation not found.", 404);
    if (invite.status === "REVOKED") throw new InviteError("ALREADY_REVOKED", "Access is already turned off.");

    const person = invite.userId ? await tx.user.findUnique({ where: { id: invite.userId } }) : null;
    const isPrimary = Boolean(person?.isPrimaryFamily);
    // The primary family member cannot be removed by the client or by themselves; only an administrator can, with a reason.
    // Everyone else is the client's to turn off, not an administrator's.
    if (isPrimary && actor.role !== "ADMIN") {
      throw new InviteError("PRIMARY_PROTECTED", "The primary family member can only be changed by an administrator.", 403);
    }
    if (!isPrimary && actor.role === "ADMIN") {
      throw new InviteError("FORBIDDEN", "Only the client controls family access.", 403);
    }
    const reason = (rawReason ?? "").replace(/[ -]/g, "").trim();
    if (isPrimary && reason.length < 3) throw new InviteError("REASON_REQUIRED", "Say why (a few words at least).", 400);

    await tx.invite.update({ where: { id: invite.id }, data: { status: "REVOKED", revokedAt: new Date() } });
    if (invite.userId) await tx.user.update({ where: { id: invite.userId }, data: { accessRevokedAt: new Date() } });
    await appendEvent(tx, {
      householdId: actor.householdId,
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: "family_revoked",
      payload: { inviteId: invite.id, userId: invite.userId, ...(isPrimary ? { wasPrimary: true, reason } : {}) },
    });
    // Someone else steps up if there is anyone (the earliest to have activated).
    if (isPrimary) await ensurePrimaryFamily(tx, actor.householdId);
  });
}

/** The client's explicit approval for a family member to see photos and times. */
export async function setFamilyVisibility(actor: InviteActor, inviteId: string, canViewTimestamps: boolean) {
  return db.$transaction(async (tx) => {
    const invite = await tx.invite.findFirst({ where: { id: inviteId, householdId: actor.householdId } });
    if (!invite) throw new InviteError("NOT_FOUND", "Invitation not found.", 404);
    await tx.invite.update({ where: { id: invite.id }, data: { canViewTimestamps } });
    if (invite.userId) await tx.user.update({ where: { id: invite.userId }, data: { canViewTimestamps } });
    await appendEvent(tx, {
      householdId: actor.householdId,
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: "family_visibility_changed",
      payload: { inviteId: invite.id, canViewTimestamps },
    });
  });
}

export type FamilyStatus = "INVITED" | "EXPIRED" | "NEEDS_SECOND_CONTACT" | "ACTIVE" | "REVOKED";

export async function listFamily(householdId: string) {
  const invites = await db.invite.findMany({ where: { householdId }, orderBy: { createdAt: "asc" } });
  const accountIds = invites.map((i) => i.userId).filter((id): id is string => id !== null);
  const accounts = await db.user.findMany({
    where: { id: { in: accountIds } },
    select: { id: true, email: true, phone: true, emailVerifiedAt: true, phoneVerifiedAt: true, isPrimaryFamily: true },
  });
  const byId = new Map(accounts.map((u) => [u.id, u]));
  const inviterRows = await db.user.findMany({
    where: { id: { in: [...new Set(invites.map((i) => i.invitedByUserId))] } },
    select: { id: true, name: true },
  });
  const inviters = new Map(inviterRows.map((u) => [u.id, u.name]));

  return invites.map((i) => {
    const status: FamilyStatus =
      i.status === "REVOKED" ? "REVOKED" : i.status === "COMPLETED" ? "ACTIVE" : i.status === "ACCEPTED" ? "NEEDS_SECOND_CONTACT" : i.expiresAt < new Date() ? "EXPIRED" : "INVITED";
    const u = i.userId ? byId.get(i.userId) : undefined;
    return {
      id: i.id,
      name: `${i.firstName} ${i.lastName}`,
      relationship: i.relationship,
      status,
      invitedVia: i.channel,
      email: u?.email ?? (i.channel === "EMAIL" ? i.contact : null),
      phone: u?.phone ?? (i.channel === "SMS" ? i.contact : null),
      emailVerified: Boolean(u?.emailVerifiedAt),
      phoneVerified: Boolean(u?.phoneVerifiedAt),
      canViewTimestamps: i.canViewTimestamps,
      userId: i.userId,
      isPrimary: Boolean(u?.isPrimaryFamily),
      invitedBy: inviters.get(i.invitedByUserId) ?? null,
      createdAt: i.createdAt,
    };
  });
}

// --- The family member's side (public, token-authorized) ----------------------

async function loadByToken(token: string): Promise<Invite> {
  const invite = await db.invite.findUnique({ where: { tokenHash: sha(token) } });
  // One generic answer whether the link is unknown, expired, used up or revoked.
  if (!invite || invite.status === "REVOKED" || invite.status === "COMPLETED" || invite.expiresAt < new Date()) {
    throw new InviteError("INVITE_INVALID", "This invitation link is no longer valid. Ask the person who invited you to send a new one.", 404);
  }
  return invite;
}

const otherChannel = (c: ContactChannel): ContactChannel => (c === "EMAIL" ? "SMS" : "EMAIL");

export async function getInvitePublic(token: string) {
  const invite = await loadByToken(token);
  const inviter = await db.user.findUnique({ where: { id: invite.invitedByUserId }, select: { name: true } });
  return {
    stage: invite.status as "PENDING" | "ACCEPTED",
    inviterName: inviter?.name ?? "Someone",
    invitedVia: invite.channel,
    contactMasked: maskContact(invite.channel, invite.contact),
    firstName: invite.firstName,
    lastName: invite.lastName,
    otherChannel: otherChannel(invite.channel),
    pendingContactMasked: invite.pendingContact ? maskContact(otherChannel(invite.channel), invite.pendingContact) : null,
  };
}

export interface AcceptInput {
  firstName: string;
  lastName: string;
  password: string;
  confirmContact: boolean;
}

/**
 * Step 1: the person confirms their first and last name, confirms that the
 * email/phone the invitation reached is theirs (opening the link already
 * proved they received it), and chooses a password. The account exists but
 * stays inactive until the second contact is verified.
 */
export async function acceptInvite(token: string, input: AcceptInput) {
  const invite = await loadByToken(token);
  if (invite.status !== "PENDING") throw new InviteError("ALREADY_ACCEPTED", "You have already started signing up. Continue with the next step.");
  if (!input.confirmContact) {
    throw new InviteError("CONFIRM_REQUIRED", `Please confirm that this ${invite.channel === "EMAIL" ? "email address" : "phone number"} is yours.`, 400);
  }
  const firstName = cleanName(input.firstName, "your first name");
  const lastName = cleanName(input.lastName, "your last name");
  if (input.password.length < MIN_PASSWORD_LENGTH) {
    throw new InviteError("WEAK_PASSWORD", `Choose a password of at least ${MIN_PASSWORD_LENGTH} characters.`, 400);
  }
  const passwordHash = await hashPassword(input.password);
  const now = new Date();

  try {
    return await db.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          householdId: invite.householdId,
          role: "FAMILY",
          name: `${firstName} ${lastName}`,
          firstName,
          lastName,
          relationship: invite.relationship,
          ...(invite.channel === "EMAIL" ? { email: invite.contact, emailVerifiedAt: now } : { phone: invite.contact, phoneVerifiedAt: now }),
          passwordHash,
          active: false, // cannot sign in until both contacts are verified
          canViewTimestamps: invite.canViewTimestamps,
        },
      });
      await tx.invite.update({ where: { id: invite.id }, data: { status: "ACCEPTED", userId: user.id, acceptedAt: now, firstName, lastName } });
      await appendEvent(tx, {
        householdId: invite.householdId,
        actorUserId: user.id,
        actorRole: "FAMILY",
        action: "family_invite_accepted",
        payload: { inviteId: invite.id, confirmedContactChannel: invite.channel },
      });
      return { stage: "ACCEPTED" as const, otherChannel: otherChannel(invite.channel) };
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      throw new InviteError("ALREADY_MEMBER", "An account with that email or phone number already exists.");
    }
    throw err;
  }
}

/** Step 2: add the contact that was NOT used for the invitation; a 6-digit code is sent to it. */
export async function startOtherContact(token: string, rawValue: string) {
  const invite = await loadByToken(token);
  if (invite.status !== "ACCEPTED" || !invite.userId) throw new InviteError("WRONG_STEP", "Finish the first step before adding another contact.");

  const channel = otherChannel(invite.channel);
  const value = parseContact(channel, rawValue);
  if (await contactInUse(channel, value, invite.userId)) {
    throw new InviteError("ALREADY_IN_USE", `That ${channel === "EMAIL" ? "email address" : "phone number"} already belongs to another account.`);
  }

  if (invite.pendingContact === value && invite.pendingCodeSentAt) {
    const waited = (Date.now() - invite.pendingCodeSentAt.getTime()) / 1000;
    if (waited < CODE_COOLDOWN_SECONDS) {
      throw new InviteError("TOO_SOON", `A code was just sent. You can ask for another in ${Math.ceil(CODE_COOLDOWN_SECONDS - waited)} seconds.`, 429);
    }
  }

  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  await db.invite.update({
    where: { id: invite.id },
    data: {
      pendingContact: value,
      pendingCodeHash: sha(`${invite.id}:${code}`),
      pendingCodeExpiresAt: new Date(Date.now() + CODE_MINUTES * 60_000),
      pendingCodeSentAt: new Date(),
      pendingCodeAttempts: 0,
    },
  });

  const sent = await sendMessage({
    householdId: invite.householdId,
    channel,
    to: value,
    subject: channel === "EMAIL" ? "Your Household Care verification code" : undefined,
    body: `Your Household Care verification code is ${code}. It expires in ${CODE_MINUTES} minutes. If you did not ask for it, ignore this message.`,
    kind: "verification",
  });
  return {
    sent: sent.delivered,
    sentToMasked: maskContact(channel, value),
    // Development only: with no provider configured nothing is really sent, so show the code.
    devCode: devOutboxEnabled() && sent.provider === "dev-outbox" ? code : undefined,
  };
}

/** Step 3: the code proves the second contact. Both contacts verified -> the account is activated and signed in. */
export async function verifyOtherContact(token: string, code: string) {
  const invite = await loadByToken(token);
  if (invite.status !== "ACCEPTED" || !invite.userId) throw new InviteError("WRONG_STEP", "There is nothing to verify yet.");
  if (!invite.pendingContact || !invite.pendingCodeHash || !invite.pendingCodeExpiresAt || invite.pendingCodeExpiresAt < new Date()) {
    throw new InviteError("CODE_EXPIRED", "That code has expired. Ask for a new one.");
  }
  if (invite.pendingCodeAttempts >= MAX_CODE_ATTEMPTS) {
    throw new InviteError("TOO_MANY_ATTEMPTS", "Too many wrong codes. Ask for a new code.", 429);
  }

  const given = Buffer.from(sha(`${invite.id}:${code.trim()}`));
  const expected = Buffer.from(invite.pendingCodeHash);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    const attempts = invite.pendingCodeAttempts + 1;
    await db.invite.update({ where: { id: invite.id }, data: { pendingCodeAttempts: attempts } });
    throw new InviteError("INVALID_CODE", `That code is not right. ${Math.max(0, MAX_CODE_ATTEMPTS - attempts)} tries left.`);
  }

  const channel = otherChannel(invite.channel);
  const now = new Date();
  try {
    const user = await db.$transaction(async (tx) => {
      const updated = await tx.user.update({
        where: { id: invite.userId! },
        data: {
          ...(channel === "EMAIL" ? { email: invite.pendingContact, emailVerifiedAt: now } : { phone: invite.pendingContact, phoneVerifiedAt: now }),
          active: true,
          activatedAt: now,
        },
      });
      await tx.invite.update({
        where: { id: invite.id },
        data: { status: "COMPLETED", completedAt: now, pendingCodeHash: null, pendingCodeExpiresAt: null },
      });
      await appendEvent(tx, {
        householdId: invite.householdId,
        actorUserId: updated.id,
        actorRole: "FAMILY",
        action: "family_onboarding_completed",
        payload: { inviteId: invite.id, secondContactChannel: channel },
      });
      // The first family member to finish becomes the primary one (the same access as the client).
      await ensurePrimaryFamily(tx, invite.householdId);
      return tx.user.findUniqueOrThrow({ where: { id: updated.id } });
    });
    return {
      token: signAuthToken({ userId: user.id, householdId: user.householdId, role: user.role }),
      user: sessionUser(user),
    };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      throw new InviteError("ALREADY_IN_USE", "That contact was just claimed by another account. Use a different one.");
    }
    throw err;
  }
}
