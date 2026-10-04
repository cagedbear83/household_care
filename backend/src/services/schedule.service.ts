import { randomUUID } from "crypto";
import type { Prisma, Role, ShiftStatus } from "@prisma/client";
import { db } from "../db";
import { appendEvent } from "./event.service";
import {
  addLocalDays,
  isValidLocalDate,
  localToUtc,
  localWeekday,
  workweekStartLocalDate,
} from "./time.service";

export class ScheduleRejectedError extends Error {
  constructor(public code: string, message: string, public detail?: Record<string, unknown>) {
    super(message);
  }
}

export interface Actor {
  userId: string;
  role: Role;
  householdId: string;
}

export interface ShiftDetails {
  localDate: string;
  startLocal?: string;
  endLocal?: string;
  status: ShiftStatus;
}

export interface CreateShiftInput extends ShiftDetails {
  ipUserId: string;
  recurringSourceId?: string;
}

interface Prepared {
  ipId: string;
  working: boolean;
  startUtc: Date;
  endUtc: Date;
  shiftMinutes: number;
  weekStart: string;
  weekEndExclusive: string;
  capMinutes: number;
}

/** Everything that can be validated without touching shift rows. */
async function prepare(actor: Actor, ipUserId: string, details: ShiftDetails): Promise<Prepared> {
  if (!isValidLocalDate(details.localDate)) {
    throw new ScheduleRejectedError("INVALID_DATE", "Enter a valid date (YYYY-MM-DD).");
  }

  const ip = await db.user.findFirst({
    where: { id: ipUserId, householdId: actor.householdId, role: "IP", active: true },
  });
  if (!ip) throw new ScheduleRejectedError("IP_NOT_FOUND", "No active IP with that id in this household.");

  const household = await db.household.findUniqueOrThrow({ where: { id: actor.householdId } });

  const working = details.status === "SCHEDULED";
  if (working && (!details.startLocal || !details.endLocal)) {
    throw new ScheduleRejectedError("TIMES_REQUIRED", "A scheduled shift needs a start and end time.");
  }

  let startUtc: Date;
  let endUtc: Date;
  try {
    startUtc = localToUtc(details.localDate, working ? details.startLocal! : "00:00", household.timezone);
    endUtc = localToUtc(details.localDate, working ? details.endLocal! : "00:00", household.timezone);
  } catch (err) {
    throw new ScheduleRejectedError("INVALID_TIME", err instanceof Error ? err.message : "Invalid time.");
  }
  if (working && endUtc <= startUtc) {
    throw new ScheduleRejectedError("END_BEFORE_START", "The end time must be after the start time on the same day.");
  }

  const weekStart = workweekStartLocalDate(startUtc, household.timezone, household.workweekStartWeekday);
  return {
    ipId: ip.id,
    working,
    startUtc,
    endUtc,
    shiftMinutes: Math.round((endUtc.getTime() - startUtc.getTime()) / 60_000),
    weekStart,
    weekEndExclusive: addLocalDays(weekStart, 7),
    capMinutes: household.weeklyHourCapMinutes,
  };
}

interface InsertOptions {
  id?: string;
  recurringSourceId?: string;
  supersedesShiftId?: string;
  auditAction: string;
  auditExtra?: Record<string, unknown>;
}

/**
 * Runs the schedule rules and inserts the row, inside the caller's
 * transaction. "Active" always means supersededAt IS NULL: replaced or
 * cancelled versions stay in the table as history but never count toward
 * duplicates, overlaps, or the weekly cap.
 */
async function insertShift(
  tx: Prisma.TransactionClient,
  actor: Actor,
  p: Prepared,
  details: ShiftDetails,
  opts: InsertOptions
) {
  // Serialize concurrent schedule edits for the same IP and workweek so two
  // admins cannot each add a shift that individually fits under the cap.
  await tx.weekAllowance.upsert({
    where: {
      householdId_ipUserId_weekStartLocalDate: {
        householdId: actor.householdId,
        ipUserId: p.ipId,
        weekStartLocalDate: p.weekStart,
      },
    },
    create: { householdId: actor.householdId, ipUserId: p.ipId, weekStartLocalDate: p.weekStart, consumedMinutes: 0 },
    update: {},
  });
  await tx.$queryRaw`
    SELECT id FROM "WeekAllowance"
    WHERE "householdId" = ${actor.householdId} AND "ipUserId" = ${p.ipId} AND "weekStartLocalDate" = ${p.weekStart}
    FOR UPDATE`;

  const sameDay = await tx.scheduledShift.findFirst({
    where: { ipUserId: p.ipId, localDate: details.localDate, supersededAt: null },
    select: { id: true },
  });
  if (sameDay) {
    throw new ScheduleRejectedError("DUPLICATE_DAY", `This IP already has an entry for ${details.localDate}.`);
  }

  if (p.working) {
    const overlapping = await tx.scheduledShift.findFirst({
      where: {
        ipUserId: p.ipId,
        status: "SCHEDULED",
        supersededAt: null,
        scheduledStartUtc: { lt: p.endUtc },
        scheduledEndUtc: { gt: p.startUtc },
      },
      select: { id: true },
    });
    if (overlapping) {
      throw new ScheduleRejectedError("OVERLAP", "This shift overlaps another scheduled shift.", {
        conflictingShiftId: overlapping.id,
      });
    }

    const weekShifts = await tx.scheduledShift.findMany({
      where: {
        ipUserId: p.ipId,
        status: "SCHEDULED",
        supersededAt: null,
        localDate: { gte: p.weekStart, lt: p.weekEndExclusive },
      },
      select: { scheduledStartUtc: true, scheduledEndUtc: true },
    });
    const alreadyScheduled = weekShifts.reduce(
      (sum, s) => sum + Math.round((s.scheduledEndUtc.getTime() - s.scheduledStartUtc.getTime()) / 60_000),
      0
    );
    if (alreadyScheduled + p.shiftMinutes > p.capMinutes) {
      throw new ScheduleRejectedError(
        "WEEKLY_CAP_EXCEEDED",
        `This would schedule ${((alreadyScheduled + p.shiftMinutes) / 60).toFixed(2)} hours for the workweek starting ${p.weekStart}; the limit is ${p.capMinutes / 60}.`,
        { weekStart: p.weekStart, alreadyScheduledMinutes: alreadyScheduled, requestedMinutes: p.shiftMinutes }
      );
    }
  }

  const shift = await tx.scheduledShift.create({
    data: {
      id: opts.id,
      householdId: actor.householdId,
      ipUserId: p.ipId,
      localDate: details.localDate,
      scheduledStartUtc: p.startUtc,
      scheduledEndUtc: p.endUtc,
      status: details.status,
      recurringSourceId: opts.recurringSourceId ?? null,
      supersedesShiftId: opts.supersedesShiftId ?? null,
      createdBy: actor.userId,
    },
  });

  await appendEvent(tx, {
    householdId: actor.householdId,
    actorUserId: actor.userId,
    actorRole: actor.role,
    action: opts.auditAction,
    shiftId: shift.id,
    payload: {
      ipUserId: p.ipId,
      localDate: details.localDate,
      status: details.status,
      startUtc: p.startUtc.toISOString(),
      endUtc: p.endUtc.toISOString(),
      recurringSourceId: opts.recurringSourceId ?? null,
      ...opts.auditExtra,
    },
  });

  return shift;
}

/**
 * Creates one day's shift for an IP. Rejects overlapping shifts, a second
 * shift on the same local day, and any schedule that would push the IP's
 * scheduled hours for that workweek past the household cap. Non-working
 * statuses (vacation, sick, ...) are recorded as zero-length days so the
 * calendar still shows them but they never count toward hours.
 */
export async function createShift(actor: Actor, input: CreateShiftInput) {
  const p = await prepare(actor, input.ipUserId, input);
  return db.$transaction((tx) =>
    insertShift(tx, actor, p, input, { recurringSourceId: input.recurringSourceId, auditAction: "shift_scheduled" })
  );
}

interface LockedShift {
  id: string;
  householdId: string;
  ipUserId: string;
  localDate: string;
  status: ShiftStatus;
  scheduledStartUtc: Date;
  scheduledEndUtc: Date;
  checkInEventId: string | null;
  supersededAt: Date | null;
}

function cleanReason(reason: string): string {
  const trimmed = reason.trim();
  if (trimmed.length < 3) {
    throw new ScheduleRejectedError("REASON_REQUIRED", "Enter a reason for the change (at least a few words).");
  }
  return trimmed;
}

/** Locks the shift row and checks it may still be changed. A shift that has
 * started or already ended is part of the attendance record: changing it
 * could erase missed work after the fact, so it is refused. */
async function lockChangeableShift(tx: Prisma.TransactionClient, actor: Actor, shiftId: string): Promise<LockedShift> {
  const [shift] = await tx.$queryRaw<LockedShift[]>`
    SELECT id, "householdId", "ipUserId", "localDate", status, "scheduledStartUtc", "scheduledEndUtc",
           "checkInEventId", "supersededAt"
    FROM "ScheduledShift" WHERE id = ${shiftId} FOR UPDATE`;

  if (!shift || shift.householdId !== actor.householdId) {
    throw new ScheduleRejectedError("NOT_FOUND", "Shift not found.");
  }
  if (shift.supersededAt) {
    throw new ScheduleRejectedError("ALREADY_SUPERSEDED", "This shift was already changed or cancelled. Reload the schedule.");
  }
  if (shift.checkInEventId) {
    throw new ScheduleRejectedError("SHIFT_STARTED", "This shift has already been checked in, so it can no longer be changed.");
  }
  if (shift.scheduledEndUtc <= new Date() && shift.status === "SCHEDULED") {
    throw new ScheduleRejectedError(
      "SHIFT_IN_PAST",
      "This shift has already ended. Past shifts are part of the record and cannot be changed or cancelled."
    );
  }
  return shift;
}

const snapshot = (s: LockedShift) => ({
  localDate: s.localDate,
  status: s.status,
  startUtc: s.scheduledStartUtc.toISOString(),
  endUtc: s.scheduledEndUtc.toISOString(),
});

/**
 * Replaces a not-yet-started shift with a new version. The old row is kept
 * (marked superseded and linked to its successor) and the change, with its
 * reason, goes to the audit log; nothing is overwritten.
 */
export async function replaceShift(actor: Actor, shiftId: string, details: ShiftDetails, reason: string) {
  const cleaned = cleanReason(reason);

  const existing = await db.scheduledShift.findFirst({ where: { id: shiftId, householdId: actor.householdId } });
  if (!existing) throw new ScheduleRejectedError("NOT_FOUND", "Shift not found.");

  const p = await prepare(actor, existing.ipUserId, details);
  if (p.working && p.endUtc <= new Date()) {
    throw new ScheduleRejectedError("NEW_SHIFT_IN_PAST", "The new shift must end in the future; past time cannot be backdated.");
  }

  const newId = randomUUID();
  return db.$transaction(async (tx) => {
    const old = await lockChangeableShift(tx, actor, shiftId);

    await tx.scheduledShift.update({
      where: { id: old.id },
      data: { supersededAt: new Date(), supersededByShiftId: newId },
    });

    return insertShift(tx, actor, p, details, {
      id: newId,
      supersedesShiftId: old.id,
      auditAction: "shift_replaced",
      auditExtra: { reason: cleaned, oldShiftId: old.id, before: snapshot(old) },
    });
  });
}

/** Cancels a not-yet-started shift. Same rules as a replacement, with no successor. */
export async function cancelShift(actor: Actor, shiftId: string, reason: string) {
  const cleaned = cleanReason(reason);

  return db.$transaction(async (tx) => {
    const old = await lockChangeableShift(tx, actor, shiftId);

    const updated = await tx.scheduledShift.update({
      where: { id: old.id },
      data: { supersededAt: new Date() },
    });
    await appendEvent(tx, {
      householdId: actor.householdId,
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: "shift_cancelled",
      shiftId: old.id,
      payload: { reason: cleaned, before: snapshot(old) },
    });
    return updated;
  });
}

/** Active shifts in a local-date range, each with the version it replaced (if any). */
export async function listActiveShifts(householdId: string, from: string, to: string) {
  const shifts = await db.scheduledShift.findMany({
    where: { householdId, supersededAt: null, localDate: { gte: from, lte: to } },
    orderBy: [{ localDate: "asc" }, { scheduledStartUtc: "asc" }],
    include: { ip: { select: { id: true, name: true } } },
  });

  const previousIds = shifts.map((s) => s.supersedesShiftId).filter((id): id is string => id !== null);
  const previous = previousIds.length
    ? await db.scheduledShift.findMany({
        where: { id: { in: previousIds } },
        select: { id: true, localDate: true, status: true, scheduledStartUtc: true, scheduledEndUtc: true },
      })
    : [];
  const byId = new Map(previous.map((s) => [s.id, s]));

  return shifts.map((s) => ({ ...s, previous: s.supersedesShiftId ? (byId.get(s.supersedesShiftId) ?? null) : null }));
}

export interface CreateRecurringRuleInput {
  ipUserId: string;
  weekday: number;
  startLocal: string;
  endLocal: string;
  effectiveFrom: string;
  effectiveUntil?: string;
}

/** Rules are append-only versions: changing a pattern means creating a new
 * rule (and deactivating the old one) rather than rewriting history. */
export async function createRecurringRule(actor: Actor, input: CreateRecurringRuleInput) {
  const ip = await db.user.findFirst({
    where: { id: input.ipUserId, householdId: actor.householdId, role: "IP", active: true },
  });
  if (!ip) throw new ScheduleRejectedError("IP_NOT_FOUND", "No active IP with that id in this household.");
  if (!isValidLocalDate(input.effectiveFrom) || (input.effectiveUntil && !isValidLocalDate(input.effectiveUntil))) {
    throw new ScheduleRejectedError("INVALID_DATE", "Enter valid dates (YYYY-MM-DD).");
  }
  if (input.endLocal <= input.startLocal) {
    throw new ScheduleRejectedError("END_BEFORE_START", "The end time must be after the start time.");
  }

  return db.$transaction(async (tx) => {
    const rule = await tx.recurringScheduleRule.create({
      data: {
        householdId: actor.householdId,
        ipUserId: ip.id,
        weekday: input.weekday,
        startLocal: input.startLocal,
        endLocal: input.endLocal,
        // Date-only values stored as UTC midnight; always read back with toISOString().slice(0, 10).
        effectiveFrom: new Date(`${input.effectiveFrom}T00:00:00Z`),
        effectiveUntil: input.effectiveUntil ? new Date(`${input.effectiveUntil}T00:00:00Z`) : null,
        createdBy: actor.userId,
      },
    });
    await appendEvent(tx, {
      householdId: actor.householdId,
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: "recurring_rule_created",
      payload: { ruleId: rule.id, ...input },
    });
    return rule;
  });
}

export interface GenerationResult {
  localDate: string;
  ipUserId: string;
  ruleId: string;
  outcome: "created" | "skipped";
  code?: string;
  message?: string;
  shiftId?: string;
}

/** Expands active recurring rules into concrete shifts for [from, to]. Each
 * day is created independently, so one rejected day (cap, overlap, existing
 * entry) is reported without blocking the rest. */
export async function generateFromRules(actor: Actor, from: string, to: string): Promise<GenerationResult[]> {
  if (!isValidLocalDate(from) || !isValidLocalDate(to) || to < from) {
    throw new ScheduleRejectedError("INVALID_RANGE", "Enter a valid date range.");
  }
  const spanDays = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
  if (spanDays > 62) throw new ScheduleRejectedError("RANGE_TOO_LONG", "Generate at most 62 days at a time.");

  const rules = await db.recurringScheduleRule.findMany({
    where: { householdId: actor.householdId, active: true },
    orderBy: { createdAt: "asc" },
  });

  const results: GenerationResult[] = [];
  for (let date = from; date <= to; date = addLocalDays(date, 1)) {
    const weekday = localWeekday(date);
    for (const rule of rules) {
      const effFrom = rule.effectiveFrom.toISOString().slice(0, 10);
      const effUntil = rule.effectiveUntil?.toISOString().slice(0, 10);
      if (rule.weekday !== weekday || effFrom > date || (effUntil && effUntil < date)) continue;

      try {
        const shift = await createShift(actor, {
          ipUserId: rule.ipUserId,
          localDate: date,
          startLocal: rule.startLocal,
          endLocal: rule.endLocal,
          status: "SCHEDULED",
          recurringSourceId: rule.id,
        });
        results.push({ localDate: date, ipUserId: rule.ipUserId, ruleId: rule.id, outcome: "created", shiftId: shift.id });
      } catch (err) {
        if (!(err instanceof ScheduleRejectedError)) throw err;
        results.push({
          localDate: date,
          ipUserId: rule.ipUserId,
          ruleId: rule.id,
          outcome: "skipped",
          code: err.code,
          message: err.message,
        });
      }
    }
  }
  return results;
}
