import { Router, type Response } from "express";
import { z } from "zod";
import { requireAuth, requireRole, type AuthenticatedRequest } from "../auth/middleware";
import { createInvite, InviteError, listFamily, resendInvite, revokeFamilyMember, setFamilyVisibility } from "../services/invite.service";

/**
 * Family access. The client controls it; an administrator may help with setup
 * (add an invitation, resend it) but only the client can approve photo/time
 * access or turn someone's access off.
 */
export const familyRouter = Router();
familyRouter.use(requireAuth, requireRole("ADMIN", "CLIENT"));

const actorOf = (req: AuthenticatedRequest) => ({ userId: req.auth!.userId, role: req.auth!.role, householdId: req.auth!.householdId });

function handleError(res: Response, err: unknown) {
  if (err instanceof InviteError) return res.status(err.status).json({ error: err.message, code: err.code });
  throw err;
}

familyRouter.get("/", async (req: AuthenticatedRequest, res) => {
  res.setHeader("Cache-Control", "no-store");
  return res.json({ family: await listFamily(req.auth!.householdId) });
});

const inviteSchema = z.object({
  firstName: z.string(),
  lastName: z.string(),
  email: z.string().optional(),
  phone: z.string().optional(),
  relationship: z.string().optional(),
  canViewTimestamps: z.boolean().optional(),
});

familyRouter.post("/invites", async (req: AuthenticatedRequest, res) => {
  const parsed = inviteSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Enter a first name, a last name, and an email address or phone number." });
  try {
    const { invite, delivery } = await createInvite(actorOf(req), parsed.data);
    return res.status(201).json({ id: invite.id, delivery });
  } catch (err) {
    return handleError(res, err);
  }
});

familyRouter.post("/:id/resend", async (req: AuthenticatedRequest, res) => {
  try {
    const { invite, delivery } = await resendInvite(actorOf(req), req.params.id!);
    return res.json({ id: invite.id, delivery });
  } catch (err) {
    return handleError(res, err);
  }
});

familyRouter.post("/:id/revoke", requireRole("CLIENT"), async (req: AuthenticatedRequest, res) => {
  try {
    await revokeFamilyMember(actorOf(req), req.params.id!);
    return res.json({ ok: true });
  } catch (err) {
    return handleError(res, err);
  }
});

familyRouter.patch("/:id", requireRole("CLIENT"), async (req: AuthenticatedRequest, res) => {
  const parsed = z.object({ canViewTimestamps: z.boolean() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid request" });
  try {
    await setFamilyVisibility(actorOf(req), req.params.id!, parsed.data.canViewTimestamps);
    return res.json({ ok: true });
  } catch (err) {
    return handleError(res, err);
  }
});
