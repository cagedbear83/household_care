import type { Prisma, TaskState } from "@prisma/client";
import { db } from "../db";
import { appendEvent } from "./event.service";
import { raiseAlert } from "./alert.service";
import { isShiftOpenForTaskSubmission } from "./authorization.service";
import { hasFreshEvidence } from "./evidence.service";
import { AWAY_MESSAGE, clientIsAway } from "./away.service";

export class TaskActionRejectedError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

const REASON_CODES = ["supplies_unavailable", "insufficient_time", "equipment_problem", "other"] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

/**
 * Snapshots every active "every visit" template into a TaskInstance for the
 * shift at check-in time. Weekly/monthly task distribution across a given
 * week's visits is an admin scheduling decision the spec leaves configurable
 * (see "Weekly and as-needed work") and is not assigned automatically yet —
 * this covers only the always-required daily checklist for now.
 */
export async function createVisitTaskInstances(
  tx: Prisma.TransactionClient,
  shift: { id: string; householdId: string; localDate: string }
) {
  const templates = await tx.taskTemplate.findMany({
    where: { householdId: shift.householdId, frequency: "VISIT", active: true },
    orderBy: { sortOrder: "asc" },
  });

  for (const template of templates) {
    const instance = await tx.taskInstance.create({
      data: {
        householdId: shift.householdId,
        shiftId: shift.id,
        templateId: template.id,
        assignedDate: shift.localDate,
        titleSnapshot: template.title,
        instructionsSnapshot: template.instructions,
        requiresPhotoSnapshot: template.requiresPhoto,
        state: "NOT_STARTED",
      },
    });

    await appendEvent(tx, {
      householdId: shift.householdId,
      actorUserId: null,
      actorRole: "ADMIN",
      action: "task_assigned",
      shiftId: shift.id,
      taskInstanceId: instance.id,
      payload: { templateId: template.id, title: template.title },
    });
  }
}

async function loadOpenTaskOrThrow(taskInstanceId: string, ipUserId: string) {
  const task = await db.taskInstance.findUnique({ where: { id: taskInstanceId } });
  if (!task) throw new TaskActionRejectedError("NOT_FOUND", "Task does not exist.");

  const shift = await db.scheduledShift.findUnique({ where: { id: task.shiftId } });
  if (!shift || shift.ipUserId !== ipUserId) {
    throw new TaskActionRejectedError("NOT_AUTHORIZED", "This task does not belong to your active shift.");
  }
  if (await clientIsAway(task.householdId)) {
    throw new TaskActionRejectedError("CLIENT_AWAY", AWAY_MESSAGE);
  }
  if (!(await isShiftOpenForTaskSubmission(task.shiftId))) {
    throw new TaskActionRejectedError(
      "SHIFT_NOT_OPEN",
      "This shift is not currently checked in and within its authorized window."
    );
  }
  return { task, shift };
}

/**
 * Moves a task between states only if it is still in one of the expected
 * states, atomically. This is what stops an IP from re-completing a task the
 * client already approved (or acting on stale screens): every transition says
 * which states it may start from.
 */
export async function transition(
  tx: Prisma.TransactionClient,
  taskId: string,
  from: TaskState[],
  data: Prisma.TaskInstanceUpdateManyMutationInput
) {
  const result = await tx.taskInstance.updateMany({ where: { id: taskId, state: { in: from } }, data });
  if (result.count !== 1) {
    throw new TaskActionRejectedError("TASK_STATE", "This task cannot be changed right now. Reload and check its status.");
  }
}

// A task whose completion was corrected as an error is open again for the IP.
const OPEN: TaskState[] = ["NOT_STARTED", "IN_PROGRESS", "COMPLETION_ERROR_CORRECTED"];

/** Completes a task. Photo-required tasks (e.g. the dishes/sink check) must
 * not reach COMPLETED_AWAITING_REVIEW until the server has accepted a photo
 * taken in the app. */
export async function completeTask(taskInstanceId: string, ipUserId: string) {
  const { task, shift } = await loadOpenTaskOrThrow(taskInstanceId, ipUserId);

  if (task.requiresPhotoSnapshot) {
    // After a correction an older photo no longer counts: a new one is needed.
    if (!(await hasFreshEvidence(taskInstanceId))) {
      throw new TaskActionRejectedError(
        "EVIDENCE_REQUIRED",
        "This task requires a fresh in-app photo before it can be completed."
      );
    }
  }

  const completed = await db.$transaction(async (tx) => {
    await transition(tx, task.id, OPEN, { state: "COMPLETED_AWAITING_REVIEW", clientNote: null });
    await appendEvent(tx, {
      householdId: shift.householdId,
      actorUserId: ipUserId,
      actorRole: "IP",
      action: "task_completed",
      shiftId: shift.id,
      taskInstanceId: task.id,
      payload: { completedAtUtc: new Date().toISOString() },
    });
    return tx.taskInstance.findUniqueOrThrow({ where: { id: task.id } });
  });

  await flagCompletionBurst(shift.id, shift.householdId, ipUserId);
  return completed;
}

/** How many tasks marked done within a minute counts as unusual (configurable). */
const burstThreshold = () => Number(process.env.COMPLETION_BURST_THRESHOLD ?? 15);

/**
 * A very fast run of completions is flagged for a person to look at. It is a
 * prompt to review, not a finding: the wording says so, and it never decides
 * anything. One alert per shift per ten minutes.
 */
async function flagCompletionBurst(shiftId: string, householdId: string, ipUserId: string) {
  try {
    const recent = await db.event.count({
      where: { shiftId, actorUserId: ipUserId, action: "task_completed", serverTimestampUtc: { gt: new Date(Date.now() - 60_000) } },
    });
    if (recent < burstThreshold()) return;
    await db.$transaction((tx) =>
      raiseAlert(tx, {
        householdId,
        actorUserId: ipUserId,
        actorRole: "IP",
        type: "suspicious_pattern",
        shiftId,
        message: `${recent} tasks were marked done within one minute. That is faster than usual and may need a look.`,
        dedupeKey: `burst:${shiftId}:${Math.floor(Date.now() / 600_000)}`,
      })
    );
  } catch {
    // Flagging must never get in the way of recording the work itself.
  }
}

/**
 * Corrective work after the client disputed a task. Submitted only while the
 * shift is open (the check in loadOpenTaskOrThrow), and for a photo task only
 * with a photo taken after the dispute. The original completion and the
 * dispute stay as their own events; this is a third one.
 */
export async function submitCorrectiveWork(taskInstanceId: string, ipUserId: string) {
  const { task, shift } = await loadOpenTaskOrThrow(taskInstanceId, ipUserId);

  if (task.requiresPhotoSnapshot && !(await hasFreshEvidence(task.id))) {
    throw new TaskActionRejectedError(
      "EVIDENCE_REQUIRED",
      "Take a new photo of the corrected work before submitting it."
    );
  }

  return db.$transaction(async (tx) => {
    await transition(tx, task.id, ["DISPUTED"], { state: "CORRECTIVE_WORK_SUBMITTED" });
    await appendEvent(tx, {
      householdId: shift.householdId,
      actorUserId: ipUserId,
      actorRole: "IP",
      action: "task_corrective_submitted",
      shiftId: shift.id,
      taskInstanceId: task.id,
      payload: { submittedAtUtc: new Date().toISOString() },
    });
    return tx.taskInstance.findUniqueOrThrow({ where: { id: task.id } });
  });
}

export async function markTaskException(
  taskInstanceId: string,
  ipUserId: string,
  outcome: "NOT_NEEDED" | "UNABLE_TO_COMPLETE",
  reasonCode: ReasonCode,
  reasonText?: string
) {
  if (reasonCode === "other" && !reasonText?.trim()) {
    throw new TaskActionRejectedError("REASON_REQUIRED", "'Other' requires a typed or dictated explanation.");
  }
  const { task, shift } = await loadOpenTaskOrThrow(taskInstanceId, ipUserId);

  return db.$transaction(async (tx) => {
    // A disputed task the IP cannot fix may be marked unable; nothing already
    // completed, approved or confirmed can be turned into an exception.
    await transition(tx, task.id, [...OPEN, "DISPUTED"], {
      state: outcome,
      reasonCode,
      reasonText: reasonText ?? null,
    });
    await appendEvent(tx, {
      householdId: shift.householdId,
      actorUserId: ipUserId,
      actorRole: "IP",
      action: outcome === "NOT_NEEDED" ? "task_marked_not_needed" : "task_marked_unable",
      shiftId: shift.id,
      taskInstanceId: task.id,
      payload: { reasonCode, reasonText: reasonText ?? null },
    });
    return tx.taskInstance.findUniqueOrThrow({ where: { id: task.id } });
  });
}

/** An IP-entered meal/food decline stays "awaiting confirmation" until the
 * client confirms or denies it — it is never itself a completed or accepted
 * state. */
export async function declineOnClientBehalf(taskInstanceId: string, ipUserId: string, note?: string) {
  const { task, shift } = await loadOpenTaskOrThrow(taskInstanceId, ipUserId);

  return db.$transaction(async (tx) => {
    await transition(tx, task.id, OPEN, { state: "DECLINED_AWAITING_CONFIRMATION" });
    await appendEvent(tx, {
      householdId: shift.householdId,
      actorUserId: ipUserId,
      actorRole: "IP",
      action: "task_decline_reported",
      shiftId: shift.id,
      taskInstanceId: task.id,
      payload: { note: note ?? null },
    });
    await raiseAlert(tx, {
      householdId: shift.householdId,
      actorUserId: ipUserId,
      actorRole: "IP",
      type: "task_decline_reported",
      shiftId: shift.id,
      message: `The IP says the client declined "${task.titleSnapshot}". Waiting for the client to confirm.`,
      refId: task.id,
    });
    return tx.taskInstance.findUniqueOrThrow({ where: { id: task.id } });
  });
}
