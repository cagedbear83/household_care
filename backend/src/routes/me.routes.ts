import { Router, type Response } from "express";
import { z } from "zod";
import { db } from "../db";
import { rateLimit } from "../auth/rate-limit";
import { requireAuth, type AuthenticatedRequest } from "../auth/middleware";
import { changePassword, confirmContactChange, getProfile, ProfileError, startContactChange, updateName } from "../services/profile.service";

/** Who is signed in and the household settings every screen needs (any role), plus "Settings": a person's own information. */
export const meRouter = Router();
meRouter.use(requireAuth);

function handleError(res: Response, err: unknown) {
  if (err instanceof ProfileError) return res.status(err.status).json({ error: err.message, code: err.code });
  throw err;
}

meRouter.get("/", async (req: AuthenticatedRequest, res) => {
  const user = await db.user.findUniqueOrThrow({ where: { id: req.auth!.userId } });
  const household = await db.household.findUniqueOrThrow({ where: { id: user.householdId } });
  res.setHeader("Cache-Control", "no-store");
  return res.json({
    user: {
      id: user.id,
      name: user.name,
      role: user.role,
      email: user.email,
      phone: user.phone,
      canViewTimestamps: user.canViewTimestamps,
    },
    household: { timezone: household.timezone, workweekStartWeekday: household.workweekStartWeekday },
  });
});

meRouter.get("/profile", async (req: AuthenticatedRequest, res) => {
  res.setHeader("Cache-Control", "no-store");
  return res.json({ profile: await getProfile(req.auth!.userId) });
});

const nameSchema = z.object({ firstName: z.string(), lastName: z.string().optional() });

meRouter.patch("/profile", async (req: AuthenticatedRequest, res) => {
  const parsed = nameSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Enter your first name.", code: "INVALID_NAME" });
  try {
    return res.json({ profile: await updateName(req.auth!.userId, parsed.data) });
  } catch (err) {
    return handleError(res, err);
  }
});

const passwordSchema = z.object({ currentPassword: z.string().min(1), newPassword: z.string().min(1) });

meRouter.post("/password", rateLimit({ max: 10, windowMs: 60_000 }), async (req: AuthenticatedRequest, res) => {
  const parsed = passwordSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Enter your current password and a new one.", code: "INVALID" });
  try {
    return res.json(await changePassword(req.auth!.userId, parsed.data.currentPassword, parsed.data.newPassword));
  } catch (err) {
    return handleError(res, err);
  }
});

meRouter.post("/contact/start", rateLimit({ max: 10, windowMs: 60_000 }), async (req: AuthenticatedRequest, res) => {
  const parsed = z.object({ value: z.string().min(1) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Enter an email address or phone number.", code: "INVALID_CONTACT" });
  try {
    return res.json(await startContactChange(req.auth!.userId, parsed.data.value));
  } catch (err) {
    return handleError(res, err);
  }
});

meRouter.post("/contact/confirm", rateLimit({ max: 20, windowMs: 60_000 }), async (req: AuthenticatedRequest, res) => {
  const parsed = z.object({ code: z.string().min(1) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Enter the 6-digit code.", code: "CODE_INVALID" });
  try {
    return res.json({ profile: await confirmContactChange(req.auth!.userId, parsed.data.code) });
  } catch (err) {
    return handleError(res, err);
  }
});
