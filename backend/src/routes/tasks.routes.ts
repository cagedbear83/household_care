import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireRole, type AuthenticatedRequest } from "../auth/middleware";
import {
  completeTask,
  declineOnClientBehalf,
  markTaskException,
  submitCorrectiveWork,
  TaskActionRejectedError,
} from "../services/task.service";
import { acceptEvidence, EvidenceRejectedError, issueChallenge } from "../services/evidence.service";
import { ipTaskById } from "../services/ip-dto";

export const tasksRouter = Router();
tasksRouter.use(requireAuth);

function handleTaskError(res: import("express").Response, err: unknown) {
  if (err instanceof TaskActionRejectedError || err instanceof EvidenceRejectedError) {
    return res.status(err.code === "NOT_FOUND" ? 404 : 409).json({ error: err.message, code: err.code });
  }
  throw err;
}

tasksRouter.post("/:id/complete", requireRole("IP"), async (req: AuthenticatedRequest, res) => {
  try {
    const task = await completeTask(req.params.id!, req.auth!.userId);
    return res.json({ task: await ipTaskById(task.id) });
  } catch (err) {
    return handleTaskError(res, err);
  }
});

// After the client disputes a task, the IP submits the corrected work (only while the shift is open).
tasksRouter.post("/:id/corrective", requireRole("IP"), async (req: AuthenticatedRequest, res) => {
  try {
    const task = await submitCorrectiveWork(req.params.id!, req.auth!.userId);
    return res.json({ task: await ipTaskById(task.id) });
  } catch (err) {
    return handleTaskError(res, err);
  }
});

const exceptionSchema = z.object({
  outcome: z.enum(["NOT_NEEDED", "UNABLE_TO_COMPLETE"]),
  reasonCode: z.enum(["supplies_unavailable", "insufficient_time", "equipment_problem", "other"]),
  reasonText: z.string().optional(),
});

tasksRouter.post("/:id/exception", requireRole("IP"), async (req: AuthenticatedRequest, res) => {
  const parsed = exceptionSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });

  try {
    const task = await markTaskException(
      req.params.id!,
      req.auth!.userId,
      parsed.data.outcome,
      parsed.data.reasonCode,
      parsed.data.reasonText
    );
    return res.json({ task: await ipTaskById(task.id) });
  } catch (err) {
    return handleTaskError(res, err);
  }
});

const declineSchema = z.object({ note: z.string().optional() });

tasksRouter.post("/:id/decline", requireRole("IP"), async (req: AuthenticatedRequest, res) => {
  const parsed = declineSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });

  try {
    const task = await declineOnClientBehalf(req.params.id!, req.auth!.userId, parsed.data.note);
    return res.json({ task: await ipTaskById(task.id) });
  } catch (err) {
    return handleTaskError(res, err);
  }
});

// Opening the in-app camera asks for a one-use ticket; the upload must present it.
tasksRouter.post("/:id/evidence/challenge", requireRole("IP"), async (req: AuthenticatedRequest, res) => {
  try {
    const challenge = await issueChallenge(req.auth!.userId, req.auth!.householdId, req.params.id!);
    return res.json({ challengeId: challenge.challengeId, expiresAt: challenge.expiresAt });
  } catch (err) {
    return handleTaskError(res, err);
  }
});

const evidenceSchema = z.object({
  challengeId: z.string().uuid(),
  imageBase64: z.string().min(1),
  capturedAtDevice: z.string().datetime().nullable().optional(),
  lat: z.number().min(-90).max(90).nullable().optional(),
  lng: z.number().min(-180).max(180).nullable().optional(),
  accuracyMeters: z.number().nonnegative().nullable().optional(),
});

tasksRouter.post("/:id/evidence", requireRole("IP"), async (req: AuthenticatedRequest, res) => {
  const parsed = evidenceSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid request" });

  try {
    await acceptEvidence({
      userId: req.auth!.userId,
      householdId: req.auth!.householdId,
      taskInstanceId: req.params.id!,
      ...parsed.data,
    });
    // The IP learns only that the photo was accepted, not audit details.
    return res.status(201).json({ task: await ipTaskById(req.params.id!) });
  } catch (err) {
    return handleTaskError(res, err);
  }
});
