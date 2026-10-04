import { Router, type Response } from "express";
import { z } from "zod";
import { requireAuth, requireRole, type AuthenticatedRequest } from "../auth/middleware";
import {
  approveTask,
  confirmDecline,
  denyDecline,
  disputeTask,
  getPending,
  getReviewDay,
  ReviewRejectedError,
  type Viewer,
} from "../services/review.service";
import { addComment, CommentError } from "../services/comment.service";

/**
 * Reading is open to the client, administrators and family (family sees status
 * and history; times and photos only if the client approved that). Deciding is
 * the client's alone: an administrator or family member can see everything
 * they are allowed to but may not approve, dispute or confirm on the client's behalf.
 */
export const reviewRouter = Router();
reviewRouter.use(requireAuth);

function handleError(res: Response, err: unknown) {
  if (err instanceof ReviewRejectedError || err instanceof CommentError) {
    const status = err.code === "NOT_FOUND" ? 404 : err.code === "FORBIDDEN" ? 403 : 409;
    return res.status(status).json({ error: err.message, code: err.code });
  }
  throw err;
}

const viewerOf = (req: AuthenticatedRequest): Viewer => ({ role: req.auth!.role, canViewTimestamps: req.auth!.canViewTimestamps });

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const readers = requireRole("ADMIN", "CLIENT", "FAMILY");

reviewRouter.get("/day", readers, async (req: AuthenticatedRequest, res) => {
  const parsed = z.object({ date: dateStr }).safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: "Provide date as YYYY-MM-DD." });
  res.setHeader("Cache-Control", "no-store");
  return res.json({ shifts: await getReviewDay(req.auth!.householdId, parsed.data.date, viewerOf(req)) });
});

reviewRouter.get("/pending", readers, async (req: AuthenticatedRequest, res) => {
  res.setHeader("Cache-Control", "no-store");
  return res.json({ tasks: await getPending(req.auth!.householdId, viewerOf(req)) });
});

// Comments on a task (complete or not) or on one of its photos; never edited or deleted.
reviewRouter.post("/tasks/:id/comments", readers, async (req: AuthenticatedRequest, res) => {
  const parsed = z.object({ body: z.string(), evidenceId: z.string().uuid().nullable().optional() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Write a comment first." });
  try {
    const task = await addComment(
      { userId: req.auth!.userId, householdId: req.auth!.householdId, ...viewerOf(req) },
      req.params.id!,
      parsed.data.body,
      parsed.data.evidenceId
    );
    return res.status(201).json({ task });
  } catch (err) {
    if (err instanceof CommentError && err.code === "INVALID_BODY") return res.status(400).json({ error: err.message, code: err.code });
    return handleError(res, err);
  }
});

const clientOnly = requireRole("CLIENT");
const actor = (req: AuthenticatedRequest) => ({ userId: req.auth!.userId, householdId: req.auth!.householdId });

reviewRouter.post("/tasks/:id/approve", clientOnly, async (req: AuthenticatedRequest, res) => {
  try {
    return res.json({ task: await approveTask(actor(req), req.params.id!) });
  } catch (err) {
    return handleError(res, err);
  }
});

reviewRouter.post("/tasks/:id/dispute", clientOnly, async (req: AuthenticatedRequest, res) => {
  const parsed = z.object({ reason: z.string().trim().min(3) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Say what needs to be fixed.", code: "REASON_REQUIRED" });
  try {
    return res.json({ task: await disputeTask(actor(req), req.params.id!, parsed.data.reason) });
  } catch (err) {
    return handleError(res, err);
  }
});

reviewRouter.post("/tasks/:id/confirm-decline", clientOnly, async (req: AuthenticatedRequest, res) => {
  try {
    return res.json({ task: await confirmDecline(actor(req), req.params.id!) });
  } catch (err) {
    return handleError(res, err);
  }
});

reviewRouter.post("/tasks/:id/deny-decline", clientOnly, async (req: AuthenticatedRequest, res) => {
  const parsed = z.object({ note: z.string().optional() }).safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: "Invalid request" });
  try {
    return res.json({ task: await denyDecline(actor(req), req.params.id!, parsed.data.note) });
  } catch (err) {
    return handleError(res, err);
  }
});
