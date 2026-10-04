import { Router } from "express";
import { z } from "zod";
import { db } from "../db";
import { verifyPassword } from "../auth/password";
import { signAuthToken } from "../auth/jwt";
import { rateLimit } from "../auth/rate-limit";
import { parseIdentifier } from "../services/contact.service";
import { completePasswordReset, requestPasswordReset, ResetError } from "../services/password-reset.service";

export const authRouter = Router();

// An email address or a phone number, whichever the person signs in with.
const loginSchema = z.object({
  identifier: z.string().min(1),
  password: z.string().min(1),
});

// Password reset: ask for a code, then use it. "forgot" always answers the same way.
authRouter.post("/forgot", rateLimit({ max: 10, windowMs: 60_000 }), async (req, res) => {
  const parsed = z.object({ identifier: z.string().min(1) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Enter your email address or phone number." });
  const { devCode } = await requestPasswordReset(parsed.data.identifier);
  return res.json({ ok: true, message: "If there is an account for that, we have sent a 6-digit code to it.", devCode });
});

authRouter.post("/reset", rateLimit({ max: 20, windowMs: 60_000 }), async (req, res) => {
  const parsed = z.object({ identifier: z.string().min(1), code: z.string().regex(/^\d{6}$/), newPassword: z.string().min(1) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Enter the 6-digit code and a new password.", code: "RESET_INVALID" });
  try {
    await completePasswordReset(parsed.data.identifier, parsed.data.code, parsed.data.newPassword);
    return res.json({ ok: true });
  } catch (err) {
    if (err instanceof ResetError) return res.status(err.status).json({ error: err.message, code: err.code });
    throw err;
  }
});

authRouter.post("/login", rateLimit({ max: 30, windowMs: 60_000 }), async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
  }

  const { password } = parsed.data;
  const contact = parseIdentifier(parsed.data.identifier);
  const user = contact
    ? await db.user.findUnique({ where: contact.channel === "EMAIL" ? { email: contact.value } : { phone: contact.value } })
    : null;

  // Deliberately identical response whether the account is unknown, not yet
  // activated, turned off, or the password is wrong, so the endpoint does not
  // leak which emails/phone numbers have accounts.
  if (!user || !user.active || user.accessRevokedAt || !(await verifyPassword(password, user.passwordHash))) {
    return res.status(401).json({ error: "Invalid email, phone number or password" });
  }

  const token = signAuthToken({ userId: user.id, householdId: user.householdId, role: user.role });
  return res.json({
    token,
    user: { id: user.id, name: user.name, role: user.role, householdId: user.householdId },
  });
});
