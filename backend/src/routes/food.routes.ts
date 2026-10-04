import { Router, type Response } from "express";
import { z } from "zod";
import { requireAuth, requireRole, type AuthenticatedRequest } from "../auth/middleware";
import {
  acknowledgeHazard,
  approveRequest,
  createDisposalRequest,
  declineRequest,
  FoodError,
  issueFoodChallenge,
  listForIp,
  listForStaff,
  loadFoodPhoto,
  recordDisposal,
  reportHazard,
} from "../services/food.service";
import { EvidenceRejectedError } from "../services/image.service";

/**
 * Food disposal. The IP asks (or reports an immediate hazard); the client
 * approves or declines; only after approval does the IP throw it away and
 * record that it was done. Administrators can see everything and the photos
 * but cannot decide on the client's behalf.
 */
export const foodRouter = Router();
foodRouter.use(requireAuth);

const ip = (req: AuthenticatedRequest) => ({ userId: req.auth!.userId, householdId: req.auth!.householdId });
const staff = (req: AuthenticatedRequest) => ({ ...ip(req), role: req.auth!.role });

function handleError(res: Response, err: unknown) {
  if (err instanceof FoodError || err instanceof EvidenceRejectedError) {
    const status = err.code === "NOT_FOUND" ? 404 : err.code === "FORBIDDEN" ? 403 : err.code === "INVALID" ? 400 : 409;
    return res.status(status).json({ error: err.message, code: err.code });
  }
  throw err;
}

const photoFields = {
  challengeId: z.string().uuid(),
  imageBase64: z.string().min(1),
  lat: z.number().min(-90).max(90).nullable().optional(),
  lng: z.number().min(-180).max(180).nullable().optional(),
  accuracyMeters: z.number().nonnegative().nullable().optional(),
};

// --- IP ---

foodRouter.post("/photo-challenge", requireRole("IP"), async (req: AuthenticatedRequest, res) => {
  try {
    return res.json(await issueFoodChallenge(ip(req)));
  } catch (err) {
    return handleError(res, err);
  }
});

const requestSchema = z.object({
  item: z.string(),
  location: z.string(),
  reasonCode: z.string(),
  reasonText: z.string().optional(),
  dateLabel: z.string().optional(),
  replacement: z.string().optional(),
  ...photoFields,
});

foodRouter.post("/requests", requireRole("IP"), async (req: AuthenticatedRequest, res) => {
  const parsed = requestSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Fill in the item, where it is, why, and take the photo.", code: "INVALID" });
  try {
    const created = await createDisposalRequest(ip(req), parsed.data);
    return res.status(201).json({ id: created.id });
  } catch (err) {
    return handleError(res, err);
  }
});

const hazardSchema = z.object({
  item: z.string(),
  location: z.string(),
  reason: z.string(),
  actionTaken: z.string(),
  replacement: z.string().optional(),
  photo: z.object(photoFields).optional(),
});

foodRouter.post("/hazards", requireRole("IP"), async (req: AuthenticatedRequest, res) => {
  const parsed = hazardSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Say what it was, where, why it was a hazard, and what you did.", code: "INVALID" });
  try {
    const created = await reportHazard(ip(req), parsed.data);
    return res.status(201).json({ id: created.id });
  } catch (err) {
    return handleError(res, err);
  }
});

foodRouter.post("/requests/:id/dispose", requireRole("IP"), async (req: AuthenticatedRequest, res) => {
  try {
    await recordDisposal(ip(req), req.params.id!);
    return res.json({ ok: true });
  } catch (err) {
    return handleError(res, err);
  }
});

foodRouter.get("/mine", requireRole("IP"), async (req: AuthenticatedRequest, res) => {
  res.setHeader("Cache-Control", "no-store");
  return res.json({ requests: await listForIp(ip(req)) });
});

// --- Client and administrators ---

foodRouter.get("/requests", requireRole("ADMIN", "CLIENT"), async (req: AuthenticatedRequest, res) => {
  res.setHeader("Cache-Control", "no-store");
  return res.json(await listForStaff(req.auth!.householdId));
});

// Always the metadata-stripped copy, never cached.
foodRouter.get("/requests/:id/photo", requireRole("ADMIN", "CLIENT"), async (req: AuthenticatedRequest, res) => {
  const bytes = await loadFoodPhoto(req.auth!.householdId, req.params.id!);
  if (!bytes) return res.status(404).json({ error: "Not found" });
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "image/jpeg");
  return res.send(bytes);
});

const decide = (action: (a: ReturnType<typeof staff>, id: string, note?: string) => Promise<unknown>) =>
  async (req: AuthenticatedRequest, res: Response) => {
    const parsed = z.object({ note: z.string().optional() }).safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ error: "Invalid request" });
    try {
      await action(staff(req), req.params.id!, parsed.data.note);
      return res.json({ ok: true });
    } catch (err) {
      return handleError(res, err);
    }
  };

foodRouter.post("/requests/:id/approve", requireRole("CLIENT"), decide((a, id) => approveRequest(a, id)));
foodRouter.post("/requests/:id/decline", requireRole("CLIENT"), decide((a, id, note) => declineRequest(a, id, note)));
foodRouter.post("/requests/:id/acknowledge", requireRole("CLIENT"), decide((a, id) => acknowledgeHazard(a, id)));
