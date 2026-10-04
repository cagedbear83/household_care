import { Router, type Response } from "express";
import { requireAuth, type AuthenticatedRequest } from "../auth/middleware";
import { db } from "../db";
import { listTaskEvidence, loadViewerImage } from "../services/evidence.service";

// Evidence is visible to the client and administrators, and to a family
// viewer only when the client explicitly approved timestamp/evidence access.
// IPs never read evidence back, so there is no audit data for them to see.
export const evidenceRouter = Router();
evidenceRouter.use(requireAuth);

async function mayViewEvidence(req: AuthenticatedRequest): Promise<boolean> {
  const role = req.auth!.role;
  if (role === "ADMIN" || role === "CLIENT") return true;
  if (role === "FAMILY") {
    const user = await db.user.findUnique({ where: { id: req.auth!.userId }, select: { canViewTimestamps: true } });
    return Boolean(user?.canViewTimestamps);
  }
  return false;
}

function noStore(res: Response) {
  res.setHeader("Cache-Control", "no-store");
}

evidenceRouter.get("/task/:taskId", async (req: AuthenticatedRequest, res) => {
  if (!(await mayViewEvidence(req))) return res.status(403).json({ error: "Not authorized for this action" });
  noStore(res);
  return res.json({ evidence: await listTaskEvidence(req.auth!.householdId, req.params.taskId!) });
});

// Always the metadata-stripped copy. The original is kept for audit and is not served here.
evidenceRouter.get("/:id/image", async (req: AuthenticatedRequest, res) => {
  if (!(await mayViewEvidence(req))) return res.status(403).json({ error: "Not authorized for this action" });
  const bytes = await loadViewerImage(req.auth!.householdId, req.params.id!);
  if (!bytes) return res.status(404).json({ error: "Not found" });
  noStore(res);
  res.setHeader("Content-Type", "image/jpeg");
  return res.send(bytes);
});
