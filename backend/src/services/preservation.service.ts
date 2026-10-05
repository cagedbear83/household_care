import type { Role } from "@prisma/client";
import { db } from "../db";
import { appendEvent } from "./event.service";
import { isValidLocalDate } from "./time.service";

/**
 * "Preserve everything" for a range of dates, used when there is an audit or a
 * dispute. While one is active, photos from visits on those dates are not
 * removed when their year is up. It only ever adds protection, so the client,
 * an administrator or the primary family member can place it; releasing it
 * needs a reason. Both are written to the audit log.
 */
export class PreservationError extends Error {
  constructor(public code: string, message: string, public status = 400) {
    super(message);
  }
}

export interface PreservationActor {
  userId: string;
  role: Role;
  householdId: string;
}

const isStaff = (role: Role) => role === "CLIENT" || role === "ADMIN";

function cleanReason(raw: string): string {
  const reason = raw.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();
  if (reason.length < 3) throw new PreservationError("REASON_REQUIRED", "Say why (a few words at least).");
  if (reason.length > 500) throw new PreservationError("REASON_TOO_LONG", "Keep it under 500 characters.");
  return reason;
}

export async function placePreservation(actor: PreservationActor, input: { fromDate: string; toDate: string; reason: string }) {
  if (!isStaff(actor.role)) throw new PreservationError("FORBIDDEN", "Only the client or an administrator can do this.", 403);
  if (!isValidLocalDate(input.fromDate) || !isValidLocalDate(input.toDate)) {
    throw new PreservationError("INVALID_DATE", "Enter dates as year-month-day, for example 2026-10-03.");
  }
  if (input.fromDate > input.toDate) throw new PreservationError("INVALID_DATE", "The start date must not be after the end date.");
  const reason = cleanReason(input.reason);

  return db.$transaction(async (tx) => {
    const created = await tx.preservation.create({
      data: { householdId: actor.householdId, fromDate: input.fromDate, toDate: input.toDate, reason, placedByUserId: actor.userId },
    });
    await appendEvent(tx, {
      householdId: actor.householdId,
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: "preservation_placed",
      payload: { preservationId: created.id, fromDate: input.fromDate, toDate: input.toDate, reason },
    });
    return { id: created.id };
  });
}

export async function releasePreservation(actor: PreservationActor, id: string, rawReason: string) {
  if (!isStaff(actor.role)) throw new PreservationError("FORBIDDEN", "Only the client or an administrator can do this.", 403);
  const reason = cleanReason(rawReason);
  const row = await db.preservation.findFirst({ where: { id, householdId: actor.householdId } });
  if (!row) throw new PreservationError("NOT_FOUND", "That preservation was not found.", 404);

  await db.$transaction(async (tx) => {
    const released = await tx.preservation.updateMany({
      where: { id, releasedAt: null },
      data: { releasedAt: new Date(), releasedByUserId: actor.userId, releaseReason: reason },
    });
    if (released.count !== 1) throw new PreservationError("ALREADY_RELEASED", "That was already released.", 409);
    await appendEvent(tx, {
      householdId: actor.householdId,
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: "preservation_released",
      payload: { preservationId: id, reason, placedReason: row.reason },
    });
  });
}

export async function listPreservations(householdId: string) {
  const rows = await db.preservation.findMany({ where: { householdId }, orderBy: { placedAt: "desc" }, take: 50 });
  const users = await db.user.findMany({
    where: { id: { in: rows.flatMap((r) => [r.placedByUserId, ...(r.releasedByUserId ? [r.releasedByUserId] : [])]) } },
    select: { id: true, name: true },
  });
  const name = new Map(users.map((u) => [u.id, u.name]));
  return rows.map((r) => ({
    id: r.id,
    fromDate: r.fromDate,
    toDate: r.toDate,
    reason: r.reason,
    placedBy: name.get(r.placedByUserId) ?? null,
    placedAt: r.placedAt,
    active: r.releasedAt === null,
    releasedBy: r.releasedByUserId ? (name.get(r.releasedByUserId) ?? null) : null,
    releasedAt: r.releasedAt,
    releaseReason: r.releaseReason,
  }));
}
