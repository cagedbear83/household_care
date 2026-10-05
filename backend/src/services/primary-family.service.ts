import type { Prisma, Role } from "@prisma/client";
import { db } from "../db";
import { appendEvent } from "./event.service";

/**
 * The primary family member: the first family member to finish signing up. They
 * have the same access as the client (approvals, away mode and so on) and get
 * the same notifications, so that if the client is ill, in hospital, or
 * otherwise unable, someone else can always act. The client cannot remove them;
 * only an administrator can change who it is, with a reason, and every change is
 * audited. There is at most one per household.
 */
export class PrimaryFamilyError extends Error {
  constructor(public code: string, message: string, public status = 409) {
    super(message);
  }
}

const lock = (tx: Prisma.TransactionClient, householdId: string) =>
  tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${householdId}:primary-family`}))`;

/**
 * Makes sure the household has a primary family member if it has any active
 * family member at all: the earliest one to have activated. Safe to call
 * concurrently (one wins, under a per-household lock). Returns who it is.
 */
export async function ensurePrimaryFamily(tx: Prisma.TransactionClient, householdId: string): Promise<string | null> {
  await lock(tx, householdId);

  // A flag left on someone who has since been turned off no longer counts.
  await tx.user.updateMany({
    where: { householdId, role: "FAMILY", isPrimaryFamily: true, OR: [{ active: false }, { accessRevokedAt: { not: null } }] },
    data: { isPrimaryFamily: false },
  });

  const current = await tx.user.findFirst({ where: { householdId, role: "FAMILY", isPrimaryFamily: true, active: true, accessRevokedAt: null }, select: { id: true } });
  if (current) return current.id;

  const next = await tx.user.findFirst({
    where: { householdId, role: "FAMILY", active: true, accessRevokedAt: null, activatedAt: { not: null } },
    orderBy: [{ activatedAt: "asc" }, { id: "asc" }],
    select: { id: true },
  });
  if (!next) return null;

  await tx.user.update({ where: { id: next.id }, data: { isPrimaryFamily: true } });
  await appendEvent(tx, {
    householdId,
    actorUserId: next.id,
    actorRole: "FAMILY",
    action: "primary_family_assigned",
    payload: { userId: next.id, automatic: true },
  });
  return next.id;
}

export interface PrimaryActor {
  userId: string;
  role: Role;
  householdId: string;
}

/** An administrator picks a different family member as the primary one. */
export async function makePrimaryFamily(actor: PrimaryActor, targetUserId: string, rawReason: string) {
  if (actor.role !== "ADMIN") throw new PrimaryFamilyError("FORBIDDEN", "Only an administrator can change the primary family member.", 403);
  const reason = rawReason.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (reason.length < 3) throw new PrimaryFamilyError("REASON_REQUIRED", "Say why (a few words at least).", 400);

  await db.$transaction(async (tx) => {
    await lock(tx, actor.householdId);
    const target = await tx.user.findFirst({ where: { id: targetUserId, householdId: actor.householdId, role: "FAMILY" } });
    if (!target || !target.active || target.accessRevokedAt || !target.activatedAt) {
      throw new PrimaryFamilyError("NOT_ELIGIBLE", "That person is not an active family member.", 404);
    }
    if (target.isPrimaryFamily) throw new PrimaryFamilyError("ALREADY_PRIMARY", "That person is already the primary family member.");

    const previous = await tx.user.findMany({ where: { householdId: actor.householdId, role: "FAMILY", isPrimaryFamily: true }, select: { id: true } });
    await tx.user.updateMany({ where: { householdId: actor.householdId, role: "FAMILY", isPrimaryFamily: true }, data: { isPrimaryFamily: false } });
    await tx.user.update({ where: { id: target.id }, data: { isPrimaryFamily: true } });
    await appendEvent(tx, {
      householdId: actor.householdId,
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: "primary_family_changed",
      payload: { from: previous.map((p) => p.id), to: target.id, reason },
    });
  });
}
