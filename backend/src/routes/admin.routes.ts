import { Router, type Response } from "express";
import { z } from "zod";
import { db } from "../db";
import { requireAuth, requireRole, type AuthenticatedRequest } from "../auth/middleware";
import {
  cancelShift,
  createRecurringRule,
  createShift,
  generateFromRules,
  listActiveShifts,
  replaceShift,
  ScheduleRejectedError,
  type Actor,
} from "../services/schedule.service";
import { createTemplate, TemplateRejectedError, updateTemplate } from "../services/task-template.service";

// Per the spec's permissions table, schedules and task templates are managed
// by the client and administrators; IPs and family viewers cannot.
export const adminRouter = Router();
adminRouter.use(requireAuth, requireRole("ADMIN", "CLIENT"));

function actorOf(req: AuthenticatedRequest): Actor {
  return { userId: req.auth!.userId, role: req.auth!.role, householdId: req.auth!.householdId };
}

function handleError(res: Response, err: unknown) {
  if (err instanceof ScheduleRejectedError || err instanceof TemplateRejectedError) {
    const status = err.code === "NOT_FOUND" || err.code === "IP_NOT_FOUND" ? 404 : 409;
    return res.status(status).json({ error: err.message, code: err.code, detail: "detail" in err ? err.detail : undefined });
  }
  throw err;
}

/** Everything the schedule screen needs to render a week correctly: the
 * household's timezone/cap/workweek start, and the IPs that can be scheduled. */
adminRouter.get("/schedule-context", async (req: AuthenticatedRequest, res) => {
  const household = await db.household.findUniqueOrThrow({ where: { id: req.auth!.householdId } });
  const ips = await db.user.findMany({
    where: { householdId: household.id, role: "IP", active: true },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });
  return res.json({
    household: {
      timezone: household.timezone,
      weeklyHourCapMinutes: household.weeklyHourCapMinutes,
      workweekStartWeekday: household.workweekStartWeekday,
    },
    ips,
  });
});

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const timeStr = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

const shiftSchema = z.object({
  ipUserId: z.string().uuid(),
  localDate: dateStr,
  startLocal: timeStr.optional(),
  endLocal: timeStr.optional(),
  status: z.enum(["SCHEDULED", "VACATION", "SICK", "CLIENT_UNAVAILABLE", "NOT_SCHEDULED"]).default("SCHEDULED"),
});

adminRouter.post("/shifts", async (req: AuthenticatedRequest, res) => {
  const parsed = shiftSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
  try {
    return res.status(201).json({ shift: await createShift(actorOf(req), parsed.data) });
  } catch (err) {
    return handleError(res, err);
  }
});

adminRouter.get("/shifts", async (req: AuthenticatedRequest, res) => {
  const parsed = z.object({ from: dateStr, to: dateStr }).safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: "Provide from and to as YYYY-MM-DD." });

  return res.json({ shifts: await listActiveShifts(req.auth!.householdId, parsed.data.from, parsed.data.to) });
});

const reasonSchema = z.string().trim().min(3, "Enter a reason");

// Replaces a not-yet-started shift with a new version (the old one is kept as history).
adminRouter.put("/shifts/:id", async (req: AuthenticatedRequest, res) => {
  const parsed = z
    .object({
      localDate: dateStr,
      startLocal: timeStr.optional(),
      endLocal: timeStr.optional(),
      status: z.enum(["SCHEDULED", "VACATION", "SICK", "CLIENT_UNAVAILABLE", "NOT_SCHEDULED"]),
      reason: reasonSchema,
    })
    .safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
  const { reason, ...details } = parsed.data;
  try {
    return res.json({ shift: await replaceShift(actorOf(req), req.params.id!, details, reason) });
  } catch (err) {
    return handleError(res, err);
  }
});

adminRouter.post("/shifts/:id/cancel", async (req: AuthenticatedRequest, res) => {
  const parsed = z.object({ reason: reasonSchema }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Enter a reason for cancelling." });
  try {
    return res.json({ shift: await cancelShift(actorOf(req), req.params.id!, parsed.data.reason) });
  } catch (err) {
    return handleError(res, err);
  }
});

const ruleSchema = z.object({
  ipUserId: z.string().uuid(),
  weekday: z.number().int().min(0).max(6),
  startLocal: timeStr,
  endLocal: timeStr,
  effectiveFrom: dateStr,
  effectiveUntil: dateStr.optional(),
});

adminRouter.post("/recurring-rules", async (req: AuthenticatedRequest, res) => {
  const parsed = ruleSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
  try {
    return res.status(201).json({ rule: await createRecurringRule(actorOf(req), parsed.data) });
  } catch (err) {
    return handleError(res, err);
  }
});

adminRouter.post("/schedule/generate", async (req: AuthenticatedRequest, res) => {
  const parsed = z.object({ from: dateStr, to: dateStr }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Provide from and to as YYYY-MM-DD." });
  try {
    return res.json({ results: await generateFromRules(actorOf(req), parsed.data.from, parsed.data.to) });
  } catch (err) {
    return handleError(res, err);
  }
});

const templateFields = z.object({
  groupName: z.string().min(1),
  title: z.string().min(1),
  instructions: z.string().min(1),
  frequency: z.enum(["VISIT", "WEEKLY", "MONTHLY", "AS_NEEDED"]),
  requiresPhoto: z.boolean().default(false),
  sortOrder: z.number().int().default(0),
});

adminRouter.get("/task-templates", async (req: AuthenticatedRequest, res) => {
  const templates = await db.taskTemplate.findMany({
    where: { householdId: req.auth!.householdId },
    orderBy: [{ sortOrder: "asc" }, { title: "asc" }],
  });
  return res.json({ templates });
});

adminRouter.post("/task-templates", async (req: AuthenticatedRequest, res) => {
  const parsed = templateFields.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
  try {
    return res.status(201).json({ template: await createTemplate(actorOf(req), parsed.data) });
  } catch (err) {
    return handleError(res, err);
  }
});

adminRouter.patch("/task-templates/:id", async (req: AuthenticatedRequest, res) => {
  const parsed = templateFields.partial().extend({ active: z.boolean().optional() }).safeParse(req.body);
  if (!parsed.success || Object.keys(parsed.data).length === 0) {
    return res.status(400).json({ error: "Invalid request" });
  }
  try {
    return res.json({ template: await updateTemplate(actorOf(req), req.params.id!, parsed.data) });
  } catch (err) {
    return handleError(res, err);
  }
});
