import type { ScheduledShift, TaskInstance } from "@prisma/client";
import { db } from "../db";
import { disputeTimes } from "./evidence.service";

/**
 * What an IP may see. The spec lets the IP see simple completion status and
 * their own attendance, but not task/evidence audit timestamps, so responses
 * are built from an explicit allow-list here rather than returning database
 * rows (which carry createdAt/updatedAt and internal ids).
 */
/** The status of the IP's latest "report completion error" on each task (no times). */
async function latestCorrectionStatus(taskIds: string[]): Promise<Map<string, string>> {
  const rows = await db.correctionRequest.findMany({
    where: { taskInstanceId: { in: taskIds } },
    select: { taskInstanceId: true, status: true },
    orderBy: { createdAt: "asc" },
  });
  const map = new Map<string, string>();
  for (const r of rows) if (r.taskInstanceId) map.set(r.taskInstanceId, r.status);
  return map;
}

export function toIpTaskDto(task: TaskInstance, hasEvidence: boolean) {
  return {
    id: task.id,
    titleSnapshot: task.titleSnapshot,
    instructionsSnapshot: task.instructionsSnapshot,
    requiresPhotoSnapshot: task.requiresPhotoSnapshot,
    state: task.state,
    reasonCode: task.reasonCode,
    reasonText: task.reasonText,
    // The client's message about this task (why it was disputed, or why a
    // reported decline was not accepted). Text only, no timestamps.
    clientNote: task.clientNote,
    hasEvidence,
  };
}

type TaskWithEvidence = TaskInstance & { evidence?: { id: string; uploadAcceptedAtServer: Date }[] };

/**
 * `hasEvidence` means "a photo is on file that counts". After a dispute only a
 * photo taken after the dispute counts, so the IP is asked for a new one.
 */
export async function toIpTaskDtos(tasks: TaskWithEvidence[]) {
  const reset = tasks.filter((t) => t.state === "DISPUTED" || t.state === "COMPLETION_ERROR_CORRECTED").map((t) => t.id);
  const since = await disputeTimes(reset);
  const requests = tasks.length ? await latestCorrectionStatus(tasks.map((t) => t.id)) : new Map<string, string>();
  return tasks.map((t) => {
    const evidence = t.evidence ?? [];
    const cutoff = t.state === "DISPUTED" || t.state === "COMPLETION_ERROR_CORRECTED" ? since.get(t.id) : undefined;
    const counts = cutoff ? evidence.some((e) => e.uploadAcceptedAtServer > cutoff) : evidence.length > 0;
    return { ...toIpTaskDto(t, counts), correctionStatus: requests.get(t.id) ?? null };
  });
}

export function toIpShiftDto(shift: ScheduledShift, tasks: ReturnType<typeof toIpTaskDto>[] = []) {
  return {
    id: shift.id,
    localDate: shift.localDate,
    scheduledStartUtc: shift.scheduledStartUtc,
    scheduledEndUtc: shift.scheduledEndUtc,
    status: shift.status,
    checkInEventId: shift.checkInEventId,
    checkOutEventId: shift.checkOutEventId,
    observedCheckInUtc: shift.observedCheckInUtc,
    observedCheckOutUtc: shift.observedCheckOutUtc,
    authorizedEndUtc: shift.authorizedEndUtc,
    authorizationClosedAt: shift.authorizationClosedAt,
    authorizationClosedReason: shift.authorizationClosedReason,
    taskInstances: tasks,
  };
}

export async function ipTaskById(taskId: string) {
  const task = await db.taskInstance.findUniqueOrThrow({
    where: { id: taskId },
    include: { evidence: { select: { id: true, uploadAcceptedAtServer: true } } },
  });
  return (await toIpTaskDtos([task]))[0]!;
}
