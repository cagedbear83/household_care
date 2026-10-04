import { createHash, randomInt, randomUUID, timingSafeEqual } from "crypto";
import type { User } from "@prisma/client";
import { db } from "../db";
import { hashPassword } from "../auth/password";
import { appendEvent } from "./event.service";
import { parseIdentifier } from "./contact.service";
import { devOutboxEnabled, sendMessage } from "./notify.service";

export class ResetError extends Error {
  constructor(public code: string, message: string, public status = 400) {
    super(message);
  }
}

const CODE_MINUTES = 15;
const MAX_ATTEMPTS = 5;
const COOLDOWN_SECONDS = 60;
const MAX_PER_HOUR = 5;
export const MIN_PASSWORD_LENGTH = 10;

const sha = (value: string) => createHash("sha256").update(value).digest("hex");

async function findAccount(identifier: string): Promise<{ user: User; channel: "EMAIL" | "SMS"; contact: string } | null> {
  const parsed = parseIdentifier(identifier);
  if (!parsed) return null;
  const user = await db.user.findFirst({
    where: parsed.channel === "EMAIL" ? { email: { equals: parsed.value, mode: "insensitive" } } : { phone: parsed.value },
  });
  if (!user || !user.active || user.accessRevokedAt) return null;
  return { user, channel: parsed.channel, contact: parsed.value };
}

/**
 * Starts a reset. It always looks the same from outside (no "account not found")
 * so it cannot be used to find out who has an account: when there is no account,
 * or it is throttled, nothing is sent and nothing is said. The code goes to the
 * same email address or phone number that was typed, which must be the one on the account.
 */
export async function requestPasswordReset(identifier: string): Promise<{ devCode?: string }> {
  const account = await findAccount(identifier);
  if (!account) return {};
  const { user, channel, contact } = account;

  const since = new Date(Date.now() - 3_600_000);
  const recent = await db.passwordReset.findMany({ where: { userId: user.id, createdAt: { gt: since } }, orderBy: { createdAt: "desc" } });
  if (recent.length >= MAX_PER_HOUR) return {};
  if (recent[0] && Date.now() - recent[0].createdAt.getTime() < COOLDOWN_SECONDS * 1000) return {};

  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const id = randomUUID();
  await db.$transaction(async (tx) => {
    await tx.passwordReset.create({
      data: { id, userId: user.id, channel, contact, codeHash: sha(`reset:${id}:${code}`), expiresAt: new Date(Date.now() + CODE_MINUTES * 60_000) },
    });
    await appendEvent(tx, { householdId: user.householdId, actorUserId: user.id, actorRole: user.role, action: "password_reset_requested", payload: { channel } });
  });

  const sent = await sendMessage({
    householdId: user.householdId,
    channel,
    to: contact,
    subject: channel === "EMAIL" ? "Your Household Care password reset code" : undefined,
    body: `Your Household Care password reset code is ${code}. It expires in ${CODE_MINUTES} minutes. If you did not ask for it, ignore this message; your password has not changed.`,
    kind: "password_reset",
  });
  // Development only: with no provider configured nothing is really sent, so hand the code back.
  return { devCode: devOutboxEnabled() && sent.provider === "dev-outbox" ? code : undefined };
}

/**
 * Sets the new password if the code is right. Every existing session for the
 * account is ended (anything issued before now stops working), so someone who
 * had taken over a session loses it along with the old password.
 */
export async function completePasswordReset(identifier: string, code: string, newPassword: string): Promise<void> {
  if (newPassword.length < MIN_PASSWORD_LENGTH) {
    throw new ResetError("WEAK_PASSWORD", `Choose a password of at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  const invalid = () => new ResetError("RESET_INVALID", "That code is not right or has expired. Ask for a new one.");

  const account = await findAccount(identifier);
  if (!account) throw invalid();
  const { user, contact } = account;

  const reset = await db.passwordReset.findFirst({
    where: { userId: user.id, contact, usedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: "desc" },
  });
  if (!reset || reset.attempts >= MAX_ATTEMPTS) throw invalid();

  const given = Buffer.from(sha(`reset:${reset.id}:${code.trim()}`));
  const expected = Buffer.from(reset.codeHash);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    await db.passwordReset.update({ where: { id: reset.id }, data: { attempts: { increment: 1 } } });
    throw invalid();
  }

  const passwordHash = await hashPassword(newPassword);
  const now = new Date();
  await db.$transaction(async (tx) => {
    // One use only: this code and any other open ones for the account are spent.
    await tx.passwordReset.updateMany({ where: { userId: user.id, usedAt: null }, data: { usedAt: now } });
    await tx.user.update({ where: { id: user.id }, data: { passwordHash, tokensValidAfter: now } });
    await appendEvent(tx, { householdId: user.householdId, actorUserId: user.id, actorRole: user.role, action: "password_reset_completed", payload: { sessionsEnded: true } });
  });

  // Tell the person, in case it was not them. Best effort: the reset is already done.
  await sendMessage({
    householdId: user.householdId,
    channel: account.channel,
    to: contact,
    subject: account.channel === "EMAIL" ? "Your Household Care password was changed" : undefined,
    body: "Your Household Care password was just changed and you were signed out everywhere. If this was not you, tell the household administrator right away.",
    kind: "password_reset",
  }).catch(() => undefined);
}
