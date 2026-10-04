import { Router, type Response } from "express";
import { z } from "zod";
import { rateLimit } from "../auth/rate-limit";
import { requireAuth, requireRole, type AuthenticatedRequest } from "../auth/middleware";
import { getRetentionStatus, placeHold, releaseHold, RetentionError, setRetentionPolicy } from "../services/retention.service";

/**
 * How long records are kept. Reading is for the client and administrators;
 * every change asks for the password again and is audited.
 */
export const retentionRouter = Router();
retentionRouter.use(requireAuth, requireRole("ADMIN", "CLIENT"));

const actorOf = (req: AuthenticatedRequest) => ({ userId: req.auth!.userId, role: req.auth!.role, householdId: req.auth!.householdId });

function handleError(res: Response, err: unknown) {
  if (err instanceof RetentionError) return res.status(err.status).json({ error: err.message, code: err.code });
  throw err;
}

// Password re-checks are limited so this cannot be used to guess a password.
const guard = rateLimit({ max: 10, windowMs: 60_000 });

retentionRouter.get("/", async (req: AuthenticatedRequest, res) => {
  res.setHeader("Cache-Control", "no-store");
  return res.json(await getRetentionStatus(req.auth!.householdId));
});

const policySchema = z.object({ days: z.number(), reason: z.string().optional(), password: z.string() });

retentionRouter.post("/policy", guard, async (req: AuthenticatedRequest, res) => {
  const parsed = policySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Choose a period and enter your password.", code: "INVALID" });
  try {
    return res.json(await setRetentionPolicy(actorOf(req), parsed.data));
  } catch (err) {
    return handleError(res, err);
  }
});

const holdSchema = z.object({ reason: z.string(), fromDate: z.string().optional(), toDate: z.string().optional(), password: z.string() });

retentionRouter.post("/holds", guard, async (req: AuthenticatedRequest, res) => {
  const parsed = holdSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Say why, and enter your password.", code: "INVALID" });
  try {
    return res.status(201).json(await placeHold(actorOf(req), parsed.data));
  } catch (err) {
    return handleError(res, err);
  }
});

retentionRouter.post("/holds/:id/release", guard, async (req: AuthenticatedRequest, res) => {
  const parsed = z.object({ reason: z.string(), password: z.string() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Say why, and enter your password.", code: "INVALID" });
  try {
    return res.json(await releaseHold(actorOf(req), req.params.id!, parsed.data));
  } catch (err) {
    return handleError(res, err);
  }
});
