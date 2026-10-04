import { Router, type Response } from "express";
import { z } from "zod";
import { rateLimit } from "../auth/rate-limit";
import { requireAuth, requireRole, type AuthenticatedRequest } from "../auth/middleware";
import { appendCorrection, CorrectionError, declineRequest, listForIp, listForStaff, requestCorrection } from "../services/correction.service";

/**
 * Corrections. The IP can only report a mistake; the client and administrators
 * append a correction (or decline the report). Nothing is edited or deleted.
 */
export const correctionsRouter = Router();
correctionsRouter.use(requireAuth);

function handleError(res: Response, err: unknown) {
  if (err instanceof CorrectionError) return res.status(err.status).json({ error: err.message, code: err.code });
  throw err;
}

const staff = requireRole("ADMIN", "CLIENT");
const actorOf = (req: AuthenticatedRequest) => ({ userId: req.auth!.userId, role: req.auth!.role, householdId: req.auth!.householdId });

// --- The IP reports a mistake -------------------------------------------------

const reportSchema = z.object({ taskInstanceId: z.string().optional(), shiftId: z.string().optional(), reason: z.string() });

correctionsRouter.post("/report", requireRole("IP"), rateLimit({ max: 20, windowMs: 60_000 }), async (req: AuthenticatedRequest, res) => {
  const parsed = reportSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Say what happened.", code: "REASON_REQUIRED" });
  try {
    const a = req.auth!;
    return res.status(201).json(await requestCorrection({ userId: a.userId, householdId: a.householdId }, parsed.data));
  } catch (err) {
    return handleError(res, err);
  }
});

correctionsRouter.get("/mine", requireRole("IP"), async (req: AuthenticatedRequest, res) => {
  res.setHeader("Cache-Control", "no-store");
  const a = req.auth!;
  return res.json({ requests: await listForIp({ userId: a.userId, householdId: a.householdId }) });
});

// --- The client and administrators --------------------------------------------

correctionsRouter.get("/", staff, async (req: AuthenticatedRequest, res) => {
  res.setHeader("Cache-Control", "no-store");
  return res.json(await listForStaff(req.auth!.householdId));
});

const appendSchema = z.object({
  kind: z.enum(["COMPLETION_ERROR", "ATTENDANCE", "NOTE"]),
  linkedEventId: z.string().min(1),
  reason: z.string(),
  requestId: z.string().optional(),
});

correctionsRouter.post("/", staff, async (req: AuthenticatedRequest, res) => {
  const parsed = appendSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Choose what to correct and say why.", code: "INVALID" });
  try {
    return res.status(201).json(await appendCorrection(actorOf(req), parsed.data));
  } catch (err) {
    return handleError(res, err);
  }
});

correctionsRouter.post("/requests/:id/decline", staff, async (req: AuthenticatedRequest, res) => {
  const parsed = z.object({ reason: z.string() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Say why the report is not being corrected.", code: "REASON_REQUIRED" });
  try {
    await declineRequest(actorOf(req), req.params.id!, parsed.data.reason);
    return res.json({ ok: true });
  } catch (err) {
    return handleError(res, err);
  }
});
