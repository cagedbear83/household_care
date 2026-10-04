import { Router, type Response } from "express";
import { requireAuth, requireRole, type AuthenticatedRequest } from "../auth/middleware";
import { AlertFeedError, listAlerts, markAllRead, markRead, unreadSummary } from "../services/alert-feed.service";

/** The in-app alert list, for the client and administrators. Read state is per person. */
export const alertsRouter = Router();
alertsRouter.use(requireAuth, requireRole("ADMIN", "CLIENT"));

const user = (req: AuthenticatedRequest) => ({
  userId: req.auth!.userId,
  role: req.auth!.role,
  householdId: req.auth!.householdId,
});

alertsRouter.use((_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});

function handleError(res: Response, err: unknown) {
  if (err instanceof AlertFeedError) return res.status(404).json({ error: err.message, code: err.code });
  throw err;
}

alertsRouter.get("/", async (req: AuthenticatedRequest, res) => res.json({ alerts: await listAlerts(user(req)) }));
alertsRouter.get("/unread", async (req: AuthenticatedRequest, res) => res.json(await unreadSummary(user(req))));

alertsRouter.post("/read-all", async (req: AuthenticatedRequest, res) => res.json({ marked: await markAllRead(user(req)) }));

alertsRouter.post("/:id/read", async (req: AuthenticatedRequest, res) => {
  try {
    await markRead(user(req), req.params.id!);
    return res.json({ ok: true });
  } catch (err) {
    return handleError(res, err);
  }
});
