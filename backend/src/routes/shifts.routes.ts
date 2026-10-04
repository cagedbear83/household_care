import { Router } from "express";
import { z } from "zod";
import { db } from "../db";
import { requireAuth, requireRole, type AuthenticatedRequest } from "../auth/middleware";
import { checkIn, checkOut, CheckInRejectedError } from "../services/authorization.service";
import { evaluateGeofence } from "../services/geofence.service";
import { localDateString } from "../services/time.service";
import { toIpShiftDto, toIpTaskDtos } from "../services/ip-dto";

export const shiftsRouter = Router();
shiftsRouter.use(requireAuth);

/** Today's scheduled shift for the signed-in IP, with its task list. Previous
 * and future shifts remain readable (per spec) but only today's shift can be
 * acted on. */
shiftsRouter.get("/today", requireRole("IP"), async (req: AuthenticatedRequest, res) => {
  const household = await db.household.findUniqueOrThrow({ where: { id: req.auth!.householdId } });
  const todayLocal = localDateString(new Date(), household.timezone);

  const shift = await db.scheduledShift.findFirst({
    where: { ipUserId: req.auth!.userId, localDate: todayLocal, supersededAt: null },
    include: {
      taskInstances: {
        orderBy: { createdAt: "asc" },
        include: { evidence: { select: { id: true, uploadAcceptedAtServer: true } } },
      },
    },
  });

  if (!shift) {
    return res.json({ shift: null, message: "No scheduled shift today." });
  }
  return res.json({ shift: toIpShiftDto(shift, await toIpTaskDtos(shift.taskInstances)) });
});

const coordsSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  accuracyMeters: z.number().nonnegative().nullable().optional(),
});

async function loadOwnShiftOrThrow(req: AuthenticatedRequest, shiftId: string) {
  const shift = await db.scheduledShift.findUnique({ where: { id: shiftId } });
  if (!shift || shift.householdId !== req.auth!.householdId || shift.ipUserId !== req.auth!.userId) {
    return null;
  }
  return shift;
}

shiftsRouter.post("/:id/check-in", requireRole("IP"), async (req: AuthenticatedRequest, res) => {
  const parsed = coordsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });

  const owned = await loadOwnShiftOrThrow(req, req.params.id!);
  if (!owned) return res.status(404).json({ error: "Shift not found" });

  try {
    const shift = await checkIn({
      shiftId: req.params.id!,
      ipUserId: req.auth!.userId,
      lat: parsed.data.lat,
      lng: parsed.data.lng,
      accuracyMeters: parsed.data.accuracyMeters ?? null,
    });
    return res.json({ shift: toIpShiftDto(shift) });
  } catch (err) {
    if (err instanceof CheckInRejectedError) {
      return res.status(409).json({ error: err.message, code: err.code });
    }
    throw err;
  }
});

const checkoutSchema = z.object({
  lat: z.number().min(-90).max(90).nullable(),
  lng: z.number().min(-180).max(180).nullable(),
  accuracyMeters: z.number().nonnegative().nullable().optional(),
});

shiftsRouter.post("/:id/check-out", requireRole("IP"), async (req: AuthenticatedRequest, res) => {
  const parsed = checkoutSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });

  const owned = await loadOwnShiftOrThrow(req, req.params.id!);
  if (!owned) return res.status(404).json({ error: "Shift not found" });

  try {
    const shift = await checkOut({
      shiftId: req.params.id!,
      ipUserId: req.auth!.userId,
      lat: parsed.data.lat,
      lng: parsed.data.lng,
      accuracyMeters: parsed.data.accuracyMeters ?? null,
    });
    return res.json({ shift: toIpShiftDto(shift) });
  } catch (err) {
    if (err instanceof CheckInRejectedError) {
      return res.status(409).json({ error: err.message, code: err.code });
    }
    throw err;
  }
});

/** Periodic background location ping during an active shift (spec target:
 * every 30-60 minutes, default 45). Does not block the shift; it only
 * records a verification result for later review. */
shiftsRouter.post("/:id/location-ping", requireRole("IP"), async (req: AuthenticatedRequest, res) => {
  const parsed = coordsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });

  const shift = await loadOwnShiftOrThrow(req, req.params.id!);
  if (!shift) return res.status(404).json({ error: "Shift not found" });
  if (!shift.checkInEventId || shift.checkOutEventId) {
    return res.status(409).json({ error: "Shift is not currently active", code: "SHIFT_NOT_ACTIVE" });
  }

  const household = await db.household.findUniqueOrThrow({ where: { id: req.auth!.householdId } });
  const geofence = evaluateGeofence({
    lat: parsed.data.lat,
    lng: parsed.data.lng,
    accuracyMeters: parsed.data.accuracyMeters ?? null,
    apartmentLat: household.apartmentLat,
    apartmentLng: household.apartmentLng,
    radiusMeters: household.geofenceRadiusMeters,
  });

  await db.locationReading.create({
    data: {
      householdId: req.auth!.householdId,
      shiftId: shift.id,
      userId: req.auth!.userId,
      source: "PERIODIC",
      observedAtDevice: new Date(),
      lat: parsed.data.lat,
      lng: parsed.data.lng,
      accuracyMeters: parsed.data.accuracyMeters ?? null,
      distanceMeters: geofence.distanceMeters,
      verification: geofence.verification,
    },
  });

  // Acknowledge only; the reading and its verification result are for admins.
  return res.json({ ok: true });
});
