import type { Prisma, Role, TaskState } from "@prisma/client";
import { db } from "../db";
import { appendEvent } from "./event.service";
import { raiseAlert, resolveAlerts } from "./alert.service";

export class ReviewRejectedError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

export interface ClientActor {
  userId: string;
  householdId: string;
}

const REVIEWABLE: TaskState[] = ["COMPLETED_AWAITING_REVIEW", "CORRECTIVE_WORK_SUBMITTED"];
const AWAITING_DECISION: TaskState[] = [...REVIEWABLE, "DECLINED_AWAITING_CONFIRMATION"];

/**
 * One client decision on one task: an atomic state change plus its own audit
 * event. The original completion, any dispute, the corrective submission and
 * the final approval are all separate events; none rewrites another.
 */
async function decide(
  actor: ClientActor,
  taskId: string,
  from: TaskState[],
  data: Prisma.TaskInstanceUpdateManyMutationInput,
  action: string,
  payload: Record<string, unknown>,
  after?: (tx: Prisma.TransactionClient, task: { shiftId: string; titleSnapshot: string }) => Promise<void>
) {
  await db.$transaction(async (tx) => {
    const task = await tx.taskInstance.findFirst({ where: { id: taskId, householdId: actor.householdId } });
    if (!task) throw new ReviewRejectedError("NOT_FOUND", "Task not found.");

    const result = await tx.taskInstance.updateMany({ where: { id: taskId, state: { in: from } }, data });
    if (result.count !== 1) {
      throw new ReviewRejectedError("ALREADY_DECIDED", "This task has already been decided or is not waiting for a decision. Reload to see its current status.");
    }
    if (action === "task_decline_confirmed" || action === "task_decline_denied") {
      await resolveAlerts(tx, actor.householdId, "task_decline_reported", taskId);
    }

    await appendEvent(tx, {
      householdId: actor.householdId,
      actorUserId: actor.userId,
      actorRole: "CLIENT",
      action,
      shiftId: task.shiftId,
      taskInstanceId: task.id,
      payload,
    });
    await after?.(tx, task);
  });
  return getReviewTask(actor.householdId, taskId);
}

export const approveTask = (actor: ClientActor, taskId: string) =>
  decide(actor, taskId, REVIEWABLE, { state: "APPROVED", clientNote: null }, "task_approved", {});

export const disputeTask = async (actor: ClientActor, taskId: string, reason: string) => {
  const text = reason.trim();
  if (text.length < 3) throw new ReviewRejectedError("REASON_REQUIRED", "Say what needs to be fixed.");
  return decide(actor, taskId, REVIEWABLE, { state: "DISPUTED", clientNote: text }, "task_disputed", { reason: text }, async (tx, task) => {
    // The IP sees the reason on their task; admins get an alert.
    await raiseAlert(tx, {
      householdId: actor.householdId,
      actorUserId: actor.userId,
      actorRole: "CLIENT",
      type: "task_disputed",
      shiftId: task.shiftId,
      message: `The client disputed "${task.titleSnapshot}".`,
    });
  });
};

export const confirmDecline = (actor: ClientActor, taskId: string) =>
  decide(actor, taskId, ["DECLINED_AWAITING_CONFIRMATION"], { state: "CLIENT_DECLINED_CONFIRMED", clientNote: null }, "task_decline_confirmed", {});

/** The client says they did not decline: the task goes back to the IP to be done. */
export const denyDecline = (actor: ClientActor, taskId: string, note?: string) => {
  const text = note?.trim() || "The client would like this done.";
  return decide(actor, taskId, ["DECLINED_AWAITING_CONFIRMATION"], { state: "NOT_STARTED", clientNote: text }, "task_decline_denied", { note: text });
};

// --- Reading (client, administrators) ---------------------------------------

const HISTORY_ACTIONS = [
  "task_completed",
  "evidence_accepted",
  "task_disputed",
  "task_corrective_submitted",
  "task_approved",
  "task_decline_reported",
  "task_decline_confirmed",
  "task_decline_denied",
  "task_marked_not_needed",
  "task_marked_unable",
  "correction_requested",
  "correction_appended",
  "correction_request_declined",
];

const taskInclude = {
  template: { select: { groupName: true } },
  shift: { select: { localDate: true, ip: { select: { name: true } } } },
  evidence: {
    select: { id: true, eventId: true, contentHash: true, byteSize: true, uploadAcceptedAtServer: true, purgedAt: true },
    orderBy: { uploadAcceptedAtServer: "asc" as const },
  },
} satisfies Prisma.TaskInstanceInclude;

type TaskRow = Prisma.TaskInstanceGetPayload<{ include: typeof taskInclude }>;

export interface Viewer {
  role: Role;
  /** Family only: the client approved this person to see photos and times. */
  canViewTimestamps: boolean;
}

const CLIENT_VIEWER: Viewer = { role: "CLIENT", canViewTimestamps: true };

/** Family members see status and history; times and photos only if the client approved that. */
const seesTimes = (v: Viewer) => v.role !== "FAMILY" || v.canViewTimestamps;

const ROLE_LABELS: Record<string, string> = {
  ADMIN: "Administrator",
  CLIENT: "Client",
  FAMILY: "Family",
  IP: "Individual Provider",
};

async function toReviewTasks(householdId: string, tasks: TaskRow[], viewer: Viewer) {
  const ids = tasks.map((t) => t.id);
  const events = ids.length
    ? await db.event.findMany({
        where: { householdId, taskInstanceId: { in: ids }, action: { in: HISTORY_ACTIONS } },
        orderBy: { serverTimestampUtc: "asc" },
      })
    : [];
  const comments = ids.length
    ? await db.comment.findMany({ where: { householdId, taskInstanceId: { in: ids } }, orderBy: { createdAt: "asc" } })
    : [];

  const userIds = [
    ...new Set([
      ...events.map((e) => e.actorUserId).filter((id): id is string => id !== null),
      ...comments.map((c) => c.authorUserId),
    ]),
  ];
  const users = userIds.length ? await db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true, role: true } }) : [];
  const userById = new Map(users.map((u) => [u.id, u]));
  const byEventId = new Map(events.map((e) => [e.id, e]));
  const times = seesTimes(viewer);

  return tasks.map((t) => ({
    id: t.id,
    title: t.titleSnapshot,
    instructions: t.instructionsSnapshot,
    groupName: t.template.groupName,
    state: t.state,
    requiresPhoto: t.requiresPhotoSnapshot,
    reasonCode: t.reasonCode,
    reasonText: t.reasonText,
    clientNote: t.clientNote,
    shiftLocalDate: t.shift.localDate,
    ipName: t.shift.ip.name,
    photoCount: t.evidence.length,
    evidence: times
      ? t.evidence.map((e) => ({
          id: e.id,
          uploadAcceptedAtServer: e.uploadAcceptedAtServer,
          contentHashShort: e.contentHash.slice(0, 12),
          byteSize: e.byteSize,
          // The picture was removed after its year; the record that it was taken stays.
          removed: e.purgedAt !== null,
          locationVerification: ((byEventId.get(e.eventId)?.payload ?? {}) as { locationVerification?: string }).locationVerification ?? null,
        }))
      : [],
    history: events
      .filter((e) => e.taskInstanceId === t.id)
      .map((e) => {
        const p = (e.payload ?? {}) as { reason?: string; reasonText?: string; reasonCode?: string; note?: string };
        return {
          // Staff get the id so a correction can be linked to exactly this recorded step.
          eventId: viewer.role === "CLIENT" || viewer.role === "ADMIN" ? e.id : null,
          action: e.action,
          at: times ? e.serverTimestampUtc : null,
          actorRole: e.actorRole,
          actorName: e.actorUserId ? (userById.get(e.actorUserId)?.name ?? null) : null,
          detail: p.reason ?? p.note ?? (p.reasonCode ? [p.reasonCode.replace(/_/g, " "), p.reasonText].filter(Boolean).join(": ") : null),
        };
      }),
    comments: comments
      .filter((c) => c.taskInstanceId === t.id)
      // Comments on a photo are part of the photo: not shown to someone who may not see photos.
      .filter((c) => c.evidenceId === null || times)
      .map((c) => ({
        id: c.id,
        evidenceId: c.evidenceId,
        authorName: userById.get(c.authorUserId)?.name ?? "Someone",
        authorRole: userById.get(c.authorUserId)?.role ?? null,
        authorRoleLabel: ROLE_LABELS[userById.get(c.authorUserId)?.role ?? ""] ?? "",
        body: c.body,
        at: times ? c.createdAt : null,
      })),
  }));
}

export async function getReviewTask(householdId: string, taskId: string, viewer: Viewer = CLIENT_VIEWER) {
  const task = await db.taskInstance.findFirst({ where: { id: taskId, householdId }, include: taskInclude });
  if (!task) throw new ReviewRejectedError("NOT_FOUND", "Task not found.");
  return (await toReviewTasks(householdId, [task], viewer))[0]!;
}

/** Everything waiting on a decision, oldest first, across all days. */
export async function getPending(householdId: string, viewer: Viewer) {
  const tasks = await db.taskInstance.findMany({
    where: { householdId, state: { in: AWAITING_DECISION } },
    include: taskInclude,
    orderBy: { updatedAt: "asc" },
    take: 100,
  });
  return toReviewTasks(householdId, tasks, viewer);
}

/** One local day: each shift with every task assigned on it and where it stands. */
export async function getReviewDay(householdId: string, localDate: string, viewer: Viewer) {
  const shifts = await db.scheduledShift.findMany({
    where: { householdId, localDate, supersededAt: null },
    orderBy: { scheduledStartUtc: "asc" },
    include: { ip: { select: { name: true } }, taskInstances: { include: taskInclude, orderBy: { createdAt: "asc" } } },
  });

  const times = seesTimes(viewer);
  const out = [];
  for (const s of shifts) {
    out.push({
      id: s.id,
      ipName: s.ip.name,
      status: s.status,
      scheduledStartUtc: s.scheduledStartUtc,
      scheduledEndUtc: s.scheduledEndUtc,
      // Attendance times are audit timestamps: only for those approved to see them.
      checkInEventId: viewer.role === "CLIENT" || viewer.role === "ADMIN" ? s.checkInEventId : null,
      checkOutEventId: viewer.role === "CLIENT" || viewer.role === "ADMIN" ? s.checkOutEventId : null,
      observedCheckInUtc: times ? s.observedCheckInUtc : null,
      observedCheckOutUtc: times ? s.observedCheckOutUtc : null,
      checkedIn: s.observedCheckInUtc !== null,
      checkedOut: s.observedCheckOutUtc !== null,
      tasks: await toReviewTasks(householdId, s.taskInstances, viewer),
    });
  }
  return out;
}
