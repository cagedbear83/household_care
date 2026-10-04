import type { Role } from "@prisma/client";
import { db } from "../db";
import { appendEvent } from "./event.service";
import { getReviewTask, type Viewer } from "./review.service";

export class CommentError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

export interface CommentActor extends Viewer {
  userId: string;
  householdId: string;
  role: Role;
}

const MAX_LENGTH = 2000;

/**
 * Adds a comment to a task (complete or not) or, with evidenceId, to one of
 * its photos. Comments are never edited or deleted; a correction is another
 * comment. IPs cannot comment here (their channel is chat), and a family
 * member can comment on a photo only if the client approved them to see photos.
 */
export async function addComment(actor: CommentActor, taskInstanceId: string, rawBody: string, evidenceId?: string | null) {
  if (actor.role === "IP") throw new CommentError("FORBIDDEN", "Comments are for the client, administrators and family.");
  const body = rawBody.trim();
  if (body.length < 1 || body.length > MAX_LENGTH) {
    throw new CommentError("INVALID_BODY", `Write a comment of 1 to ${MAX_LENGTH} characters.`);
  }

  const task = await db.taskInstance.findFirst({ where: { id: taskInstanceId, householdId: actor.householdId } });
  if (!task) throw new CommentError("NOT_FOUND", "Task not found.");

  if (evidenceId) {
    if (actor.role === "FAMILY" && !actor.canViewTimestamps) {
      throw new CommentError("FORBIDDEN", "The client has not approved you to see or comment on photos.");
    }
    const evidence = await db.evidence.findFirst({ where: { id: evidenceId, taskInstanceId } });
    if (!evidence) throw new CommentError("NOT_FOUND", "Photo not found on this task.");
  }

  await db.$transaction(async (tx) => {
    const comment = await tx.comment.create({
      data: { householdId: actor.householdId, taskInstanceId, evidenceId: evidenceId ?? null, authorUserId: actor.userId, body },
    });
    await appendEvent(tx, {
      householdId: actor.householdId,
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: "comment_added",
      shiftId: task.shiftId,
      taskInstanceId,
      payload: { commentId: comment.id, evidenceId: evidenceId ?? null, body },
    });
  });

  return getReviewTask(actor.householdId, taskInstanceId, actor);
}
