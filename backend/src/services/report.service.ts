import { DateTime } from "luxon";
import type { Role, TaskState } from "@prisma/client";
import { db } from "../db";
import { appendEvent } from "./event.service";
import { addLocalDays, isValidLocalDate, localDateString, workweekStartLocalDate } from "./time.service";

/**
 * Reports, created on demand and never stored: nothing here is saved except a
 * small audit event saying who made one for which dates. Everything is worked
 * out from the permanent records (shifts, the task snapshots taken at check-in,
 * and the audit log), so editing a task template later never rewrites an old
 * report.
 *
 * Who sees what: the client and administrators see everything. A family member
 * approved for times and photos sees everything too; otherwise only the task
 * counts (no attendance or exception times, since those come from timestamps).
 * IPs get no reports.
 */
export class ReportError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

export interface ReportViewer {
  userId: string;
  householdId: string;
  role: Role;
  canViewTimestamps: boolean;
}

export const MAX_REPORT_DAYS = 366;
/** Same tolerance the check-in and checkout alerts use. */
const TOLERANCE_MINUTES = 10;

const minutesBetween = (later: Date, earlier: Date) => (later.getTime() - earlier.getTime()) / 60_000;
const pct = (part: number, whole: number) => (whole === 0 ? null : Math.round((part / whole) * 1000) / 10);

const SUBMITTED: TaskState[] = ["COMPLETED_AWAITING_REVIEW", "APPROVED", "CORRECTIVE_WORK_SUBMITTED", "DISPUTED"];
const NOT_DONE: TaskState[] = ["NOT_STARTED", "IN_PROGRESS", "COMPLETION_ERROR_CORRECTED"];

export interface TaskCounts {
  /** Every task assigned in the period (the snapshot taken at check-in). */
  assigned: number;
  /** Marked done by the IP, including ones the client later disputed. */
  submitted: number;
  approved: number;
  /** Submitted, waiting for the client. */
  awaitingReview: number;
  /** Disputed and not yet fixed and re-approved. Also counted in "submitted". */
  disputed: number;
  correctiveSubmitted: number;
  /** The IP reported a decline and the client has not answered. */
  declineAwaitingConfirmation: number;
  confirmedDeclined: number;
  notNeeded: number;
  unableToComplete: number;
  /** Not done when the visit ended (or the visit never happened). */
  missed: number;
  /** Not done yet, visit still in progress or still to come. */
  stillOpen: number;
  /** Recorded as done (or as an exception) by mistake, then corrected by an administrator. Not counted as done. */
  correctedErrors: number;
}

const emptyCounts = (): TaskCounts => ({
  assigned: 0, submitted: 0, approved: 0, awaitingReview: 0, disputed: 0, correctiveSubmitted: 0,
  declineAwaitingConfirmation: 0, confirmedDeclined: 0, notNeeded: 0, unableToComplete: 0, missed: 0, stillOpen: 0, correctedErrors: 0,
});

function addTask(counts: TaskCounts, state: TaskState, visitOver: boolean) {
  counts.assigned++;
  if (SUBMITTED.includes(state)) counts.submitted++;
  switch (state) {
    case "APPROVED": counts.approved++; break;
    case "COMPLETED_AWAITING_REVIEW": counts.awaitingReview++; break;
    case "DISPUTED": counts.disputed++; break;
    case "CORRECTIVE_WORK_SUBMITTED": counts.correctiveSubmitted++; counts.awaitingReview++; break;
    case "DECLINED_AWAITING_CONFIRMATION": counts.declineAwaitingConfirmation++; break;
    case "CLIENT_DECLINED_CONFIRMED": counts.confirmedDeclined++; break;
    case "NOT_NEEDED": counts.notNeeded++; break;
    case "UNABLE_TO_COMPLETE": counts.unableToComplete++; break;
    case "MISSED_AT_SHIFT_END": counts.missed++; break;
    case "COMPLETION_ERROR_CORRECTED": counts.correctedErrors++; break;
    case "NOT_STARTED":
    case "IN_PROGRESS":
      if (visitOver) counts.missed++;
      else counts.stillOpen++;
      break;
  }
}

const OUTCOME_LABEL: Partial<Record<TaskState, string>> = {
  DISPUTED: "Disputed by the client",
  CLIENT_DECLINED_CONFIRMED: "Client confirmed they declined",
  DECLINED_AWAITING_CONFIRMATION: "Decline waiting for the client",
  NOT_NEEDED: "Marked not needed",
  UNABLE_TO_COMPLETE: "Marked unable to complete",
  MISSED_AT_SHIFT_END: "Not done by the end of the visit",
  COMPLETION_ERROR_CORRECTED: "Recorded in error and corrected, so not counted as done",
  NOT_STARTED: "Not done by the end of the visit",
  IN_PROGRESS: "Not done by the end of the visit",
};

const humanReason = (code: string | null, text: string | null) =>
  [code ? code.replace(/_/g, " ") : null, text].filter(Boolean).join(": ") || null;

export type ExceptionKind =
  | "early_check_in"
  | "late_check_in"
  | "early_checkout"
  | "excess_time"
  | "missing_checkout"
  | "no_check_in"
  | "location_failed"
  | "dispute"
  | "decline_reported"
  | "corrective_work"
  | "tasks_not_done"
  | "suspicious_pattern"
  | "authorization_closed"
  | "food_hazard"
  | "mistake_reported"
  | "correction";

const KIND_LABEL: Record<ExceptionKind, string> = {
  early_check_in: "Early check-in",
  late_check_in: "Late check-in",
  early_checkout: "Early checkout",
  excess_time: "Time past the authorized window",
  missing_checkout: "No checkout recorded",
  no_check_in: "Scheduled visit with no check-in",
  location_failed: "Location could not be verified",
  dispute: "Task disputed",
  decline_reported: "Decline reported by the IP",
  corrective_work: "Corrective work submitted",
  tasks_not_done: "Tasks not done at the end of the visit",
  suspicious_pattern: "Activity that may need a look",
  authorization_closed: "Authorization closed by the system",
  food_hazard: "Food hazard reported",
  mistake_reported: "Completion error reported by the IP",
  correction: "Correction appended",
};

export interface ExceptionItem {
  date: string;
  at: string | null;
  kind: ExceptionKind;
  label: string;
  text: string;
}

export interface AttendanceRow {
  shiftId: string;
  date: string;
  ipName: string;
  scheduledStart: string;
  scheduledEnd: string;
  scheduledMinutes: number;
  /** "attended" | "in_progress" | "missed" | "no_checkout" | "upcoming" */
  status: string;
  checkIn: string | null;
  checkOut: string | null;
  /** Check-in to checkout as recorded; null when there is no checkout to measure to. */
  observedMinutes: number | null;
  /** The minutes counted toward the 36-hour limit (never beyond the authorized end). */
  authorizedMinutes: number;
  tasks: TaskCounts;
  /** Notes appended by an administrator about this visit's check-in or checkout. The recorded times are never changed. */
  correctionNotes: string[];
}

export async function buildReport(viewer: ReportViewer, input: { from: string; to: string }, now: Date = new Date()) {
  const { from, to } = input;
  if (!isValidLocalDate(from) || !isValidLocalDate(to)) throw new ReportError("INVALID_RANGE", "Enter dates as year-month-day, for example 2026-10-03.");
  if (from > to) throw new ReportError("INVALID_RANGE", "The start date must not be after the end date.");
  const days = DateTime.fromISO(to).diff(DateTime.fromISO(from), "days").days + 1;
  if (days > MAX_REPORT_DAYS) throw new ReportError("RANGE_TOO_LONG", `Choose a range of at most ${MAX_REPORT_DAYS} days.`);
  if (viewer.role === "IP") throw new ReportError("FORBIDDEN", "Reports are not available to this account.");

  const household = await db.household.findUniqueOrThrow({ where: { id: viewer.householdId } });
  const generatedBy = await db.user.findUniqueOrThrow({ where: { id: viewer.userId }, select: { name: true, role: true } });
  const tz = household.timezone;
  const full = viewer.role !== "FAMILY" || viewer.canViewTimestamps;

  const startUtc = DateTime.fromISO(from, { zone: tz }).startOf("day").toJSDate();
  const endUtc = DateTime.fromISO(to, { zone: tz }).plus({ days: 1 }).startOf("day").toJSDate();
  const localDay = (instant: Date) => localDateString(instant, tz);

  const shifts = await db.scheduledShift.findMany({
    where: { householdId: viewer.householdId, localDate: { gte: from, lte: to }, supersededAt: null },
    orderBy: [{ localDate: "asc" }, { scheduledStartUtc: "asc" }],
    include: {
      ip: { select: { name: true } },
      taskInstances: {
        select: { id: true, state: true, titleSnapshot: true, reasonCode: true, reasonText: true, template: { select: { groupName: true } } },
        orderBy: [{ template: { sortOrder: "asc" } }, { createdAt: "asc" }, { id: "asc" }],
      },
    },
  });

  const working = shifts.filter((s) => s.status === "SCHEDULED");
  const daysOff = shifts.filter((s) => s.status !== "SCHEDULED").map((s) => ({ date: s.localDate, ipName: s.ip.name, status: s.status }));

  // --- Tasks -------------------------------------------------------------------
  const totals = emptyCounts();
  const byDay = new Map<string, TaskCounts>();
  const byGroup = new Map<string, TaskCounts>();
  const notCompleted: Array<{ date: string; group: string; title: string; outcome: string; reason: string | null }> = [];
  const visitOver = (s: (typeof working)[number]) => s.authorizationClosedAt !== null || s.scheduledEndUtc < now;

  for (const s of working) {
    const over = visitOver(s);
    for (const t of s.taskInstances) {
      for (const bucket of [totals, byDay.get(s.localDate) ?? byDay.set(s.localDate, emptyCounts()).get(s.localDate)!, byGroup.get(t.template.groupName) ?? byGroup.set(t.template.groupName, emptyCounts()).get(t.template.groupName)!]) {
        addTask(bucket, t.state, over);
      }
      const label = OUTCOME_LABEL[t.state];
      const isNotDone = NOT_DONE.includes(t.state);
      if (label && (!isNotDone || over || t.state === "COMPLETION_ERROR_CORRECTED")) {
        notCompleted.push({ date: s.localDate, group: t.template.groupName, title: t.titleSnapshot, outcome: label, reason: humanReason(t.reasonCode, t.reasonText) });
      }
    }
  }

  const resolved = totals.approved + totals.confirmedDeclined + totals.notNeeded + totals.unableToComplete;
  const withOutcome = totals.assigned - totals.missed - totals.stillOpen - totals.correctedErrors;
  const taskSection = {
    totals,
    percentages: {
      /** Submitted completions divided by all assigned tasks (disputed ones included, and shown separately). */
      completion: pct(totals.submitted, totals.assigned),
      approved: pct(totals.approved, totals.assigned),
      /** Tasks with any recorded outcome (done, declined, not needed, unable) divided by all assigned. */
      coverage: pct(withOutcome, totals.assigned),
      /** Tasks with a final outcome (approved, confirmed declined, not needed, unable) divided by all assigned. */
      resolution: pct(resolved, totals.assigned),
    },
    resolved,
    unresolved: totals.assigned - resolved,
    byDay: [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, counts]) => ({ date, ...counts })),
    byGroup: [...byGroup.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([group, counts]) => ({ group, ...counts })),
    notCompleted: notCompleted.slice(0, 300),
    notCompletedTotal: notCompleted.length,
  };

  // --- Attendance and exceptions (only for people who may see times) -------------------
  let attendance: null | {
    rows: AttendanceRow[];
    totals: Record<string, number>;
    weeks: Array<{ weekStart: string; weekEnd: string; authorizedMinutes: number; observedMinutes: number; capMinutes: number; overCap: boolean; partial: boolean }>;
    daysOff: typeof daysOff;
  } = null;
  let exceptions: null | { items: ExceptionItem[]; counts: Record<string, number>; adminCorrections: number } = null;

  if (full) {
    const rows: AttendanceRow[] = [];
    const attendanceNotes = await db.correction.findMany({ where: { householdId: viewer.householdId, kind: "ATTENDANCE", shiftId: { in: working.map((w) => w.id) } }, orderBy: { createdAt: "asc" } });
    const items: ExceptionItem[] = [];
    const add = (kind: ExceptionKind, at: Date | null, date: string, text: string) =>
      items.push({ date, at: at ? at.toISOString() : null, kind, label: KIND_LABEL[kind], text });

    for (const s of working) {
      const started = s.observedCheckInUtc !== null;
      const ended = s.observedCheckOutUtc !== null;
      const closed = s.authorizationClosedAt !== null;
      const open = started && !ended && !closed;
      const over = visitOver(s);
      const authorizedEnd = s.authorizedEndUtc ?? s.scheduledEndUtc;

      let authorizedMinutes = 0;
      let observedMinutes: number | null = null;
      if (started) {
        const stop = ended ? s.observedCheckOutUtc! : closed ? s.authorizationClosedAt! : now;
        authorizedMinutes = Math.max(0, minutesBetween(stop < authorizedEnd ? stop : authorizedEnd, s.observedCheckInUtc!));
        if (ended || open) observedMinutes = Math.max(0, minutesBetween(ended ? s.observedCheckOutUtc! : now, s.observedCheckInUtc!));
      }

      const status = !started ? (over ? "missed" : "upcoming") : open ? "in_progress" : ended ? "attended" : "no_checkout";
      const counts = emptyCounts();
      for (const t of s.taskInstances) addTask(counts, t.state, over);
      rows.push({
        shiftId: s.id,
        date: s.localDate,
        ipName: s.ip.name,
        scheduledStart: s.scheduledStartUtc.toISOString(),
        scheduledEnd: s.scheduledEndUtc.toISOString(),
        scheduledMinutes: Math.round(minutesBetween(s.scheduledEndUtc, s.scheduledStartUtc)),
        status,
        checkIn: s.observedCheckInUtc?.toISOString() ?? null,
        checkOut: s.observedCheckOutUtc?.toISOString() ?? null,
        observedMinutes: observedMinutes === null ? null : Math.round(observedMinutes),
        authorizedMinutes: Math.round(authorizedMinutes),
        tasks: counts,
        correctionNotes: attendanceNotes.filter((n) => n.shiftId === s.id).map((n) => n.reason),
      });

      if (started) {
        const early = minutesBetween(s.scheduledStartUtc, s.observedCheckInUtc!);
        const late = minutesBetween(s.observedCheckInUtc!, s.scheduledStartUtc);
        if (early > TOLERANCE_MINUTES) add("early_check_in", s.observedCheckInUtc, s.localDate, `${s.ip.name} checked in ${Math.round(early)} minutes before the scheduled start.`);
        if (late > TOLERANCE_MINUTES) add("late_check_in", s.observedCheckInUtc, s.localDate, `${s.ip.name} checked in ${Math.round(late)} minutes after the scheduled start.`);
        if (ended) {
          const earlyOut = minutesBetween(s.scheduledEndUtc, s.observedCheckOutUtc!);
          if (earlyOut > TOLERANCE_MINUTES) add("early_checkout", s.observedCheckOutUtc, s.localDate, `${s.ip.name} checked out ${Math.round(earlyOut)} minutes before the scheduled end.`);
          const excess = minutesBetween(s.observedCheckOutUtc!, authorizedEnd);
          if (excess > 0.5) add("excess_time", s.observedCheckOutUtc, s.localDate, `Checkout was ${Math.round(excess)} minutes after the authorized window closed. Those minutes are not counted toward the limit.`);
        } else if (closed) {
          add("missing_checkout", s.authorizationClosedAt, s.localDate, `${s.ip.name} checked in but no checkout was recorded. Authorization closed automatically.`);
        }
      } else if (over) {
        add("no_check_in", null, s.localDate, `${s.ip.name} was scheduled but did not check in.`);
      }

      const left = s.taskInstances.filter((t) => NOT_DONE.includes(t.state) || t.state === "MISSED_AT_SHIFT_END").length;
      if (over && started && left > 0) add("tasks_not_done", s.scheduledEndUtc, s.localDate, `${left} task${left === 1 ? " was" : "s were"} not done when the visit ended.`);
    }

    // Permanent audit records inside the dates.
    const events = await db.event.findMany({
      where: {
        householdId: viewer.householdId,
        serverTimestampUtc: { gte: startUtc, lt: endUtc },
        action: { in: ["alert_raised", "task_disputed", "task_corrective_submitted", "task_decline_reported", "correction_requested", "correction_appended"] },
      },
      orderBy: { serverTimestampUtc: "asc" },
    });
    const taskTitles = new Map(
      (await db.taskInstance.findMany({ where: { id: { in: events.map((e) => e.taskInstanceId).filter((id): id is string => id !== null) } }, select: { id: true, titleSnapshot: true } })).map((t) => [t.id, t.titleSnapshot])
    );
    const alertKinds: Record<string, ExceptionKind> = {
      location_verification_failed: "location_failed",
      suspicious_pattern: "suspicious_pattern",
      authorization_closed: "authorization_closed",
      food_hazard: "food_hazard",
    };
    let adminCorrections = 0;
    for (const e of events) {
      const p = (e.payload ?? {}) as { type?: string; message?: string; reason?: string; note?: string; kind?: string; about?: string };
      const date = localDay(e.serverTimestampUtc);
      const title = e.taskInstanceId ? (taskTitles.get(e.taskInstanceId) ?? "a task") : "a task";
      if (e.action === "alert_raised") {
        const kind = p.type ? alertKinds[p.type] : undefined;
        if (kind) add(kind, e.serverTimestampUtc, date, p.message ?? KIND_LABEL[kind]);
      } else if (e.action === "task_disputed") {
        add("dispute", e.serverTimestampUtc, date, `"${title}" was disputed${p.reason ? `: ${p.reason}` : "."}`);
      } else if (e.action === "task_corrective_submitted") {
        add("corrective_work", e.serverTimestampUtc, date, `Corrective work was submitted for "${title}".`);
      } else if (e.action === "correction_requested") {
        add("mistake_reported", e.serverTimestampUtc, date, `The IP reported a mistake about ${p.about ?? "a recorded step"}: ${p.reason ?? ""}`.trim());
      } else if (e.action === "correction_appended") {
        adminCorrections++;
        const what = p.kind === "COMPLETION_ERROR" ? "Completion error" : p.kind === "ATTENDANCE" ? "Attendance note" : "Note";
        add("correction", e.serverTimestampUtc, date, `${what} appended to "${title}"${e.taskInstanceId ? "" : " (visit record)"}: ${p.reason ?? ""}`.replace('"a task"', "a recorded step"));
      } else if (e.action === "task_decline_reported") {
        add("decline_reported", e.serverTimestampUtc, date, `The IP reported that the client declined "${title}".${p.note ? ` Note: ${p.note}` : ""}`);
      }
    }
    items.sort((a, b) => (a.at ?? `${a.date}T00:00`).localeCompare(b.at ?? `${b.date}T00:00`));
    const kindCounts: Record<string, number> = {};
    for (const i of items) kindCounts[i.kind] = (kindCounts[i.kind] ?? 0) + 1;
    exceptions = { items: items.slice(0, 500), counts: kindCounts, adminCorrections };

    // Weekly totals against the limit, using the household's workweek.
    const weekMap = new Map<string, { authorized: number; observed: number }>();
    for (const r of rows) {
      const weekStart = workweekStartLocalDate(DateTime.fromISO(r.date, { zone: tz }).toJSDate(), tz, household.workweekStartWeekday);
      const w = weekMap.get(weekStart) ?? { authorized: 0, observed: 0 };
      w.authorized += r.authorizedMinutes;
      w.observed += r.observedMinutes ?? 0;
      weekMap.set(weekStart, w);
    }
    const weeks = [...weekMap.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([weekStart, w]) => {
      const weekEnd = addLocalDays(weekStart, 6);
      return {
        weekStart,
        weekEnd,
        authorizedMinutes: w.authorized,
        observedMinutes: w.observed,
        capMinutes: household.weeklyHourCapMinutes,
        overCap: w.authorized > household.weeklyHourCapMinutes,
        partial: weekStart < from || weekEnd > to,
      };
    });

    attendance = {
      rows,
      totals: {
        visitsScheduled: rows.length,
        visitsAttended: rows.filter((r) => r.status === "attended" || r.status === "in_progress" || r.status === "no_checkout").length,
        visitsMissed: rows.filter((r) => r.status === "missed").length,
        visitsUpcoming: rows.filter((r) => r.status === "upcoming").length,
        visitsWithoutCheckout: rows.filter((r) => r.status === "no_checkout").length,
        scheduledMinutes: rows.reduce((n, r) => n + r.scheduledMinutes, 0),
        authorizedMinutes: rows.reduce((n, r) => n + r.authorizedMinutes, 0),
        observedMinutes: rows.reduce((n, r) => n + (r.observedMinutes ?? 0), 0),
      },
      weeks,
      daysOff,
    };
  }

  // Only a record of who made which report for which dates is kept (never the contents).
  await db.$transaction((tx) =>
    appendEvent(tx, {
      householdId: viewer.householdId,
      actorUserId: viewer.userId,
      actorRole: viewer.role,
      action: "report_generated",
      payload: { from, to, sections: full ? ["attendance", "tasks", "exceptions"] : ["tasks"] },
    })
  );

  return {
    meta: {
      generatedAt: now.toISOString(),
      from,
      to,
      days,
      timezone: tz,
      generatedBy: { name: generatedBy.name, role: generatedBy.role },
      scope: full ? "full" : "tasks_only",
      weeklyLimitMinutes: household.weeklyHourCapMinutes,
      notes: [
        "This app supplements the official state attendance and service records; it does not replace them.",
        "Completion percentage is submitted completions divided by all assigned tasks. Disputed completions are included and shown separately. Declines, not-needed and unable-to-complete are never counted as completed work.",
        "Coverage is tasks with any recorded outcome divided by all assigned tasks. Resolution is tasks with a final outcome (approved, confirmed declined, not needed, or unable with a reason) divided by all assigned tasks.",
        "Tasks are counted from the list assigned at check-in, so changing a task template later does not change past reports.",
        ...(full ? ["Check-in and checkout times are what the app observed. Minutes counted toward the weekly limit stop at the authorized end, so they can be less than the observed minutes.", "Corrections are listed as exceptions. They never change what was recorded: a task recorded as done in error stops counting as done, and attendance corrections are notes beside the recorded times."] : ["Attendance times and exceptions are not shown because the client has not approved timestamps for this account."]),
        "This report is created when you ask for it and is not saved by the app. Copies you print or download are yours to protect.",
      ],
    },
    tasks: taskSection,
    attendance,
    exceptions,
  };
}
