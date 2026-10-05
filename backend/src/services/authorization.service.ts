import type { ClosedReason, Prisma } from "@prisma/client";
import { db } from "../db";
import { appendEvent } from "./event.service";
import { raiseAlert } from "./alert.service";
import { AWAY_MESSAGE, clientIsAway } from "./away.service";
import { evaluateGeofence, type VerificationResult } from "./geofence.service";
import { localDateString, workweekStartLocalDate, diffMinutes } from "./time.service";
import { createVisitTaskInstances } from "./task.service";

/** Early/late check-in tolerance, per spec default (configurable later). */
const DEFAULT_TOLERANCE_MINUTES = 10;
// Below this accuracy a fix cannot be trusted enough to open an authorized
// window at all (see geofence.service.ts for the shared threshold used to
// classify VERIFIED/UNVERIFIED/FAILED).

/** Warn when this much time is recorded in a rolling 24 hours (the program's limit without approval is 16 hours). */
export const LONG_DAY_WARN_MINUTES = 14 * 60;

/** Observed minutes (check-in to checkout, or to now when still open) for an IP over the 24 hours ending now, across every visit. */
export async function rollingObservedMinutes(tx: Prisma.TransactionClient, ipUserId: string, now: Date): Promise<number> {
  const since = new Date(now.getTime() - 24 * 3_600_000);
  const shifts = await tx.scheduledShift.findMany({
    where: { ipUserId, observedCheckInUtc: { not: null, lt: now }, OR: [{ observedCheckOutUtc: null }, { observedCheckOutUtc: { gt: since } }] },
    select: { observedCheckInUtc: true, observedCheckOutUtc: true },
  });
  let minutes = 0;
  for (const s of shifts) {
    const from = s.observedCheckInUtc! > since ? s.observedCheckInUtc! : since;
    const to = s.observedCheckOutUtc && s.observedCheckOutUtc < now ? s.observedCheckOutUtc : now;
    minutes += Math.max(0, (to.getTime() - from.getTime()) / 60_000);
  }
  return minutes;
}

export class CheckInRejectedError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

interface CheckInInput {
  shiftId: string;
  ipUserId: string;
  lat: number;
  lng: number;
  accuracyMeters: number | null;
}

export async function checkIn(input: CheckInInput) {
  return db.$transaction(async (tx) => {
    // Lock the shift row first so two devices racing to check in to the same
    // shift serialize instead of both succeeding.
    const [shift] = await tx.$queryRaw<
      Array<{
        id: string;
        householdId: string;
        localDate: string;
        scheduledStartUtc: Date;
        scheduledEndUtc: Date;
        status: string;
        checkInEventId: string | null;
        checkOutEventId: string | null;
        supersededAt: Date | null;
      }>
    >`SELECT id, "householdId", "localDate", "scheduledStartUtc", "scheduledEndUtc", status,
             "checkInEventId", "checkOutEventId", "supersededAt"
      FROM "ScheduledShift" WHERE id = ${input.shiftId} FOR UPDATE`;

    if (!shift) throw new CheckInRejectedError("NOT_FOUND", "Shift does not exist.");
    if (shift.supersededAt) {
      throw new CheckInRejectedError("SHIFT_CHANGED", "This shift was changed or cancelled. Reload today's schedule.");
    }
    if (shift.status !== "SCHEDULED") {
      throw new CheckInRejectedError("NOT_SCHEDULED", "This day is not an authorized scheduled shift.");
    }
    if (shift.checkInEventId) {
      throw new CheckInRejectedError("ALREADY_CHECKED_IN", "This shift already has a check-in recorded.");
    }
    // The client is in hospital, on vacation or otherwise away: no work is authorized until they are back.
    if (await clientIsAway(shift.householdId)) {
      throw new CheckInRejectedError("CLIENT_AWAY", AWAY_MESSAGE);
    }

    const household = await tx.household.findUniqueOrThrow({ where: { id: shift.householdId } });
    const now = new Date();

    // Reject check-ins for any shift whose local date is not today — this
    // blocks both future shifts and attempts to retroactively "check in" to a
    // past, already-closed day.
    const todayLocal = localDateString(now, household.timezone);
    if (shift.localDate !== todayLocal) {
      throw new CheckInRejectedError(
        "UNSCHEDULED_DAY",
        `Check-in is only allowed on the scheduled day (${shift.localDate}), not ${todayLocal}.`
      );
    }

    // Prevent an IP from having two simultaneously active shifts (the other
    // half of "atomic transactions prevent concurrent devices from bypassing
    // the cap" — a second device cannot open a second active window).
    // Only a shift whose authorized window is still open counts. An earlier
    // shift the IP forgot to check out of has already been closed by the
    // server; it stays on record as missing a checkout (never fabricated), but
    // it must not lock the IP out of every future shift.
    const activeElsewhere = await tx.scheduledShift.findFirst({
      where: {
        ipUserId: input.ipUserId,
        checkInEventId: { not: null },
        checkOutEventId: null,
        authorizationClosedAt: null,
        id: { not: shift.id },
      },
      select: { id: true },
    });
    if (activeElsewhere) {
      throw new CheckInRejectedError(
        "ALREADY_ACTIVE_ELSEWHERE",
        "Another shift is already checked in and not checked out."
      );
    }

    const earlyBoundary = new Date(shift.scheduledStartUtc.getTime() - DEFAULT_TOLERANCE_MINUTES * 60_000);
    if (now < earlyBoundary) {
      throw new CheckInRejectedError(
        "TOO_EARLY",
        "This is too early for the scheduled start. Early attempts are logged but do not authorize a shift."
      );
    }

    const geofence = evaluateGeofence({
      lat: input.lat,
      lng: input.lng,
      accuracyMeters: input.accuracyMeters,
      apartmentLat: household.apartmentLat,
      apartmentLng: household.apartmentLng,
      radiusMeters: household.geofenceRadiusMeters,
    });

    if (geofence.verification !== "VERIFIED") {
      await raiseAlert(tx, {
        householdId: shift.householdId,
        actorUserId: input.ipUserId,
        actorRole: "IP",
        type: "location_verification_failed",
        shiftId: shift.id,
        message: `Check-in location could not be verified (${geofence.verification}).`,
        detail: { distanceMeters: geofence.distanceMeters, accuracyMeters: input.accuracyMeters },
      });
      throw new CheckInRejectedError(
        "LOCATION_VERIFICATION_PROBLEM",
        "Location could not be verified. Administrators have been notified."
      );
    }

    const isEarly = now < shift.scheduledStartUtc;
    // Early time never starts the authorized clock; a late check-in simply
    // starts later and does not push the scheduled end out.
    const effectiveStart = now > shift.scheduledStartUtc ? now : shift.scheduledStartUtc;

    const weekStart = workweekStartLocalDate(now, household.timezone, household.workweekStartWeekday);
    await tx.weekAllowance.upsert({
      where: { householdId_ipUserId_weekStartLocalDate: { householdId: shift.householdId, ipUserId: input.ipUserId, weekStartLocalDate: weekStart } },
      create: { householdId: shift.householdId, ipUserId: input.ipUserId, weekStartLocalDate: weekStart, consumedMinutes: 0 },
      update: {},
    });
    const [ledger] = await tx.$queryRaw<Array<{ consumedMinutes: number }>>`
      SELECT "consumedMinutes" FROM "WeekAllowance"
      WHERE "householdId" = ${shift.householdId} AND "ipUserId" = ${input.ipUserId} AND "weekStartLocalDate" = ${weekStart}
      FOR UPDATE`;

    const remainingMinutes = household.weeklyHourCapMinutes - (ledger?.consumedMinutes ?? 0);
    if (remainingMinutes <= 0) {
      throw new CheckInRejectedError(
        "WEEKLY_CAP_REACHED",
        "The 36-hour weekly authorization limit has already been reached."
      );
    }

    const capBoundUtc = new Date(effectiveStart.getTime() + remainingMinutes * 60_000);
    const authorizedEndUtc = capBoundUtc < shift.scheduledEndUtc ? capBoundUtc : shift.scheduledEndUtc;
    const boundReason: ClosedReason = capBoundUtc < shift.scheduledEndUtc ? "WEEKLY_CAP" : "SCHEDULED_END";

    const checkInEvent = await appendEvent(tx, {
      householdId: shift.householdId,
      actorUserId: input.ipUserId,
      actorRole: "IP",
      action: "check_in",
      shiftId: shift.id,
      payload: {
        observedAtUtc: now.toISOString(),
        lat: input.lat,
        lng: input.lng,
        accuracyMeters: input.accuracyMeters,
        distanceMeters: geofence.distanceMeters,
        isEarly,
        effectiveStartUtc: effectiveStart.toISOString(),
        authorizedEndUtc: authorizedEndUtc.toISOString(),
        boundReason,
        remainingWeeklyMinutesBeforeThisShift: remainingMinutes,
      },
    });

    await tx.locationReading.create({
      data: {
        householdId: shift.householdId,
        shiftId: shift.id,
        userId: input.ipUserId,
        source: "CHECK_IN",
        observedAtDevice: now,
        lat: input.lat,
        lng: input.lng,
        accuracyMeters: input.accuracyMeters,
        distanceMeters: geofence.distanceMeters,
        verification: geofence.verification as VerificationResult,
      },
    });

    const updated = await tx.scheduledShift.update({
      where: { id: shift.id },
      data: {
        checkInEventId: checkInEvent.id,
        observedCheckInUtc: now,
        authorizedEndUtc,
        authorizationClosedReason: null,
        authorizationClosedAt: null,
      },
    });

    await createVisitTaskInstances(tx, { id: shift.id, householdId: shift.householdId, localDate: shift.localDate });

    if (isEarly) {
      await raiseAlert(tx, {
        householdId: shift.householdId,
        actorUserId: input.ipUserId,
        actorRole: "IP",
        type: "early_check_in",
        shiftId: shift.id,
        message: "IP checked in earlier than the scheduled start.",
      });
    }

    await raiseAlert(tx, {
      householdId: shift.householdId,
      actorUserId: input.ipUserId,
      actorRole: "IP",
      type: "check_in",
      shiftId: shift.id,
      message: "IP checked in.",
    });

    return updated;
  });
}

interface CheckOutInput {
  shiftId: string;
  ipUserId: string;
  lat: number | null;
  lng: number | null;
  accuracyMeters: number | null;
}

export async function checkOut(input: CheckOutInput) {
  return db.$transaction(async (tx) => {
    const [shift] = await tx.$queryRaw<
      Array<{
        id: string;
        householdId: string;
        checkInEventId: string | null;
        checkOutEventId: string | null;
        observedCheckInUtc: Date | null;
        scheduledEndUtc: Date;
        authorizedEndUtc: Date | null;
        authorizationClosedAt: Date | null;
      }>
    >`SELECT id, "householdId", "checkInEventId", "checkOutEventId", "observedCheckInUtc",
             "scheduledEndUtc", "authorizedEndUtc", "authorizationClosedAt"
      FROM "ScheduledShift" WHERE id = ${input.shiftId} FOR UPDATE`;

    if (!shift) throw new CheckInRejectedError("NOT_FOUND", "Shift does not exist.");
    if (!shift.checkInEventId) {
      throw new CheckInRejectedError("NOT_CHECKED_IN", "This shift was never checked in.");
    }
    if (shift.checkOutEventId) {
      throw new CheckInRejectedError("ALREADY_CHECKED_OUT", "This shift has already been checked out.");
    }

    const now = new Date();
    const household = await tx.household.findUniqueOrThrow({ where: { id: shift.householdId } });

    // Checkout always remains available, including after automatic closure
    // or a GPS failure — only the verification result changes, never
    // whether the departure itself gets recorded.
    let verification: VerificationResult = "UNVERIFIED";
    let distance: number | null = null;
    if (input.lat !== null && input.lng !== null) {
      const geofence = evaluateGeofence({
        lat: input.lat,
        lng: input.lng,
        accuracyMeters: input.accuracyMeters,
        apartmentLat: household.apartmentLat,
        apartmentLng: household.apartmentLng,
        radiusMeters: household.geofenceRadiusMeters,
      });
      verification = geofence.verification;
      distance = geofence.distanceMeters;
    }

    if (verification !== "VERIFIED") {
      await raiseAlert(tx, {
        householdId: shift.householdId,
        actorUserId: input.ipUserId,
        actorRole: "IP",
        type: "location_verification_failed",
        shiftId: shift.id,
        message: `Checkout location could not be verified (${verification}).`,
      });
    }

    await tx.locationReading.create({
      data: {
        householdId: shift.householdId,
        shiftId: shift.id,
        userId: input.ipUserId,
        source: "CHECK_OUT",
        observedAtDevice: now,
        lat: input.lat ?? 0,
        lng: input.lng ?? 0,
        accuracyMeters: input.accuracyMeters,
        distanceMeters: distance,
        verification,
      },
    });

    const alreadyClosedByServerSweep = shift.authorizationClosedAt !== null;
    const authorizedEnd = shift.authorizedEndUtc;
    const excessMinutes = authorizedEnd && now > authorizedEnd ? diffMinutes(now, authorizedEnd) : 0;

    const checkOutEvent = await appendEvent(tx, {
      householdId: shift.householdId,
      actorUserId: input.ipUserId,
      actorRole: "IP",
      action: "check_out",
      shiftId: shift.id,
      payload: {
        observedAtUtc: now.toISOString(),
        lat: input.lat,
        lng: input.lng,
        accuracyMeters: input.accuracyMeters,
        distanceMeters: distance,
        verification,
        closedByServerSweepBeforeCheckout: alreadyClosedByServerSweep,
        excessMinutesPastAuthorizedEnd: excessMinutes,
      },
    });

    // Consume the actual authorized minutes used, once, under the row lock
    // acquired via the ledger update below — idempotent because checkout can
    // only run once per shift (guarded by checkOutEventId above).
    if (shift.observedCheckInUtc) {
      const consumedEnd = authorizedEnd && authorizedEnd < now ? authorizedEnd : now;
      const consumedMinutes = Math.max(0, diffMinutes(consumedEnd, shift.observedCheckInUtc));
      const weekStart = workweekStartLocalDate(shift.observedCheckInUtc, household.timezone, household.workweekStartWeekday);
      await tx.weekAllowance.upsert({
        where: { householdId_ipUserId_weekStartLocalDate: { householdId: shift.householdId, ipUserId: input.ipUserId, weekStartLocalDate: weekStart } },
        create: { householdId: shift.householdId, ipUserId: input.ipUserId, weekStartLocalDate: weekStart, consumedMinutes: Math.round(consumedMinutes) },
        update: { consumedMinutes: { increment: Math.round(consumedMinutes) } },
      });
    }

    if (excessMinutes > 0) {
      await raiseAlert(tx, {
        householdId: shift.householdId,
        actorUserId: input.ipUserId,
        actorRole: "IP",
        type: "excess_time",
        shiftId: shift.id,
        message: `Checkout occurred ${Math.round(excessMinutes)} minute(s) after the authorized window closed.`,
      });
    }

    // Leaving well before the scheduled end is worth a look (never a conclusion).
    const earlyBy = diffMinutes(shift.scheduledEndUtc, now);
    if (earlyBy > DEFAULT_TOLERANCE_MINUTES) {
      await raiseAlert(tx, {
        householdId: shift.householdId,
        actorUserId: input.ipUserId,
        actorRole: "IP",
        type: "early_checkout",
        shiftId: shift.id,
        message: `The IP checked out ${Math.round(earlyBy)} minute(s) before the scheduled end.`,
      });
    }

    // The program needs the counselor's approval beyond 16 hours in 24: warn well before that.
    const rolling = await rollingObservedMinutes(tx, input.ipUserId, now);
    if (rolling >= LONG_DAY_WARN_MINUTES) {
      await raiseAlert(tx, {
        householdId: shift.householdId,
        actorUserId: input.ipUserId,
        actorRole: "IP",
        type: "long_day",
        shiftId: shift.id,
        message: `${(rolling / 60).toFixed(1)} hours were recorded in the last 24 hours. The program needs the counselor's approval above 16 hours in 24.`,
        dedupeKey: `long_day:${shift.id}`,
      });
    }

    // Required tasks still open when they leave.
    const notDone = await tx.taskInstance.count({ where: { shiftId: shift.id, state: { in: ["NOT_STARTED", "IN_PROGRESS", "DISPUTED", "COMPLETION_ERROR_CORRECTED"] } } });
    if (notDone > 0) {
      await raiseAlert(tx, {
        householdId: shift.householdId,
        actorUserId: input.ipUserId,
        actorRole: "IP",
        type: "unresolved_tasks_near_checkout",
        shiftId: shift.id,
        message: `The IP checked out with ${notDone} task${notDone === 1 ? "" : "s"} not done.`,
        refId: shift.id,
        dedupeKey: `unresolved_tasks_near_checkout:${shift.id}`,
      });
    }

    return tx.scheduledShift.update({
      where: { id: shift.id },
      data: {
        checkOutEventId: checkOutEvent.id,
        observedCheckOutUtc: now,
        authorizationClosedAt: shift.authorizationClosedAt ?? now,
        authorizationClosedReason: shift.authorizationClosedAt ? undefined : "MANUAL_CHECKOUT",
      },
    });
  });
}

/**
 * Closes authorization for any shift whose authorized window has elapsed
 * while still checked in. Must run on a server-side schedule (see
 * src/index.ts cron registration) so the boundary is enforced even if the
 * IP's phone is asleep, disconnected, or never calls checkout.
 */
export async function closeExpiredAuthorizations() {
  const now = new Date();
  const expired = await db.scheduledShift.findMany({
    where: {
      checkInEventId: { not: null },
      checkOutEventId: null,
      authorizationClosedAt: null,
      authorizedEndUtc: { lte: now },
    },
    select: { id: true },
  });

  for (const { id } of expired) {
    await db.$transaction(async (tx) => {
      const [shift] = await tx.$queryRaw<
        Array<{
          id: string;
          householdId: string;
          ipUserId: string;
          authorizedEndUtc: Date | null;
          authorizationClosedAt: Date | null;
          observedCheckInUtc: Date | null;
        }>
      >`SELECT id, "householdId", "ipUserId", "authorizedEndUtc", "authorizationClosedAt", "observedCheckInUtc"
        FROM "ScheduledShift" WHERE id = ${id} FOR UPDATE`;

      if (!shift || shift.authorizationClosedAt || !shift.authorizedEndUtc || !shift.observedCheckInUtc) return;
      if (shift.authorizedEndUtc > new Date()) return; // re-check under lock

      const household = await tx.household.findUniqueOrThrow({ where: { id: shift.householdId } });
      const weekStart = workweekStartLocalDate(shift.observedCheckInUtc, household.timezone, household.workweekStartWeekday);
      const consumedMinutes = Math.max(0, diffMinutes(shift.authorizedEndUtc, shift.observedCheckInUtc));

      await tx.weekAllowance.upsert({
        where: { householdId_ipUserId_weekStartLocalDate: { householdId: shift.householdId, ipUserId: shift.ipUserId, weekStartLocalDate: weekStart } },
        create: { householdId: shift.householdId, ipUserId: shift.ipUserId, weekStartLocalDate: weekStart, consumedMinutes: Math.round(consumedMinutes) },
        update: { consumedMinutes: { increment: Math.round(consumedMinutes) } },
      });

      await appendEvent(tx, {
        householdId: shift.householdId,
        actorUserId: null,
        actorRole: "ADMIN",
        action: "authorization_closed",
        shiftId: shift.id,
        payload: { closedAtUtc: new Date().toISOString(), reason: "boundary_reached" },
      });

      await tx.scheduledShift.update({
        where: { id: shift.id },
        data: { authorizationClosedAt: new Date() },
      });

      await raiseAlert(tx, {
        householdId: shift.householdId,
        actorUserId: null,
        actorRole: "ADMIN",
        type: "authorization_closed",
        shiftId: shift.id,
        message: "Authorized window closed automatically (scheduled end or weekly cap reached). Checkout is still required.",
      });
    });
  }
}

/** True only while the shift is checked in, not checked out, and still
 * within its authorized window — the gate every task-mutation route must
 * check before accepting a submission. */
export async function isShiftOpenForTaskSubmission(shiftId: string): Promise<boolean> {
  const shift = await db.scheduledShift.findUnique({ where: { id: shiftId } });
  if (!shift) return false;
  if (!shift.checkInEventId || shift.checkOutEventId) return false;
  if (shift.authorizationClosedAt) return false;
  if (shift.authorizedEndUtc && shift.authorizedEndUtc <= new Date()) return false;
  return true;
}
