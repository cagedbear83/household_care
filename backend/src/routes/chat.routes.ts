import { Router, type Response } from "express";
import { z } from "zod";
import { requireAuth, type AuthenticatedRequest } from "../auth/middleware";
import { ChatError, getMessages, listConversations, listPeople, markRead, sendMessage, startDirect, unreadTotal } from "../services/chat.service";

/** Household chat: one group chat plus direct messages, for every signed-in role. */
export const chatRouter = Router();
chatRouter.use(requireAuth);

const me = (req: AuthenticatedRequest) => ({ userId: req.auth!.userId, householdId: req.auth!.householdId });

function handleError(res: Response, err: unknown) {
  if (err instanceof ChatError) {
    const status = err.code === "NOT_FOUND" ? 404 : err.code === "FORBIDDEN" ? 403 : err.code === "INVALID_BODY" || err.code === "INVALID" ? 400 : 409;
    return res.status(status).json({ error: err.message, code: err.code });
  }
  throw err;
}

chatRouter.use((_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});

chatRouter.get("/people", async (req: AuthenticatedRequest, res) => res.json({ people: await listPeople(me(req)) }));

chatRouter.get("/conversations", async (req: AuthenticatedRequest, res) => {
  try {
    return res.json({ conversations: await listConversations(me(req)) });
  } catch (err) {
    return handleError(res, err);
  }
});

chatRouter.get("/unread", async (req: AuthenticatedRequest, res) => {
  try {
    return res.json({ unread: await unreadTotal(me(req)) });
  } catch (err) {
    return handleError(res, err);
  }
});

chatRouter.post("/direct", async (req: AuthenticatedRequest, res) => {
  const parsed = z.object({ userId: z.string().uuid() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Choose someone to message." });
  try {
    return res.json(await startDirect(me(req), parsed.data.userId));
  } catch (err) {
    return handleError(res, err);
  }
});

chatRouter.get("/conversations/:id/messages", async (req: AuthenticatedRequest, res) => {
  const afterId = typeof req.query.afterId === "string" ? req.query.afterId : undefined;
  try {
    return res.json({ messages: await getMessages(me(req), req.params.id!, { afterId }) });
  } catch (err) {
    return handleError(res, err);
  }
});

chatRouter.post("/conversations/:id/messages", async (req: AuthenticatedRequest, res) => {
  const parsed = z.object({ body: z.string() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Write a message first." });
  try {
    return res.status(201).json(await sendMessage(me(req), req.params.id!, parsed.data.body));
  } catch (err) {
    return handleError(res, err);
  }
});

chatRouter.post("/conversations/:id/read", async (req: AuthenticatedRequest, res) => {
  try {
    await markRead(me(req), req.params.id!);
    return res.json({ ok: true });
  } catch (err) {
    return handleError(res, err);
  }
});
