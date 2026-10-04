import { Router } from "express";
import { requireAuth, requireRole, type AuthenticatedRequest } from "../auth/middleware";
import { buildSummaries } from "../services/summary.service";

/**
 * Text for the "Hear" screen, written on the server so it reads the same on
 * every device. The IP does not use it. Family members get a shorter set with
 * no times or photo counts unless the client approved that.
 */
export const summariesRouter = Router();
summariesRouter.use(requireAuth, requireRole("ADMIN", "CLIENT", "FAMILY"));

summariesRouter.get("/", async (req: AuthenticatedRequest, res) => {
  res.setHeader("Cache-Control", "no-store");
  const a = req.auth!;
  const summaries = await buildSummaries({ userId: a.userId, householdId: a.householdId, role: a.role, canViewTimestamps: a.canViewTimestamps });
  return res.json({ summaries });
});
