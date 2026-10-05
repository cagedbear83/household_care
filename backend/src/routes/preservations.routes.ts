import { Router, type Response } from "express";
import { z } from "zod";
import { requireAuth, requireRole, type AuthenticatedRequest } from "../auth/middleware";
import { listPreservations, placePreservation, PreservationError, releasePreservation } from "../services/preservation.service";

/** Keep everything for a range of dates (an audit or a dispute). The client, administrators and the primary family member. */
export const preservationsRouter = Router();
preservationsRouter.use(requireAuth, requireRole("ADMIN", "CLIENT"));

const actorOf = (req: AuthenticatedRequest) => ({ userId: req.auth!.userId, role: req.auth!.role, householdId: req.auth!.householdId });

function handleError(res: Response, err: unknown) {
  if (err instanceof PreservationError) return res.status(err.status).json({ error: err.message, code: err.code });
  throw err;
}

preservationsRouter.get("/", async (req: AuthenticatedRequest, res) => {
  res.setHeader("Cache-Control", "no-store");
  return res.json({ preservations: await listPreservations(req.auth!.householdId) });
});

preservationsRouter.post("/", async (req: AuthenticatedRequest, res) => {
  const parsed = z.object({ fromDate: z.string(), toDate: z.string(), reason: z.string() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Choose the dates and say why.", code: "INVALID" });
  try {
    return res.status(201).json(await placePreservation(actorOf(req), parsed.data));
  } catch (err) {
    return handleError(res, err);
  }
});

preservationsRouter.post("/:id/release", async (req: AuthenticatedRequest, res) => {
  const parsed = z.object({ reason: z.string() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Say why.", code: "REASON_REQUIRED" });
  try {
    await releasePreservation(actorOf(req), req.params.id!, parsed.data.reason);
    return res.json({ ok: true });
  } catch (err) {
    return handleError(res, err);
  }
});
