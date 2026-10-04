import { Router, type Response } from "express";
import { z } from "zod";
import { rateLimit } from "../auth/rate-limit";
import { acceptInvite, getInvitePublic, InviteError, startOtherContact, verifyOtherContact } from "../services/invite.service";

/**
 * The family member's side of an invitation. These are public (the person has
 * no account yet); the long random token in the link is the credential, and
 * every call is rate limited.
 */
export const invitesRouter = Router();
invitesRouter.use(rateLimit({ max: 60, windowMs: 60_000 }));

function handleError(res: Response, err: unknown) {
  if (err instanceof InviteError) return res.status(err.status).json({ error: err.message, code: err.code });
  throw err;
}

invitesRouter.get("/:token", async (req, res) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    return res.json(await getInvitePublic(req.params.token!));
  } catch (err) {
    return handleError(res, err);
  }
});

invitesRouter.post("/:token/accept", async (req, res) => {
  const parsed = z.object({ firstName: z.string(), lastName: z.string(), password: z.string(), confirmContact: z.boolean() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Fill in every field." });
  try {
    return res.json(await acceptInvite(req.params.token!, parsed.data));
  } catch (err) {
    return handleError(res, err);
  }
});

invitesRouter.post("/:token/other-contact", async (req, res) => {
  const parsed = z.object({ value: z.string().min(1) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Enter the email address or phone number to add." });
  try {
    return res.json(await startOtherContact(req.params.token!, parsed.data.value));
  } catch (err) {
    return handleError(res, err);
  }
});

invitesRouter.post("/:token/verify", async (req, res) => {
  const parsed = z.object({ code: z.string().regex(/^\d{6}$/, "The code is 6 digits.") }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Enter the 6-digit code." });
  try {
    return res.json(await verifyOtherContact(req.params.token!, parsed.data.code));
  } catch (err) {
    return handleError(res, err);
  }
});
