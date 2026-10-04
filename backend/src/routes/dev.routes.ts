import { Router } from "express";
import { db } from "../db";
import { requireAuth, requireRole, type AuthenticatedRequest } from "../auth/middleware";
import { devOutboxEnabled } from "../services/notify.service";

/** Development only: shows the messages that would have been emailed or texted. Not mounted in production. */
export const devRouter = Router();
devRouter.use(requireAuth, requireRole("ADMIN", "CLIENT"));

devRouter.get("/outbox", async (req: AuthenticatedRequest, res) => {
  if (!devOutboxEnabled()) return res.status(404).json({ error: "Not found" });
  const messages = await db.outboundMessage.findMany({
    where: { householdId: req.auth!.householdId },
    orderBy: { createdAt: "desc" },
    take: 30,
  });
  return res.json({ messages });
});
