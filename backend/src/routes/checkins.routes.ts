import { Router, type Response } from "express";
import { z } from "zod";
import { requireAuth, requireRole, type AuthenticatedRequest } from "../auth/middleware";
import { CheckInError, dueToday, history, listPlans, setPaused, setPlan, skip, submit } from "../services/checkin.service";

/**
 * Wellbeing check-ins. The IP has no access to any of this: every route is for
 * the client side (the client and the primary family member) or administrators,
 * and only an administrator can read answers.
 */
export const checkinsRouter = Router();
checkinsRouter.use(requireAuth, requireRole("CLIENT", "ADMIN"));
checkinsRouter.use((_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});

const actorOf = (req: AuthenticatedRequest) => ({
  userId: req.auth!.userId,
  role: req.auth!.role,
  ownRole: req.auth!.primaryFamily ? ("FAMILY" as const) : req.auth!.role,
  householdId: req.auth!.householdId,
});

function handleError(res: Response, err: unknown) {
  if (err instanceof CheckInError) return res.status(err.status).json({ error: err.message, code: err.code });
  throw err;
}

const instrument = z.enum(["PHQ2", "GAD2"]);

checkinsRouter.get("/plans", async (req: AuthenticatedRequest, res) => {
  try {
    return res.json({ plans: await listPlans(actorOf(req)) });
  } catch (err) {
    return handleError(res, err);
  }
});

const planSchema = z.object({
  instrument,
  everyDays: z.number().int().min(1).max(3),
  active: z.boolean().optional(),
  clientAgreed: z.boolean().default(false),
  consentNote: z.string().max(200).optional(),
});

checkinsRouter.put("/plans", requireRole("ADMIN"), async (req: AuthenticatedRequest, res) => {
  const parsed = planSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Choose a check-in and how often.", code: "INVALID" });
  try {
    await setPlan(actorOf(req), parsed.data);
    return res.json({ ok: true });
  } catch (err) {
    return handleError(res, err);
  }
});

checkinsRouter.post("/plans/:instrument/pause", async (req: AuthenticatedRequest, res) => {
  const inst = instrument.safeParse(req.params.instrument);
  if (!inst.success) return res.status(400).json({ error: "Unknown check-in.", code: "INVALID" });
  try {
    await setPaused(actorOf(req), inst.data, true);
    return res.json({ ok: true });
  } catch (err) {
    return handleError(res, err);
  }
});

checkinsRouter.post("/plans/:instrument/resume", async (req: AuthenticatedRequest, res) => {
  const inst = instrument.safeParse(req.params.instrument);
  if (!inst.success) return res.status(400).json({ error: "Unknown check-in.", code: "INVALID" });
  try {
    await setPaused(actorOf(req), inst.data, false);
    return res.json({ ok: true });
  } catch (err) {
    return handleError(res, err);
  }
});

checkinsRouter.get("/due", async (req: AuthenticatedRequest, res) => {
  return res.json(await dueToday(actorOf(req)));
});

checkinsRouter.post("/:instrument/answer", async (req: AuthenticatedRequest, res) => {
  const inst = instrument.safeParse(req.params.instrument);
  const body = z.object({ answers: z.array(z.number().int().min(0).max(3)).min(1).max(5) }).safeParse(req.body);
  if (!inst.success || !body.success) return res.status(400).json({ error: "Please answer every question.", code: "INVALID" });
  try {
    return res.status(201).json(await submit(actorOf(req), inst.data, body.data.answers));
  } catch (err) {
    return handleError(res, err);
  }
});

checkinsRouter.post("/:instrument/skip", async (req: AuthenticatedRequest, res) => {
  const inst = instrument.safeParse(req.params.instrument);
  if (!inst.success) return res.status(400).json({ error: "Unknown check-in.", code: "INVALID" });
  try {
    return res.status(201).json(await skip(actorOf(req), inst.data));
  } catch (err) {
    return handleError(res, err);
  }
});

checkinsRouter.get("/history", requireRole("ADMIN"), async (req: AuthenticatedRequest, res) => {
  const inst = typeof req.query.instrument === "string" ? instrument.safeParse(req.query.instrument) : null;
  const days = Number(req.query.days);
  try {
    return res.json({ responses: await history(actorOf(req), { instrument: inst?.success ? inst.data : undefined, days: Number.isFinite(days) ? days : undefined }) });
  } catch (err) {
    return handleError(res, err);
  }
});
