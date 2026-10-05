import { Router, type Response } from "express";
import { z } from "zod";
import { requireAuth, requireRole, type AuthenticatedRequest } from "../auth/middleware";
import { AwayError, endAway, getAway, startAway } from "../services/away.service";

/**
 * Away mode: everyone can ask whether the client is away (the IP is only told
 * yes or no, never why); the client, administrators and the primary family
 * member can turn it on and off.
 */
export const awayRouter = Router();
awayRouter.use(requireAuth);

const actorOf = (req: AuthenticatedRequest) => ({ userId: req.auth!.userId, role: req.auth!.role, householdId: req.auth!.householdId });

function handleError(res: Response, err: unknown) {
  if (err instanceof AwayError) return res.status(err.status).json({ error: err.message, code: err.code });
  throw err;
}

awayRouter.get("/", async (req: AuthenticatedRequest, res) => {
  res.setHeader("Cache-Control", "no-store");
  return res.json(await getAway({ role: req.auth!.role, householdId: req.auth!.householdId }));
});

const startSchema = z.object({
  kind: z.enum(["HOSPITAL", "VACATION", "OTHER"]),
  expectedReturnDate: z.string().optional(),
  note: z.string().optional(),
});

awayRouter.post("/start", requireRole("CLIENT", "ADMIN"), async (req: AuthenticatedRequest, res) => {
  const parsed = startSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Choose hospital, vacation or other.", code: "INVALID" });
  try {
    return res.status(201).json(await startAway(actorOf(req), parsed.data));
  } catch (err) {
    return handleError(res, err);
  }
});

awayRouter.post("/end", requireRole("CLIENT", "ADMIN"), async (req: AuthenticatedRequest, res) => {
  try {
    await endAway(actorOf(req));
    return res.json({ ok: true });
  } catch (err) {
    return handleError(res, err);
  }
});
