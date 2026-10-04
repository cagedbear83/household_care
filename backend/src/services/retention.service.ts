import { DateTime } from "luxon";
import type { Prisma, Role } from "@prisma/client";
import { db } from "../db";
import { verifyPassword } from "../auth/password";
import { appendEvent } from "./event.service";
import { notifyRoles } from "./household-notify.service";
import { isValidLocalDate } from "./time.service";

/**
 * Retention: how long records are kept.
 *
 * - The household picks a period (the recommendation is two years; one year is
 *   the least allowed). Every choice is a new row; nothing is overwritten.
 * - A record is protected for the LONGEST period in force from when it was
 *   recorded onward. So lengthening the policy protects existing records for
 *   longer, and shortening it never unlocks records that were already
 *   protected ("a later policy reduction cannot unlock existing protected
 *   records early").
 * - A preservation hold keeps records past the period for a stated reason and
 *   date range. Records tied to a dispute that is not yet resolved are also
 *   kept, automatically.
 * - Changing the policy or placing/releasing a hold needs the person's password
 *   again at that moment (the stand-in here for a PIN or biometric check) and is
 *   written to the audit log.
 * - The app never deletes anything. Records past their period are only counted
 *   as "eligible for archive or disposal review"; the locked archive and any
 *   disposal belong to the storage layer (see the README).
 */
export class RetentionError extends Error {
  constructor(public code: string, message: string, public status = 400) {
    super(message);
  }
}

export const RECOMMENDED_DAYS = 730;
export const MIN_DAYS = 365;
export const MAX_DAYS = 3650;

export interface RetentionActor {
  userId: string;
  role: Role;
  householdId: string;
}

const isStaff = (role: Role) => role === "ADMIN" || role === "CLIENT";
const DAY = 86_400_000;

async function reauthenticate(userId: string, password: string) {
  const user = await db.user.findUniqueOrThrow({ where: { id: userId }, select: { passwordHash: true } });
  if (!password || !(await verifyPassword(password, user.passwordHash))) {
    throw new RetentionError("REAUTH_FAILED", "That password is not right. Enter your password to confirm this change.", 403);
  }
}

function cleanReason(raw: string | undefined, required: boolean): string | null {
  const reason = (raw ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();
  if (!reason) {
    if (required) throw new RetentionError("REASON_REQUIRED", "Say why (a few words at least).");
    return null;
  }
  if (reason.length < 3) throw new RetentionError("REASON_REQUIRED", "Say why (a few words at least).");
  if (reason.length > 1000) throw new RetentionError("REASON_TOO_LONG", "Keep it under 1000 characters.");
  return reason;
}

interface Period {
  /** Records created from this moment until the next period began. */
  start: Date;
  end: Date | null;
  days: number;
  /** The protection those records get: the longest period in force from then on. */
  protectedDays: number;
}

/** The periods, oldest first, with the protection each one's records get. */
function buildPeriods(explicit: { retentionDays: number; effectiveFrom: Date }[]): Period[] {
  const raw = [{ start: new Date(0), days: RECOMMENDED_DAYS }, ...explicit.map((p) => ({ start: p.effectiveFrom, days: p.retentionDays }))];
  return raw.map((p, i) => ({
    start: p.start,
    end: raw[i + 1]?.start ?? null,
    days: p.days,
    protectedDays: Math.max(...raw.slice(i).map((r) => r.days)),
  }));
}

export async function getPolicyHistory(householdId: string) {
  return db.retentionPolicy.findMany({ where: { householdId }, orderBy: { effectiveFrom: "asc" } });
}

/** When a record made at this moment is protected until. */
export async function retainUntil(householdId: string, recordedAt: Date): Promise<Date> {
  const periods = buildPeriods(await getPolicyHistory(householdId));
  const period = [...periods].reverse().find((p) => p.start <= recordedAt) ?? periods[0]!;
  return new Date(recordedAt.getTime() + period.protectedDays * DAY);
}

function holdWindow(hold: { fromDate: string | null; toDate: string | null }, tz: string): Prisma.EventWhereInput {
  const start = hold.fromDate ? DateTime.fromISO(hold.fromDate, { zone: tz }).startOf("day").toJSDate() : null;
  const end = hold.toDate ? DateTime.fromISO(hold.toDate, { zone: tz }).plus({ days: 1 }).startOf("day").toJSDate() : null;
  return { serverTimestampUtc: { gte: start ?? new Date(0), ...(end ? { lt: end } : {}) } };
}

export async function getRetentionStatus(householdId: string, now: Date = new Date()) {
  const household = await db.household.findUniqueOrThrow({ where: { id: householdId } });
  const [policies, holds, disputedTasks] = await Promise.all([
    getPolicyHistory(householdId),
    db.retentionHold.findMany({ where: { householdId }, orderBy: { placedAt: "desc" } }),
    db.taskInstance.findMany({ where: { householdId, state: { in: ["DISPUTED", "CORRECTIVE_WORK_SUBMITTED"] } }, select: { id: true } }),
  ]);
  const periods = buildPeriods(policies);
  const activeHolds = holds.filter((h) => h.releasedAt === null);
  const disputedIds = disputedTasks.map((t) => t.id);

  const names = new Map(
    (await db.user.findMany({ where: { id: { in: [...policies.map((p) => p.setByUserId), ...holds.flatMap((h) => [h.placedByUserId, ...(h.releasedByUserId ? [h.releasedByUserId] : [])])] } }, select: { id: true, name: true } })).map((u) => [u.id, u.name])
  );

  // Records past their period, split into "can be reviewed for disposal" and "held back".
  let pastEvents = 0;
  let reviewableEvents = 0;
  let pastEvidence = 0;
  let reviewableEvidence = 0;
  let oldest: Date | null = null;
  let earliestExpiry: Date | null = null;

  for (const p of periods) {
    const base: Prisma.EventWhereInput = { householdId, serverTimestampUtc: { gte: p.start, ...(p.end ? { lt: p.end } : {}) } };
    const cutoff = new Date(now.getTime() - p.protectedDays * DAY);
    const expired: Prisma.EventWhereInput = { ...base, AND: [{ serverTimestampUtc: { lt: cutoff } }] };
    const held: Prisma.EventWhereInput[] = [...activeHolds.map((h) => holdWindow(h, household.timezone)), ...(disputedIds.length ? [{ taskInstanceId: { in: disputedIds } }] : [])];

    const first = await db.event.findFirst({ where: base, orderBy: { serverTimestampUtc: "asc" }, select: { serverTimestampUtc: true } });
    if (first) {
      if (!oldest || first.serverTimestampUtc < oldest) oldest = first.serverTimestampUtc;
      const expiry = new Date(first.serverTimestampUtc.getTime() + p.protectedDays * DAY);
      if (!earliestExpiry || expiry < earliestExpiry) earliestExpiry = expiry;
    }
    const past = await db.event.count({ where: expired });
    // Counted directly (past and held) rather than with NOT(...), which would silently drop rows where a column is null.
    const heldBack = held.length ? await db.event.count({ where: { ...expired, OR: held } }) : 0;
    pastEvents += past;
    reviewableEvents += past - heldBack;

    // Photos follow the same rules, by the day the server accepted them.
    const evClean: Prisma.EvidenceWhereInput = { taskInstance: { householdId }, uploadAcceptedAtServer: { gte: p.start, lt: p.end && p.end < cutoff ? p.end : cutoff } };
    const heldEv: Prisma.EvidenceWhereInput[] = [
      ...activeHolds.map((h) => {
        const w = holdWindow(h, household.timezone).serverTimestampUtc as { gte?: Date; lt?: Date };
        return { uploadAcceptedAtServer: w };
      }),
      ...(disputedIds.length ? [{ taskInstanceId: { in: disputedIds } }] : []),
    ];
    const pastHere = await db.evidence.count({ where: evClean });
    pastEvidence += pastHere;
    reviewableEvidence += pastHere - (heldEv.length ? await db.evidence.count({ where: { ...evClean, OR: heldEv } }) : 0);
  }

  const [totalEvents, totalEvidence] = await Promise.all([
    db.event.count({ where: { householdId } }),
    db.evidence.count({ where: { taskInstance: { householdId } } }),
  ]);

  const current = policies[policies.length - 1];
  const currentDays = current?.retentionDays ?? RECOMMENDED_DAYS;
  const longestEarlier = Math.max(RECOMMENDED_DAYS, ...policies.slice(0, -1).map((p) => p.retentionDays));
  const reduced = policies.length > 0 && currentDays < longestEarlier;

  return {
    now: now.toISOString(),
    timezone: household.timezone,
    policy: {
      days: currentDays,
      // Until someone chooses, the recommendation applies and the screen says it is not confirmed.
      confirmed: policies.length > 0,
      recommendedDays: RECOMMENDED_DAYS,
      minDays: MIN_DAYS,
      maxDays: MAX_DAYS,
      setBy: current ? (names.get(current.setByUserId) ?? null) : null,
      setAt: current?.effectiveFrom ?? null,
      /** Shortened after a longer period was in force: older records keep their longer protection. */
      reducedFrom: reduced ? longestEarlier : null,
    },
    history: [
      { retentionDays: RECOMMENDED_DAYS, effectiveFrom: null, setBy: null, reason: "Starting recommendation", isDefault: true },
      ...policies.map((p) => ({ retentionDays: p.retentionDays, effectiveFrom: p.effectiveFrom, setBy: names.get(p.setByUserId) ?? null, reason: p.reason, isDefault: false })),
    ].reverse(),
    holds: holds.map((h) => ({
      id: h.id,
      reason: h.reason,
      fromDate: h.fromDate,
      toDate: h.toDate,
      placedBy: names.get(h.placedByUserId) ?? null,
      placedAt: h.placedAt,
      active: h.releasedAt === null,
      releasedBy: h.releasedByUserId ? (names.get(h.releasedByUserId) ?? null) : null,
      releasedAt: h.releasedAt,
      releaseReason: h.releaseReason,
    })),
    records: {
      events: totalEvents,
      photos: totalEvidence,
      oldestRecordedAt: oldest,
      /** The earliest moment any record's protection ends, for the records that exist now. */
      earliestExpiry,
      pastRetention: { events: pastEvents, photos: pastEvidence },
      /** Past their period, not on hold and not tied to an unresolved dispute: only these could be reviewed for disposal. */
      reviewable: { events: reviewableEvents, photos: reviewableEvidence },
      heldBack: { events: pastEvents - reviewableEvents, photos: pastEvidence - reviewableEvidence },
      unresolvedDisputes: disputedIds.length,
    },
    notes: [
      "A record is protected for the longest period that was in force from when it was recorded. Shortening the period later never unlocks records that were already protected.",
      "Records tied to a dispute that has not been resolved are kept regardless of the period, and so are records inside an active preservation hold.",
      "The app never deletes records. Anything past its period is only counted here as eligible for review; the locked archive and any disposal are done in the storage layer.",
      "The recommended period is two years. That is a product recommendation, not a statement of any program's legal requirement. Check the program guidance that applies to you.",
    ],
  };
}

/** Chooses the retention period. Needs the person's password again, and is audited. */
export async function setRetentionPolicy(actor: RetentionActor, input: { days: number; reason?: string; password: string }) {
  if (!isStaff(actor.role)) throw new RetentionError("FORBIDDEN", "Only the client or an administrator can change this.", 403);
  if (!Number.isInteger(input.days) || input.days < MIN_DAYS || input.days > MAX_DAYS) {
    throw new RetentionError("INVALID_DAYS", `Choose between ${MIN_DAYS} days (one year) and ${MAX_DAYS} days (ten years).`);
  }
  await reauthenticate(actor.userId, input.password);

  const policies = await getPolicyHistory(actor.householdId);
  const previousDays = policies[policies.length - 1]?.retentionDays ?? RECOMMENDED_DAYS;
  const confirmedBefore = policies.length > 0;
  if (confirmedBefore && previousDays === input.days) throw new RetentionError("UNCHANGED", "That is already the retention period.", 409);
  const reduced = input.days < previousDays;
  const reason = cleanReason(input.reason, reduced);

  await db.$transaction(async (tx) => {
    const row = await tx.retentionPolicy.create({ data: { householdId: actor.householdId, retentionDays: input.days, setByUserId: actor.userId, reason, effectiveFrom: new Date() } });
    await tx.household.update({ where: { id: actor.householdId }, data: { retentionDays: input.days } });
    await appendEvent(tx, {
      householdId: actor.householdId,
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: "retention_policy_changed",
      payload: { policyId: row.id, from: previousDays, to: input.days, reduced, confirmedFirstTime: !confirmedBefore, reason, existingRecordsKeepLongerProtection: reduced },
    });
  });
  notifyRoles(actor.householdId, ["CLIENT", "ADMIN"], "A record-keeping setting changed", "The record retention period was changed. Open the app to see it.");
  return getRetentionStatus(actor.householdId);
}

/** Keeps records past the normal period. Dates are optional; with none, it covers everything. */
export async function placeHold(actor: RetentionActor, input: { reason: string; fromDate?: string; toDate?: string; password: string }) {
  if (!isStaff(actor.role)) throw new RetentionError("FORBIDDEN", "Only the client or an administrator can place a hold.", 403);
  const reason = cleanReason(input.reason, true)!;
  const fromDate = input.fromDate?.trim() || null;
  const toDate = input.toDate?.trim() || null;
  for (const d of [fromDate, toDate]) if (d && !isValidLocalDate(d)) throw new RetentionError("INVALID_DATE", "Enter dates as year-month-day, for example 2026-10-03.");
  if (fromDate && toDate && fromDate > toDate) throw new RetentionError("INVALID_DATE", "The start date must not be after the end date.");
  await reauthenticate(actor.userId, input.password);

  await db.$transaction(async (tx) => {
    const hold = await tx.retentionHold.create({ data: { householdId: actor.householdId, reason, fromDate, toDate, placedByUserId: actor.userId } });
    await appendEvent(tx, {
      householdId: actor.householdId,
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: "retention_hold_placed",
      payload: { holdId: hold.id, reason, fromDate, toDate },
    });
  });
  notifyRoles(actor.householdId, ["CLIENT", "ADMIN"], "A record-keeping setting changed", "A preservation hold was placed on records. Open the app to see it.");
  return getRetentionStatus(actor.householdId);
}

export async function releaseHold(actor: RetentionActor, holdId: string, input: { reason: string; password: string }) {
  if (!isStaff(actor.role)) throw new RetentionError("FORBIDDEN", "Only the client or an administrator can release a hold.", 403);
  const reason = cleanReason(input.reason, true)!;
  const hold = await db.retentionHold.findFirst({ where: { id: holdId, householdId: actor.householdId } });
  if (!hold) throw new RetentionError("NOT_FOUND", "That hold was not found.", 404);
  await reauthenticate(actor.userId, input.password);

  await db.$transaction(async (tx) => {
    const released = await tx.retentionHold.updateMany({
      where: { id: holdId, releasedAt: null },
      data: { releasedAt: new Date(), releasedByUserId: actor.userId, releaseReason: reason },
    });
    if (released.count !== 1) throw new RetentionError("ALREADY_RELEASED", "That hold was already released.", 409);
    await appendEvent(tx, {
      householdId: actor.householdId,
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: "retention_hold_released",
      payload: { holdId, reason, placedReason: hold.reason },
    });
  });
  notifyRoles(actor.householdId, ["CLIENT", "ADMIN"], "A record-keeping setting changed", "A preservation hold was released. Open the app to see it.");
  return getRetentionStatus(actor.householdId);
}
