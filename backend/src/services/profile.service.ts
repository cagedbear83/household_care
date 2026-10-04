import { createHash, randomInt, randomUUID, timingSafeEqual } from "crypto";
import type { ContactChannel, User } from "@prisma/client";
import { db } from "../db";
import { hashPassword, verifyPassword } from "../auth/password";
import { signAuthToken } from "../auth/jwt";
import { appendEvent } from "./event.service";
import { maskContact, parseIdentifier } from "./contact.service";
import { devOutboxEnabled, sendMessage } from "./notify.service";
import { MIN_PASSWORD_LENGTH } from "./password-reset.service";

/**
 * "Settings": a person updating their own information. Everyone can change
 * their name and password; a new email address or phone number only replaces
 * the old one after the person enters the 6-digit code sent to the NEW one.
 * Every change is recorded in the audit log (contacts masked).
 */
export class ProfileError extends Error {
  constructor(public code: string, message: string, public status = 400) {
    super(message);
  }
}

const CODE_MINUTES = 15;
const MAX_ATTEMPTS = 5;
const COOLDOWN_SECONDS = 60;
const MAX_PER_HOUR = 5;

const sha = (value: string) => createHash("sha256").update(value).digest("hex");

const ROLE_LABELS: Record<string, string> = {
  ADMIN: "Administrator (Case Manager)",
  CLIENT: "Client",
  FAMILY: "Family",
  IP: "Individual Provider",
};

function splitName(user: Pick<User, "name" | "firstName" | "lastName">) {
  if (user.firstName) return { firstName: user.firstName, lastName: user.lastName ?? "" };
  const [first = "", ...rest] = user.name.trim().split(/\s+/);
  return { firstName: first, lastName: rest.join(" ") };
}

export async function getProfile(userId: string) {
  const user = await db.user.findUniqueOrThrow({ where: { id: userId }, include: { household: { select: { name: true, timezone: true } } } });
  return {
    id: user.id,
    name: user.name,
    ...splitName(user),
    role: user.role,
    roleLabel: ROLE_LABELS[user.role] ?? user.role,
    email: user.email,
    phone: user.phone,
    emailVerified: user.emailVerifiedAt !== null,
    phoneVerified: user.phoneVerifiedAt !== null,
    relationship: user.relationship,
    // Family only: what the client approved this person to see.
    canViewTimestamps: user.role === "FAMILY" ? user.canViewTimestamps : null,
    household: user.household,
  };
}

function cleanName(value: string, required: boolean, label: string): string {
  const v = value.replace(/[\u0000-\u001f\u007f]/g, "").trim().replace(/\s+/g, " ");
  if (!v && required) throw new ProfileError("INVALID_NAME", `Enter your ${label}.`);
  if (v.length > 60) throw new ProfileError("INVALID_NAME", `Your ${label} is too long.`);
  return v;
}

export async function updateName(userId: string, input: { firstName: string; lastName?: string }) {
  const firstName = cleanName(input.firstName, true, "first name");
  const lastName = cleanName(input.lastName ?? "", false, "last name");
  const name = [firstName, lastName].filter(Boolean).join(" ");

  await db.$transaction(async (tx) => {
    const before = await tx.user.findUniqueOrThrow({ where: { id: userId } });
    if (before.name === name && before.firstName === firstName && (before.lastName ?? "") === lastName) return;
    await tx.user.update({ where: { id: userId }, data: { name, firstName, lastName: lastName || null } });
    await appendEvent(tx, {
      householdId: before.householdId,
      actorUserId: userId,
      actorRole: before.role,
      action: "profile_name_changed",
      payload: { from: before.name, to: name },
    });
  });
  return getProfile(userId);
}

/**
 * Changes the password after checking the current one. Other sessions are
 * ended; the caller gets a fresh token so this device stays signed in. (The
 * cut-off is set two seconds back so the new token, issued in the same
 * second, is not itself rejected; any session older than that is ended.)
 */
export async function changePassword(userId: string, currentPassword: string, newPassword: string): Promise<{ token: string }> {
  const user = await db.user.findUniqueOrThrow({ where: { id: userId } });
  if (!(await verifyPassword(currentPassword, user.passwordHash))) {
    throw new ProfileError("WRONG_PASSWORD", "Your current password is not right.", 403);
  }
  if (newPassword.length < MIN_PASSWORD_LENGTH) {
    throw new ProfileError("WEAK_PASSWORD", `Choose a new password of at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  if (newPassword === currentPassword) {
    throw new ProfileError("SAME_PASSWORD", "Choose a password different from your current one.");
  }

  const passwordHash = await hashPassword(newPassword);
  await db.$transaction(async (tx) => {
    await tx.user.update({ where: { id: userId }, data: { passwordHash, tokensValidAfter: new Date(Date.now() - 2000) } });
    await appendEvent(tx, { householdId: user.householdId, actorUserId: userId, actorRole: user.role, action: "password_changed", payload: { otherSessionsEnded: true } });
  });

  await notifyContacts(user, "Your Household Care password was just changed and other devices were signed out. If this was not you, tell the household administrator right away.", "Your Household Care password was changed");
  return { token: signAuthToken({ userId: user.id, householdId: user.householdId, role: user.role }) };
}

/** Best effort: the change is already done, so a failed notice never undoes it. */
async function notifyContacts(user: User, body: string, subject: string, skip?: string) {
  const targets: Array<{ channel: ContactChannel; to: string }> = [];
  if (user.email && user.email !== skip) targets.push({ channel: "EMAIL", to: user.email });
  if (user.phone && user.phone !== skip) targets.push({ channel: "SMS", to: user.phone });
  for (const t of targets) {
    await sendMessage({
      householdId: user.householdId,
      channel: t.channel,
      to: t.to,
      subject: t.channel === "EMAIL" ? subject : undefined,
      body,
      kind: "verification",
    }).catch(() => undefined);
  }
}

/** Sends a code to the new email address or phone number. Nothing changes until it is entered. */
export async function startContactChange(userId: string, rawValue: string): Promise<{ channel: ContactChannel; maskedTo: string; devCode?: string }> {
  const parsed = parseIdentifier(rawValue);
  if (!parsed) throw new ProfileError("INVALID_CONTACT", "Enter a valid email address or a 10-digit phone number.");
  const user = await db.user.findUniqueOrThrow({ where: { id: userId } });

  const current = parsed.channel === "EMAIL" ? user.email : user.phone;
  if (current && current.toLowerCase() === parsed.value.toLowerCase()) {
    throw new ProfileError("SAME_CONTACT", `That is already the ${parsed.channel === "EMAIL" ? "email address" : "phone number"} on your account.`);
  }
  const taken = await db.user.findFirst({
    where: { id: { not: userId }, ...(parsed.channel === "EMAIL" ? { email: { equals: parsed.value, mode: "insensitive" as const } } : { phone: parsed.value }) },
    select: { id: true },
  });
  if (taken) {
    throw new ProfileError("CONTACT_IN_USE", `That ${parsed.channel === "EMAIL" ? "email address" : "phone number"} is already used by another account.`, 409);
  }

  const recent = await db.contactChange.findMany({ where: { userId, createdAt: { gt: new Date(Date.now() - 3_600_000) } }, orderBy: { createdAt: "desc" } });
  if (recent.length >= MAX_PER_HOUR) throw new ProfileError("TOO_MANY", "Too many codes were requested. Try again in an hour.", 429);
  if (recent[0] && Date.now() - recent[0].createdAt.getTime() < COOLDOWN_SECONDS * 1000) {
    throw new ProfileError("WAIT", "Wait a minute before asking for another code.", 429);
  }

  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const id = randomUUID();
  await db.$transaction(async (tx) => {
    // A newer request replaces older open ones.
    await tx.contactChange.updateMany({ where: { userId, usedAt: null }, data: { usedAt: new Date() } });
    await tx.contactChange.create({
      data: { id, userId, channel: parsed.channel, contact: parsed.value, codeHash: sha(`contact:${id}:${code}`), expiresAt: new Date(Date.now() + CODE_MINUTES * 60_000) },
    });
    await appendEvent(tx, {
      householdId: user.householdId,
      actorUserId: userId,
      actorRole: user.role,
      action: "contact_change_requested",
      payload: { channel: parsed.channel, to: maskContact(parsed.channel, parsed.value) },
    });
  });

  const sent = await sendMessage({
    householdId: user.householdId,
    channel: parsed.channel,
    to: parsed.value,
    subject: parsed.channel === "EMAIL" ? "Confirm your new Household Care contact" : undefined,
    body: `Your Household Care confirmation code is ${code}. It expires in ${CODE_MINUTES} minutes. If you did not ask for it, ignore this message.`,
    kind: "verification",
  });
  return {
    channel: parsed.channel,
    maskedTo: maskContact(parsed.channel, parsed.value),
    devCode: devOutboxEnabled() && sent.provider === "dev-outbox" ? code : undefined,
  };
}

export async function confirmContactChange(userId: string, code: string) {
  const invalid = () => new ProfileError("CODE_INVALID", "That code is not right or has expired. Ask for a new one.");
  const user = await db.user.findUniqueOrThrow({ where: { id: userId } });

  const change = await db.contactChange.findFirst({ where: { userId, usedAt: null, expiresAt: { gt: new Date() } }, orderBy: { createdAt: "desc" } });
  if (!change || change.attempts >= MAX_ATTEMPTS) throw invalid();

  const given = Buffer.from(sha(`contact:${change.id}:${code.trim()}`));
  const expected = Buffer.from(change.codeHash);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    await db.contactChange.update({ where: { id: change.id }, data: { attempts: { increment: 1 } } });
    throw invalid();
  }

  const previous = change.channel === "EMAIL" ? user.email : user.phone;
  const now = new Date();
  try {
    await db.$transaction(async (tx) => {
      // Spent atomically: the same code cannot be used twice.
      const spent = await tx.contactChange.updateMany({ where: { id: change.id, usedAt: null }, data: { usedAt: now } });
      if (spent.count !== 1) throw invalid();
      await tx.user.update({
        where: { id: userId },
        data: change.channel === "EMAIL" ? { email: change.contact, emailVerifiedAt: now } : { phone: change.contact, phoneVerifiedAt: now },
      });
      await appendEvent(tx, {
        householdId: user.householdId,
        actorUserId: userId,
        actorRole: user.role,
        action: "contact_changed",
        payload: {
          channel: change.channel,
          from: previous ? maskContact(change.channel, previous) : null,
          to: maskContact(change.channel, change.contact),
        },
      });
    });
  } catch (err) {
    // Someone else took the address between the request and the code.
    if (err instanceof ProfileError) throw err;
    if ((err as { code?: string }).code === "P2002") throw new ProfileError("CONTACT_IN_USE", "That address or number was just taken by another account.", 409);
    throw err;
  }

  // Tell the old contact, so a hijacked session cannot quietly redirect an account.
  if (previous) {
    await sendMessage({
      householdId: user.householdId,
      channel: change.channel,
      to: previous,
      subject: change.channel === "EMAIL" ? "Your Household Care contact was changed" : undefined,
      body: "The email address or phone number on your Household Care account was just changed. If this was not you, tell the household administrator right away.",
      kind: "verification",
    }).catch(() => undefined);
  }
  return getProfile(userId);
}
