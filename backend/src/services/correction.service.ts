import type { CorrectionKind, Prisma, Role, TaskState } from "@prisma/client";
import { db } from "../db";
import { appendEvent } from "./event.service";
import { raiseAlert, resolveAlerts } from "./alert.service";
import { notifyUsers } from "./household-notify.service";
import { TaskActionRejectedError, transition } from "./task.service";

/**
 * Corrections. An IP who made a mistake can only REPORT it ("Report completion
 * error"); an administrator or the client then APPENDS a correction with a
 * reason, linked to the original event. Nothing original is ever changed or
 * removed: the correction is its own permanent record, and a recorded task
 * completion that was a mistake stops counting as done (the task moves to its
 * own "completion error corrected" state, and the IP can do it again while the
 * visit is open). Attendance corrections are notes only: observed check-in and
 * checkout times are never changed or invented.
 */
export class CorrectionError extends Error {
  constructor(public code: string, message: string, public status = 400) {
    super(message);
  }
}

export interface IpActor {
  userId: string;
  householdId: string;
}
export interface StaffActor extends IpActor {
  role: Role;
}

const REASON_MIN = 3;
const REASON_MAX = 1000;

/** Task states where a recorded completion or exception can have been a mistake. */
export const CORRECTABLE: TaskState[] = [
  "COMPLETED_AWAITING_REVIEW",
  "CORRECTIVE_WORK_SUBMITTED",
  "APPROVED",
  "NOT_NEEDED",
  "UNABLE_TO_COMPLETE",
  "DECLINED_AWAITING_CONFIRMATION",
  "DISPUTED",
];

const TASK_STEP_ACTIONS = ["task_completed", "task_corrective_submitted", "task_marked_not_needed", "task_marked_unable", "task_decline_reported", "task_approved", "task_disputed"];
const ATTENDANCE_ACTIONS = ["check_in", "check_out", "authorization_closed", "location_ping"];

function cleanReason(raw: string): string {
  const reason = raw.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();
  if (reason.length < REASON_MIN) throw new CorrectionError("REASON_REQUIRED", "Say what happened (a few words at least).");
  if (reason.length > REASON_MAX) throw new CorrectionError("REASON_TOO_LONG", `Keep it under ${REASON_MAX} characters.`);
  return reason;
}

const isStaff = (role: Role) => role === "ADMIN" || role === "CLIENT";

// ---------------------------------------------------------------------------------
// The IP reports a mistake

/**
 * "Report completion error". The IP names a task (or their visit's check-in or
 * checkout) and says what went wrong. This only asks: nothing about the record
 * changes until an administrator or the client appends a correction.
 */
export async function requestCorrection(ip: IpActor, input: { taskInstanceId?: string; shiftId?: string; reason: string }) {
  const reason = cleanReason(input.reason);
  if (Boolean(input.taskInstanceId) === Boolean(input.shiftId)) {
    throw new CorrectionError("INVALID_TARGET", "Choose one task, or the visit, to report a problem with.");
  }
  const user = await db.user.findFirst({ where: { id: ip.userId, householdId: ip.householdId, role: "IP" }, select: { name: true } });
  if (!user) throw new CorrectionError("FORBIDDEN", "Only the IP reports a completion error.", 403);

  let taskId: string | null = null;
  let shiftId: string;
  let linkedEventId: string;
  let label: string;
  let message: string;

  if (input.taskInstanceId) {
    const task = await db.taskInstance.findFirst({ where: { id: input.taskInstanceId, householdId: ip.householdId }, include: { shift: true } });
    if (!task || task.shift.ipUserId !== ip.userId) throw new CorrectionError("NOT_FOUND", "Task not found.", 404);
    if (!CORRECTABLE.includes(task.state)) {
      throw new CorrectionError("NOTHING_TO_CORRECT", "There is nothing recorded on this task to correct.", 409);
    }
    const last = await db.event.findFirst({
      where: { householdId: ip.householdId, taskInstanceId: task.id, action: { in: TASK_STEP_ACTIONS } },
      orderBy: { serverTimestampUtc: "desc" },
    });
    if (!last) throw new CorrectionError("NOTHING_TO_CORRECT", "There is nothing recorded on this task to correct.", 409);
    taskId = task.id;
    shiftId = task.shiftId;
    linkedEventId = last.id;
    label = task.titleSnapshot;
    message = `${user.name} reported a mistake on "${task.titleSnapshot}". Open Corrections to respond.`;
  } else {
    const shift = await db.scheduledShift.findFirst({ where: { id: input.shiftId!, householdId: ip.householdId, ipUserId: ip.userId } });
    if (!shift) throw new CorrectionError("NOT_FOUND", "Visit not found.", 404);
    const event = shift.checkOutEventId ?? shift.checkInEventId;
    if (!event) throw new CorrectionError("NOTHING_TO_CORRECT", "There is no check-in on this visit to report a problem with.", 409);
    shiftId = shift.id;
    linkedEventId = event;
    label = `check-in or checkout on ${shift.localDate}`;
    message = `${user.name} reported a problem with their check-in or checkout on ${shift.localDate}. Open Corrections to respond.`;
  }

  const open = await db.correctionRequest.findFirst({
    where: { householdId: ip.householdId, status: "OPEN", requestedByUserId: ip.userId, ...(taskId ? { taskInstanceId: taskId } : { shiftId, taskInstanceId: null }) },
    select: { id: true },
  });
  if (open) throw new CorrectionError("ALREADY_REPORTED", "You already reported this. It is waiting for an answer.", 409);

  const request = await db.$transaction(async (tx) => {
    const created = await tx.correctionRequest.create({
      data: { householdId: ip.householdId, requestedByUserId: ip.userId, taskInstanceId: taskId, shiftId, linkedEventId, reason },
    });
    await appendEvent(tx, {
      householdId: ip.householdId,
      actorUserId: ip.userId,
      actorRole: "IP",
      action: "correction_requested",
      shiftId,
      taskInstanceId: taskId,
      payload: { requestId: created.id, linkedEventId, reason, about: label },
    });
    await raiseAlert(tx, {
      householdId: ip.householdId,
      actorUserId: ip.userId,
      actorRole: "IP",
      type: "completion_error_reported",
      shiftId,
      message,
      refId: created.id,
      dedupeKey: `correction_request:${created.id}`,
    });
    return created;
  });
  return { id: request.id, status: request.status };
}

// ---------------------------------------------------------------------------------
// An administrator or the client appends a correction

export interface AppendInput {
  kind: CorrectionKind;
  linkedEventId: string;
  reason: string;
  requestId?: string;
}

/** Adds a correction linked to an original event. The original stays exactly as it was. */
export async function appendCorrection(actor: StaffActor, input: AppendInput) {
  if (!isStaff(actor.role)) throw new CorrectionError("FORBIDDEN", "Only the client or an administrator can append a correction.", 403);
  const reason = cleanReason(input.reason);

  const original = await db.event.findFirst({ where: { id: input.linkedEventId, householdId: actor.householdId } });
  if (!original) throw new CorrectionError("NOT_FOUND", "The recorded event to correct was not found.", 404);

  if (input.kind === "COMPLETION_ERROR") {
    if (!original.taskInstanceId) throw new CorrectionError("INVALID_TARGET", "A completion error has to be linked to a step recorded on a task.");
  } else if (input.kind === "ATTENDANCE") {
    if (!original.shiftId || !ATTENDANCE_ACTIONS.includes(original.action)) {
      throw new CorrectionError("INVALID_TARGET", "An attendance note has to be linked to a check-in, a checkout, or an automatic closure.");
    }
  }

  const request = input.requestId
    ? await db.correctionRequest.findFirst({ where: { id: input.requestId, householdId: actor.householdId } })
    : null;
  if (input.requestId) {
    if (!request) throw new CorrectionError("NOT_FOUND", "That request was not found.", 404);
    if (request.status !== "OPEN") throw new CorrectionError("ALREADY_ANSWERED", "That request was already answered.", 409);
    const sameTask = request.taskInstanceId !== null && request.taskInstanceId === original.taskInstanceId;
    const sameShift = request.taskInstanceId === null && request.shiftId !== null && request.shiftId === original.shiftId;
    if (!sameTask && !sameShift) throw new CorrectionError("REQUEST_MISMATCH", "This correction is about something other than what the IP reported.");
  }

  try {
    const correction = await db.$transaction(async (tx) => {
      const created = await tx.correction.create({
        data: {
          householdId: actor.householdId,
          kind: input.kind,
          linkedEventId: original.id,
          taskInstanceId: original.taskInstanceId,
          shiftId: original.shiftId,
          reason,
          byUserId: actor.userId,
          byRole: actor.role,
          requestId: request?.id ?? null,
        },
      });

      if (input.kind === "COMPLETION_ERROR") {
        // The recorded completion stays in the log; the task no longer counts as done and is open for the IP again.
        await transition(tx, original.taskInstanceId!, CORRECTABLE, { state: "COMPLETION_ERROR_CORRECTED", clientNote: null });
      }

      if (request) {
        const closed = await tx.correctionRequest.updateMany({
          where: { id: request.id, status: "OPEN" },
          data: { status: "RESOLVED", resolvedByUserId: actor.userId, resolvedAt: new Date(), correctionId: created.id },
        });
        if (closed.count !== 1) throw new CorrectionError("ALREADY_ANSWERED", "That request was already answered.", 409);
        await resolveAlerts(tx, actor.householdId, "completion_error_reported", request.id);
      }

      const event = await appendEvent(tx, {
        householdId: actor.householdId,
        actorUserId: actor.userId,
        actorRole: actor.role,
        action: "correction_appended",
        shiftId: original.shiftId,
        taskInstanceId: original.taskInstanceId,
        payload: { correctionId: created.id, kind: input.kind, linkedEventId: original.id, linkedAction: original.action, reason, requestId: request?.id ?? null },
      });
      await tx.correction.update({ where: { id: created.id }, data: { eventId: event.id } });
      return created;
    });

    if (request) notifyUsers(actor.householdId, [request.requestedByUserId], "Your report was answered", "Your report was reviewed. Open the app to see the answer.");
    return { id: correction.id };
  } catch (err) {
    if (err instanceof TaskActionRejectedError) {
      throw new CorrectionError("NOT_CORRECTABLE", "That task cannot be corrected as an error in its current state (it may already be corrected).", 409);
    }
    throw err;
  }
}

/** The request is closed without a correction. The reason is kept and shown to the IP. */
export async function declineRequest(actor: StaffActor, requestId: string, rawReason: string) {
  if (!isStaff(actor.role)) throw new CorrectionError("FORBIDDEN", "Only the client or an administrator can answer a report.", 403);
  const reason = cleanReason(rawReason);
  const request = await db.correctionRequest.findFirst({ where: { id: requestId, householdId: actor.householdId } });
  if (!request) throw new CorrectionError("NOT_FOUND", "That request was not found.", 404);

  await db.$transaction(async (tx) => {
    const closed = await tx.correctionRequest.updateMany({
      where: { id: requestId, status: "OPEN" },
      data: { status: "DECLINED", resolvedByUserId: actor.userId, resolvedAt: new Date(), declineReason: reason },
    });
    if (closed.count !== 1) throw new CorrectionError("ALREADY_ANSWERED", "That request was already answered.", 409);
    await resolveAlerts(tx, actor.householdId, "completion_error_reported", requestId);
    await appendEvent(tx, {
      householdId: actor.householdId,
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: "correction_request_declined",
      shiftId: request.shiftId,
      taskInstanceId: request.taskInstanceId,
      payload: { requestId, linkedEventId: request.linkedEventId, reason },
    });
  });
  notifyUsers(actor.householdId, [request.requestedByUserId], "Your report was answered", "Your report was reviewed. Open the app to see the answer.");
}

// ---------------------------------------------------------------------------------
// Lists

/** For the client and administrators: what is waiting, and what has been corrected. */
export async function listForStaff(householdId: string) {
  const [open, recent] = await Promise.all([
    db.correctionRequest.findMany({ where: { householdId, status: "OPEN" }, orderBy: { createdAt: "asc" } }),
    db.correction.findMany({ where: { householdId }, orderBy: { createdAt: "desc" }, take: 100 }),
  ]);
  const decided = await db.correctionRequest.findMany({ where: { householdId, status: "DECLINED" }, orderBy: { resolvedAt: "desc" }, take: 30 });

  const taskIds = [...open, ...recent, ...decided].map((r) => r.taskInstanceId).filter((id): id is string => id !== null);
  const shiftIds = [...open, ...recent, ...decided].map((r) => r.shiftId).filter((id): id is string => id !== null);
  const eventIds = [...open.map((r) => r.linkedEventId), ...recent.map((c) => c.linkedEventId), ...decided.map((r) => r.linkedEventId)];
  const userIds = [...open.map((r) => r.requestedByUserId), ...recent.map((c) => c.byUserId), ...decided.map((r) => r.requestedByUserId), ...decided.flatMap((r) => (r.resolvedByUserId ? [r.resolvedByUserId] : []))];

  const [tasks, shifts, events, users] = await Promise.all([
    db.taskInstance.findMany({ where: { id: { in: taskIds } }, select: { id: true, titleSnapshot: true, state: true } }),
    db.scheduledShift.findMany({ where: { id: { in: shiftIds } }, select: { id: true, localDate: true } }),
    db.event.findMany({ where: { id: { in: eventIds } }, select: { id: true, action: true, serverTimestampUtc: true } }),
    db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } }),
  ]);
  const taskOf = new Map(tasks.map((t) => [t.id, t]));
  const shiftOf = new Map(shifts.map((s) => [s.id, s]));
  const eventOf = new Map(events.map((e) => [e.id, e]));
  const nameOf = new Map(users.map((u) => [u.id, u.name]));

  const about = (taskId: string | null, shiftId: string | null) =>
    taskId ? (taskOf.get(taskId)?.titleSnapshot ?? "A task") : `Check-in or checkout on ${shiftOf.get(shiftId ?? "")?.localDate ?? "a visit"}`;

  return {
    open: open.map((r) => ({
      id: r.id,
      requestedBy: nameOf.get(r.requestedByUserId) ?? "The IP",
      about: about(r.taskInstanceId, r.shiftId),
      isTask: r.taskInstanceId !== null,
      reason: r.reason,
      linkedEventId: r.linkedEventId,
      linkedAction: eventOf.get(r.linkedEventId)?.action ?? null,
      taskState: r.taskInstanceId ? (taskOf.get(r.taskInstanceId)?.state ?? null) : null,
      requestedAt: r.createdAt,
    })),
    declined: decided.map((r) => ({
      id: r.id,
      requestedBy: nameOf.get(r.requestedByUserId) ?? "The IP",
      about: about(r.taskInstanceId, r.shiftId),
      reason: r.reason,
      declineReason: r.declineReason,
      decidedBy: r.resolvedByUserId ? (nameOf.get(r.resolvedByUserId) ?? null) : null,
      decidedAt: r.resolvedAt,
    })),
    corrections: recent.map((c) => ({
      id: c.id,
      kind: c.kind,
      about: about(c.taskInstanceId, c.shiftId),
      reason: c.reason,
      by: nameOf.get(c.byUserId) ?? "Someone",
      byRole: c.byRole,
      linkedAction: eventOf.get(c.linkedEventId)?.action ?? null,
      linkedAt: eventOf.get(c.linkedEventId)?.serverTimestampUtc ?? null,
      answeredRequest: c.requestId !== null,
      createdAt: c.createdAt,
    })),
  };
}

/** For the IP: their own reports and the answers, with no audit timestamps. */
export async function listForIp(ip: IpActor) {
  const since = new Date(Date.now() - 45 * 86_400_000);
  const rows = await db.correctionRequest.findMany({ where: { householdId: ip.householdId, requestedByUserId: ip.userId, createdAt: { gt: since } }, orderBy: { createdAt: "desc" }, take: 50 });
  const taskIds = rows.map((r) => r.taskInstanceId).filter((id): id is string => id !== null);
  const shiftIds = rows.map((r) => r.shiftId).filter((id): id is string => id !== null);
  const correctionIds = rows.map((r) => r.correctionId).filter((id): id is string => id !== null);
  const [tasks, shifts, corrections] = await Promise.all([
    db.taskInstance.findMany({ where: { id: { in: taskIds } }, select: { id: true, titleSnapshot: true } }),
    db.scheduledShift.findMany({ where: { id: { in: shiftIds } }, select: { id: true, localDate: true } }),
    db.correction.findMany({ where: { id: { in: correctionIds } }, select: { id: true, reason: true } }),
  ]);
  const taskOf = new Map(tasks.map((t) => [t.id, t.titleSnapshot]));
  const shiftOf = new Map(shifts.map((s) => [s.id, s.localDate]));
  const correctionOf = new Map(corrections.map((c) => [c.id, c.reason]));
  return rows.map((r) => ({
    id: r.id,
    about: r.taskInstanceId ? (taskOf.get(r.taskInstanceId) ?? "A task") : `Check-in or checkout on ${shiftOf.get(r.shiftId ?? "") ?? "a visit"}`,
    reason: r.reason,
    status: r.status,
    answer: r.status === "RESOLVED" ? (correctionOf.get(r.correctionId ?? "") ?? null) : r.status === "DECLINED" ? r.declineReason : null,
  }));
}

export type CorrectionTx = Prisma.TransactionClient;
