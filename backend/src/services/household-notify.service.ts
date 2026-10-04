import type { Role } from "@prisma/client";
import { db } from "../db";
import { sendMessage } from "./notify.service";

/**
 * Texts (preferred, it reaches a phone straight away) or emails the people in
 * the given roles, using the same delivery as invitations, and reports how many
 * messages went out and how many failed. Keep messages short and free of
 * personal detail; the person opens the app for the rest.
 */
export async function notifyRolesNow(
  householdId: string,
  roles: Role[],
  subject: string,
  body: string
): Promise<{ sent: number; failed: number }> {
  const people = await db.user.findMany({
    where: { householdId, role: { in: roles }, active: true, accessRevokedAt: null },
    select: { email: true, phone: true },
  });
  let sent = 0;
  let failed = 0;
  for (const p of people) {
    const result = p.phone
      ? await sendMessage({ householdId, channel: "SMS", to: p.phone, body: `Household Care: ${body}`, kind: "alert" })
      : p.email
        ? await sendMessage({ householdId, channel: "EMAIL", to: p.email, subject, body, kind: "alert" })
        : null;
    if (!result) continue; // nobody to reach in this role
    if (result.delivered) sent++;
    else failed++;
  }
  return { sent, failed };
}

/**
 * Fire-and-forget version for callers that must never be blocked or undone by
 * a failed notification. Failures are still recorded in the outbox table.
 * Push notifications are not built yet.
 */
export function notifyRoles(householdId: string, roles: Role[], subject: string, body: string): void {
  void notifyRolesNow(householdId, roles, subject, body).catch((err) => {
    // eslint-disable-next-line no-console
    console.error("notifyRoles failed", err);
  });
}

/** Texts or emails specific people (for example the IP whose request was answered). Best effort; keep the message free of details. */
export function notifyUsers(householdId: string, userIds: string[], subject: string, body: string): void {
  void (async () => {
    const people = await db.user.findMany({ where: { householdId, id: { in: userIds }, active: true, accessRevokedAt: null }, select: { email: true, phone: true } });
    for (const p of people) {
      if (p.phone) await sendMessage({ householdId, channel: "SMS", to: p.phone, body: `Household Care: ${body}`, kind: "alert" });
      else if (p.email) await sendMessage({ householdId, channel: "EMAIL", to: p.email, subject, body, kind: "alert" });
    }
  })().catch((err) => {
    // eslint-disable-next-line no-console
    console.error("notifyUsers failed", err);
  });
}
