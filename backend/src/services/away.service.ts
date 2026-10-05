import type { AwayKind, Role } from "@prisma/client";
import { db } from "../db";
import { appendEvent } from "./event.service";
import { raiseAlert } from "./alert.service";
import { notifyRoles, notifyUsers } from "./household-notify.service";
import { isValidLocalDate } from "./time.service";

/**
 * "Away mode": while the client is in hospital, on vacation or otherwise away,
 * the IP cannot check in or complete tasks (the program does not authorize paid
 * work then, unless the counselor approves it beforehand). The client, an
 * administrator, or the primary family member can turn it on and off, so
 * someone can always do it if the client cannot. Checking out stays possible, so
 * someone already on a visit can always leave and record it.
 *
 * What the IP is told is only that work is paused, never why (that is the
 * client's private health information).
 */
export class AwayError extends Error {
  constructor(public code: string, message: string, public status = 409) {
    super(message);
  }
}

export interface AwayActor {
  userId: string;
  role: Role;
  householdId: string;
}

export const AWAY_MESSAGE = "The client is away, so check-in and tasks are paused. You will be told when work can start again.";

export const clientIsAway = async (householdId: string): Promise<boolean> =>
  (await db.awayPeriod.count({ where: { householdId, endedAt: null } })) > 0;

const isStaff = (role: Role) => role === "CLIENT" || role === "ADMIN";

export async function getAway(viewer: { role: Role; householdId: string }) {
  const period = await db.awayPeriod.findFirst({ where: { householdId: viewer.householdId, endedAt: null }, orderBy: { startedAt: "desc" } });
  if (!period) return { away: false as const };
  if (!isStaff(viewer.role)) return { away: true as const };
  const setBy = await db.user.findUnique({ where: { id: period.setByUserId }, select: { name: true } });
  return {
    away: true as const,
    id: period.id,
    kind: period.kind,
    startedAt: period.startedAt,
    expectedReturnDate: period.expectedReturnDate,
    note: period.note,
    setBy: setBy?.name ?? null,
  };
}

export async function startAway(actor: AwayActor, input: { kind: AwayKind; expectedReturnDate?: string; note?: string }) {
  if (!isStaff(actor.role)) throw new AwayError("FORBIDDEN", "Only the client, an administrator or the primary family member can do this.", 403);
  const expected = input.expectedReturnDate?.trim() || null;
  if (expected && !isValidLocalDate(expected)) throw new AwayError("INVALID_DATE", "Enter the date as year-month-day, for example 2026-10-12.", 400);
  const note = input.note?.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim().slice(0, 300) || null;

  const period = await db.$transaction(async (tx) => {
    // One at a time: two people pressing the button together create one period.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${actor.householdId}:away`}))`;
    if ((await tx.awayPeriod.count({ where: { householdId: actor.householdId, endedAt: null } })) > 0) {
      throw new AwayError("ALREADY_AWAY", "The client is already marked as away.");
    }
    const created = await tx.awayPeriod.create({
      data: { householdId: actor.householdId, kind: input.kind, expectedReturnDate: expected, note, setByUserId: actor.userId },
    });
    await appendEvent(tx, {
      householdId: actor.householdId,
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: "client_away_started",
      payload: { awayId: created.id, kind: input.kind, expectedReturnDate: expected, note },
    });
    await raiseAlert(tx, {
      householdId: actor.householdId,
      actorUserId: actor.userId,
      actorRole: actor.role,
      type: "client_away",
      message: "The client was marked as away. Check-in and tasks are paused until they are back.",
      refId: created.id,
      dedupeKey: `away_start:${created.id}`,
    });
    return created;
  });

  const ips = await db.user.findMany({ where: { householdId: actor.householdId, role: "IP", active: true }, select: { id: true } });
  notifyUsers(actor.householdId, ips.map((u) => u.id), "Work is paused", AWAY_MESSAGE);
  return { id: period.id };
}

export async function endAway(actor: AwayActor) {
  if (!isStaff(actor.role)) throw new AwayError("FORBIDDEN", "Only the client, an administrator or the primary family member can do this.", 403);

  await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${actor.householdId}:away`}))`;
    const ended = await tx.awayPeriod.updateMany({
      where: { householdId: actor.householdId, endedAt: null },
      data: { endedAt: new Date(), endedByUserId: actor.userId },
    });
    if (ended.count === 0) throw new AwayError("NOT_AWAY", "The client is not marked as away.");
    await appendEvent(tx, {
      householdId: actor.householdId,
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: "client_away_ended",
      payload: {},
    });
    await raiseAlert(tx, {
      householdId: actor.householdId,
      actorUserId: actor.userId,
      actorRole: actor.role,
      type: "client_away",
      message: "The client is back. Check-in and tasks can start again.",
      dedupeKey: `away_end:${Date.now()}`,
    });
  });

  const ips = await db.user.findMany({ where: { householdId: actor.householdId, role: "IP", active: true }, select: { id: true } });
  notifyUsers(actor.householdId, ips.map((u) => u.id), "Work can start again", "The client is back. Check-in and tasks can start again.");
  notifyRoles(actor.householdId, ["CLIENT", "ADMIN"], "Away mode ended", "Away mode was turned off.");
}
