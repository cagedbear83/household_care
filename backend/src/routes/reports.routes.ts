import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireRole, type AuthenticatedRequest } from "../auth/middleware";
import { buildReport, ReportError } from "../services/report.service";

/**
 * Reports are built when asked for and never stored. The responses carry
 * no-store headers so browsers and proxies do not keep a copy either.
 */
export const reportsRouter = Router();
reportsRouter.use(requireAuth, requireRole("ADMIN", "CLIENT", "FAMILY"));

const querySchema = z.object({ from: z.string(), to: z.string() });

reportsRouter.get("/", async (req: AuthenticatedRequest, res) => {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("Pragma", "no-cache");
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: "Choose a start and an end date.", code: "INVALID_RANGE" });
  const a = req.auth!;
  try {
    const report = await buildReport({ userId: a.userId, householdId: a.householdId, role: a.role, canViewTimestamps: a.canViewTimestamps }, parsed.data);
    return res.json(report);
  } catch (err) {
    if (err instanceof ReportError) return res.status(400).json({ error: err.message, code: err.code });
    throw err;
  }
});
