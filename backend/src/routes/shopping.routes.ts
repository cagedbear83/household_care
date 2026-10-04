import { Router, type Response } from "express";
import { z } from "zod";
import { requireAuth, requireRole, type AuthenticatedRequest } from "../auth/middleware";
import { addItem, closeItem, listShopping, reportLowSupply, ShoppingError, updateItem } from "../services/shopping.service";

/**
 * The household shopping list. The client and administrators keep it; an IP
 * can only report that something is low or gone (there is no shopping duty).
 */
export const shoppingRouter = Router();
shoppingRouter.use(requireAuth);

const actor = (req: AuthenticatedRequest) => ({ userId: req.auth!.userId, role: req.auth!.role, householdId: req.auth!.householdId });

function handleError(res: Response, err: unknown) {
  if (err instanceof ShoppingError) {
    const status = err.code === "NOT_FOUND" ? 404 : err.code === "FORBIDDEN" ? 403 : err.code === "INVALID_NAME" ? 400 : 409;
    return res.status(status).json({ error: err.message, code: err.code });
  }
  throw err;
}

const status = z.enum(["NEEDED", "LOW", "OUT"]);
const keepers = requireRole("ADMIN", "CLIENT");

shoppingRouter.get("/", keepers, async (req: AuthenticatedRequest, res) => {
  res.setHeader("Cache-Control", "no-store");
  return res.json(await listShopping(req.auth!.householdId));
});

shoppingRouter.post("/", keepers, async (req: AuthenticatedRequest, res) => {
  const parsed = z.object({ name: z.string(), quantity: z.string().optional(), storageLocation: z.string().optional(), status: status.optional(), note: z.string().optional() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Enter the name of the item.", code: "INVALID_NAME" });
  try {
    const { item, created } = await addItem(actor(req), parsed.data);
    return res.status(created ? 201 : 200).json({ id: item.id, merged: !created });
  } catch (err) {
    return handleError(res, err);
  }
});

shoppingRouter.patch("/:id", keepers, async (req: AuthenticatedRequest, res) => {
  const parsed = z
    .object({ quantity: z.string().nullable().optional(), storageLocation: z.string().nullable().optional(), status: status.optional(), note: z.string().nullable().optional() })
    .safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid request" });
  try {
    await updateItem(actor(req), req.params.id!, parsed.data);
    return res.json({ ok: true });
  } catch (err) {
    return handleError(res, err);
  }
});

shoppingRouter.post("/:id/purchased", keepers, async (req: AuthenticatedRequest, res) => {
  try {
    await closeItem(actor(req), req.params.id!, "PURCHASED");
    return res.json({ ok: true });
  } catch (err) {
    return handleError(res, err);
  }
});

shoppingRouter.post("/:id/dismiss", keepers, async (req: AuthenticatedRequest, res) => {
  try {
    await closeItem(actor(req), req.params.id!, "DISMISSED");
    return res.json({ ok: true });
  } catch (err) {
    return handleError(res, err);
  }
});

// The IP reports a low or finished supply; it goes on the list and the client and administrator are told.
shoppingRouter.post("/low", requireRole("IP"), async (req: AuthenticatedRequest, res) => {
  const parsed = z.object({ item: z.string(), level: z.enum(["LOW", "OUT"]), location: z.string().optional(), note: z.string().optional() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Say what is running low.", code: "INVALID_NAME" });
  try {
    const { item, created } = await reportLowSupply(actor(req), parsed.data);
    return res.status(201).json({ ok: true, added: created, status: item.status });
  } catch (err) {
    return handleError(res, err);
  }
});
