import type { FoodDisposalRequest, FoodRequestStatus, Role } from "@prisma/client";
import { db } from "../db";
import { appendEvent } from "./event.service";
import { raiseAlert, resolveAlerts } from "./alert.service";
import { evaluateGeofence, type VerificationResult } from "./geofence.service";
import { evidenceRefs, readRef, writeOnce } from "./evidence-store";
import { prepareImage } from "./image.service";
import { notifyRoles } from "./household-notify.service";
import { findOpenShiftForIp } from "./ip-shift";
import { addOrMergeItem } from "./shopping.service";

export class FoodError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

export interface IpActor {
  userId: string;
  householdId: string;
}

export interface StaffActor extends IpActor {
  role: Role;
}

const CHALLENGE_MINUTES = 10;
/** How long a request waits for the client before administrators are alerted and the item is left in place. */
const responseMinutes = () => Number(process.env.FOOD_RESPONSE_MINUTES ?? 30);

export const REASON_LABELS: Record<string, string> = {
  past_date: "Past the date on the label",
  spoiled: "Spoiled",
  moldy: "Moldy",
  smells_bad: "Smells bad",
  other: "Other",
};

function text(value: string | undefined | null, max: number): string | null {
  const v = value?.trim().replace(/\s+/g, " ");
  return v ? v.slice(0, max) : null;
}

function required(value: string | undefined, max: number, what: string): string {
  const v = text(value, max);
  if (!v) throw new FoodError("INVALID", `Enter ${what}.`);
  return v;
}

const nameOf = async (userId: string) => (await db.user.findUnique({ where: { id: userId }, select: { name: true } }))?.name ?? "The IP";

// --- Photos ---------------------------------------------------------------------

/** A one-use ticket for taking a food photo (the same idea as task photos). */
export async function issueFoodChallenge(ip: IpActor) {
  const shift = await findOpenShiftForIp(ip.userId, ip.householdId);
  if (!shift) throw new FoodError("SHIFT_NOT_OPEN", "You can report food while you are checked in on an authorized shift.");
  const challenge = await db.captureChallenge.create({
    data: {
      householdId: ip.householdId,
      shiftId: shift.id,
      userId: ip.userId,
      purpose: "food_photo",
      taskInstanceId: null,
      expiresAt: new Date(Date.now() + CHALLENGE_MINUTES * 60_000),
    },
  });
  return { challengeId: challenge.id, expiresAt: challenge.expiresAt };
}

export interface FoodPhotoInput {
  challengeId: string;
  imageBase64: string;
  lat?: number | null;
  lng?: number | null;
  accuracyMeters?: number | null;
}

/** Everything that can be done before the transaction: validate the ticket and the image, store the files, check the location. */
async function preparePhoto(ip: IpActor, photo: FoodPhotoInput) {
  const ticket = await db.captureChallenge.findFirst({
    where: { id: photo.challengeId, userId: ip.userId, householdId: ip.householdId, purpose: "food_photo", usedAt: null, expiresAt: { gt: new Date() } },
  });
  if (!ticket) throw new FoodError("CHALLENGE_INVALID", "This photo request expired or was already used. Take the photo again.");

  const image = await prepareImage(photo.imageBase64);
  const refs = evidenceRefs(ip.householdId, image.contentHash);
  await writeOnce(refs.original, image.bytes);
  await writeOnce(refs.viewer, image.viewer);

  const household = await db.household.findUniqueOrThrow({ where: { id: ip.householdId } });
  const hasFix = photo.lat != null && photo.lng != null;
  const geofence = hasFix
    ? evaluateGeofence({
        lat: photo.lat!,
        lng: photo.lng!,
        accuracyMeters: photo.accuracyMeters,
        apartmentLat: household.apartmentLat,
        apartmentLng: household.apartmentLng,
        radiusMeters: household.geofenceRadiusMeters,
      })
    : { verification: "UNVERIFIED" as VerificationResult, distanceMeters: null };
  return { image, refs, geofence, photo };
}

type PreparedPhoto = Awaited<ReturnType<typeof preparePhoto>>;
type Tx = Parameters<Parameters<typeof db.$transaction>[0]>[0];

async function spendPhoto(tx: Tx, ip: IpActor, shiftId: string, p: PreparedPhoto, item: string) {
  const used = await tx.captureChallenge.updateMany({
    where: { id: p.photo.challengeId, purpose: "food_photo", usedAt: null, expiresAt: { gt: new Date() } },
    data: { usedAt: new Date() },
  });
  if (used.count !== 1) throw new FoodError("CHALLENGE_INVALID", "This photo request expired or was already used. Take the photo again.");

  await tx.locationReading.create({
    data: {
      householdId: ip.householdId,
      shiftId,
      userId: ip.userId,
      source: "PHOTO_CAPTURE",
      observedAtDevice: new Date(),
      lat: p.photo.lat ?? 0,
      lng: p.photo.lng ?? 0,
      accuracyMeters: p.photo.accuracyMeters ?? null,
      distanceMeters: p.geofence.distanceMeters,
      verification: p.geofence.verification,
    },
  });
  if (p.geofence.verification !== "VERIFIED") {
    await raiseAlert(tx, {
      householdId: ip.householdId,
      actorUserId: ip.userId,
      actorRole: "IP",
      type: "location_verification_failed",
      shiftId,
      message: `Food photo for "${item}" was submitted with an unverified location (${p.geofence.verification}).`,
    });
  }
  return {
    photoHash: p.image.contentHash,
    photoStorageRef: p.refs.original,
    photoViewerRef: p.refs.viewer,
    photoMime: p.image.mimeType,
    photoBytes: p.image.bytes.length,
    photoLocationVerification: p.geofence.verification,
    photoAcceptedAt: new Date(),
  };
}

async function stillOpen(tx: Tx, shiftId: string) {
  const s = await tx.scheduledShift.findUniqueOrThrow({ where: { id: shiftId } });
  if (!s.checkInEventId || s.checkOutEventId || s.authorizationClosedAt || (s.authorizedEndUtc && s.authorizedEndUtc <= new Date())) {
    throw new FoodError("SHIFT_NOT_OPEN", "Your authorized shift ended before this arrived.");
  }
}

// --- IP: ask first --------------------------------------------------------------

export interface DisposalInput extends FoodPhotoInput {
  item: string;
  location: string;
  reasonCode: string;
  reasonText?: string;
  dateLabel?: string;
  replacement?: string;
}

/**
 * The IP asks to throw something away. Nothing is thrown away yet: the request
 * goes to the client (and is visible to administrators), with the item, its
 * exact location, why, any date on the label, the replacement to buy, and a
 * photo taken in the app.
 */
export async function createDisposalRequest(ip: IpActor, input: DisposalInput) {
  const shift = await findOpenShiftForIp(ip.userId, ip.householdId);
  if (!shift) throw new FoodError("SHIFT_NOT_OPEN", "You can report food while you are checked in on an authorized shift.");

  const item = required(input.item, 120, "what the item is");
  const location = required(input.location, 160, "exactly where it is (for example, top shelf of the refrigerator, left side)");
  if (!(input.reasonCode in REASON_LABELS)) throw new FoodError("INVALID", "Choose why it should be thrown away.");
  const reasonText = input.reasonCode === "other" ? required(input.reasonText, 300, "the reason") : text(input.reasonText, 300);

  const prepared = await preparePhoto(ip, input);

  const request = await db.$transaction(async (tx) => {
    await stillOpen(tx, shift.id);
    const photoFields = await spendPhoto(tx, ip, shift.id, prepared, item);
    const created = await tx.foodDisposalRequest.create({
      data: {
        householdId: ip.householdId,
        shiftId: shift.id,
        kind: "DISPOSAL",
        requestedByUserId: ip.userId,
        item,
        location,
        reasonCode: input.reasonCode,
        reasonText,
        dateLabel: text(input.dateLabel, 60),
        replacement: text(input.replacement, 120),
        status: "PENDING",
        ...photoFields,
      },
    });
    await appendEvent(tx, {
      householdId: ip.householdId,
      actorUserId: ip.userId,
      actorRole: "IP",
      action: "food_disposal_requested",
      shiftId: shift.id,
      payload: { requestId: created.id, item, location, reasonCode: input.reasonCode, dateLabel: created.dateLabel, replacement: created.replacement, contentHash: photoFields.photoHash },
    });
    await raiseAlert(tx, {
      householdId: ip.householdId,
      actorUserId: ip.userId,
      actorRole: "IP",
      type: "food_request",
      shiftId: shift.id,
      refId: created.id,
      dedupeKey: `food_request:${created.id}`,
      message: `The IP asks to throw away "${item}" (${location}). Waiting for the client.`,
    });
    return created;
  });

  notifyRoles(ip.householdId, ["CLIENT", "ADMIN"], "Food approval needed", `${await nameOf(ip.userId)} asks to throw away "${item}" (${location}). Open the app to approve or decline.`);
  return request;
}

export interface HazardInput {
  item: string;
  location: string;
  reason: string;
  actionTaken: string;
  replacement?: string;
  /** A photo is welcome but not required for a hazard. */
  photo?: FoodPhotoInput;
}

/**
 * An obvious hazard (for example, a leaking container of raw meat on a shelf)
 * that could not wait for an answer. This is its own explicit, recorded
 * exception: the reason and what was done are required, the client and
 * administrators are told straight away, and the client acknowledges it. It is
 * never treated as an approval.
 */
export async function reportHazard(ip: IpActor, input: HazardInput) {
  const shift = await findOpenShiftForIp(ip.userId, ip.householdId);
  if (!shift) throw new FoodError("SHIFT_NOT_OPEN", "You can report food while you are checked in on an authorized shift.");

  const item = required(input.item, 120, "what the item is");
  const location = required(input.location, 160, "where it was");
  const reason = required(input.reason, 300, "why it was an immediate hazard");
  const actionTaken = required(input.actionTaken, 300, "what you did about it");
  const prepared = input.photo ? await preparePhoto(ip, input.photo) : null;

  const request = await db.$transaction(async (tx) => {
    await stillOpen(tx, shift.id);
    const photoFields = prepared ? await spendPhoto(tx, ip, shift.id, prepared, item) : {};
    const created = await tx.foodDisposalRequest.create({
      data: {
        householdId: ip.householdId,
        shiftId: shift.id,
        kind: "HAZARD",
        requestedByUserId: ip.userId,
        item,
        location,
        reasonCode: "hazard",
        reasonText: reason,
        actionTaken,
        replacement: text(input.replacement, 120),
        status: "HAZARD_REPORTED",
        ...photoFields,
      },
    });
    await appendEvent(tx, {
      householdId: ip.householdId,
      actorUserId: ip.userId,
      actorRole: "IP",
      action: "food_hazard_reported",
      shiftId: shift.id,
      payload: { requestId: created.id, item, location, reason, actionTaken, replacement: created.replacement },
    });
    if (created.replacement) {
      await addOrMergeItem(tx, { userId: ip.userId, role: "IP", householdId: ip.householdId }, {
        name: created.replacement,
        storageLocation: location,
        note: `Replacing discarded ${item}`,
        source: "DISPOSAL",
      });
    }
    await raiseAlert(tx, {
      householdId: ip.householdId,
      actorUserId: ip.userId,
      actorRole: "IP",
      type: "food_hazard",
      shiftId: shift.id,
      refId: created.id,
      dedupeKey: `food_hazard:${created.id}`,
      message: `Food hazard dealt with: "${item}" (${location}). Action: ${actionTaken}`,
    });
    return created;
  });

  notifyRoles(ip.householdId, ["CLIENT", "ADMIN"], "Food hazard reported", `${await nameOf(ip.userId)} reported and dealt with a food hazard: "${item}" (${location}). Open the app for details.`);
  return request;
}

/** After the client approves, the IP throws it away and records that it was actually done. */
export async function recordDisposal(ip: IpActor, requestId: string) {
  const shift = await findOpenShiftForIp(ip.userId, ip.householdId);
  if (!shift) throw new FoodError("SHIFT_NOT_OPEN", "You can record this while you are checked in on an authorized shift.");

  return db.$transaction(async (tx) => {
    const request = await tx.foodDisposalRequest.findFirst({ where: { id: requestId, householdId: ip.householdId, kind: "DISPOSAL" } });
    if (!request) throw new FoodError("NOT_FOUND", "Request not found.");

    const moved = await tx.foodDisposalRequest.updateMany({
      where: { id: requestId, status: "APPROVED" },
      data: { status: "DISPOSED", disposedByUserId: ip.userId, disposedAt: new Date() },
    });
    if (moved.count !== 1) throw new FoodError("NOT_APPROVED", "This can only be thrown away after the client approves it.");

    await appendEvent(tx, {
      householdId: ip.householdId,
      actorUserId: ip.userId,
      actorRole: "IP",
      action: "food_disposed",
      shiftId: shift.id,
      payload: { requestId, item: request.item, location: request.location },
    });
    // Only after it is really gone: the replacement goes on the shopping list (merging with an existing entry).
    if (request.replacement) {
      await addOrMergeItem(tx, { userId: ip.userId, role: "IP", householdId: ip.householdId }, {
        name: request.replacement,
        storageLocation: request.location,
        note: `Replacing discarded ${request.item}`,
        source: "DISPOSAL",
      });
    }
    return tx.foodDisposalRequest.findUniqueOrThrow({ where: { id: requestId } });
  });
}

// --- Client decisions -----------------------------------------------------------

async function decideRequest(
  actor: StaffActor,
  requestId: string,
  from: FoodRequestStatus,
  to: FoodRequestStatus,
  action: string,
  note?: string
) {
  if (actor.role !== "CLIENT") throw new FoodError("FORBIDDEN", "Only the client can decide this.");
  return db.$transaction(async (tx) => {
    const request = await tx.foodDisposalRequest.findFirst({ where: { id: requestId, householdId: actor.householdId } });
    if (!request) throw new FoodError("NOT_FOUND", "Request not found.");

    const cleanNote = text(note, 300);
    const moved = await tx.foodDisposalRequest.updateMany({
      where: { id: requestId, status: from },
      data:
        from === "HAZARD_REPORTED"
          ? { status: to, acknowledgedByUserId: actor.userId, acknowledgedAt: new Date() }
          : { status: to, decidedByUserId: actor.userId, decidedAt: new Date(), decisionNote: cleanNote },
    });
    if (moved.count !== 1) throw new FoodError("ALREADY_DECIDED", "This was already answered. Reload to see where it stands.");
    // Answered: the alerts asking for an answer are handled.
    if (from === "HAZARD_REPORTED") await resolveAlerts(tx, actor.householdId, "food_hazard", requestId);
    else {
      await resolveAlerts(tx, actor.householdId, "food_request", requestId);
      await resolveAlerts(tx, actor.householdId, "food_request_no_response", requestId);
    }

    await appendEvent(tx, {
      householdId: actor.householdId,
      actorUserId: actor.userId,
      actorRole: "CLIENT",
      action,
      shiftId: request.shiftId,
      payload: { requestId, item: request.item, note: cleanNote },
    });
    return tx.foodDisposalRequest.findUniqueOrThrow({ where: { id: requestId } });
  });
}

export const approveRequest = (a: StaffActor, id: string) => decideRequest(a, id, "PENDING", "APPROVED", "food_disposal_approved");
export const declineRequest = (a: StaffActor, id: string, note?: string) => decideRequest(a, id, "PENDING", "DECLINED", "food_disposal_declined", note);
export const acknowledgeHazard = (a: StaffActor, id: string) => decideRequest(a, id, "HAZARD_REPORTED", "HAZARD_ACKNOWLEDGED", "food_hazard_acknowledged");

// --- Reading --------------------------------------------------------------------

/** What the client and administrators see, with the full record of who did what and when. */
async function staffDtos(rows: FoodDisposalRequest[]) {
  const ids = [...new Set(rows.flatMap((r) => [r.requestedByUserId, r.decidedByUserId, r.disposedByUserId, r.acknowledgedByUserId]).filter((id): id is string => Boolean(id)))];
  const users = ids.length ? await db.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }) : [];
  const name = new Map(users.map((u) => [u.id, u.name]));
  const who = (id: string | null) => (id ? (name.get(id) ?? null) : null);
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    status: r.status,
    item: r.item,
    location: r.location,
    reason: r.kind === "HAZARD" ? "Immediate hazard" : (REASON_LABELS[r.reasonCode] ?? r.reasonCode),
    reasonText: r.reasonText,
    dateLabel: r.dateLabel,
    replacement: r.replacement,
    actionTaken: r.actionTaken,
    requestedBy: who(r.requestedByUserId),
    requestedAt: r.createdAt,
    decidedBy: who(r.decidedByUserId),
    decidedAt: r.decidedAt,
    decisionNote: r.decisionNote,
    disposedBy: who(r.disposedByUserId),
    disposedAt: r.disposedAt,
    acknowledgedBy: who(r.acknowledgedByUserId),
    acknowledgedAt: r.acknowledgedAt,
    escalatedAt: r.escalatedAt,
    hasPhoto: r.photoViewerRef !== null,
    photoLocationVerification: r.photoLocationVerification,
    photoFingerprint: r.photoHash ? r.photoHash.slice(0, 12) : null,
  }));
}

export async function listForStaff(householdId: string) {
  const rows = await db.foodDisposalRequest.findMany({ where: { householdId }, orderBy: { createdAt: "desc" }, take: 200 });
  const dtos = await staffDtos(rows);
  return {
    pending: dtos.filter((d) => d.status === "PENDING").reverse(), // oldest first
    hazards: dtos.filter((d) => d.status === "HAZARD_REPORTED").reverse(),
    // Approved-but-not-yet-thrown-away has its own list; history is what is finished.
    history: dtos.filter((d) => d.status !== "PENDING" && d.status !== "HAZARD_REPORTED" && d.status !== "APPROVED"),
    approvedWaiting: dtos.filter((d) => d.status === "APPROVED"),
  };
}

/** The IP's own requests: what they asked and what the client answered; no audit timestamps. */
export async function listForIp(ip: IpActor) {
  const week = new Date(Date.now() - 7 * 86_400_000);
  const rows = await db.foodDisposalRequest.findMany({
    where: { householdId: ip.householdId, requestedByUserId: ip.userId, OR: [{ status: { in: ["PENDING", "APPROVED"] } }, { createdAt: { gt: week } }] },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    status: r.status,
    item: r.item,
    location: r.location,
    reason: r.kind === "HAZARD" ? "Immediate hazard" : (REASON_LABELS[r.reasonCode] ?? r.reasonCode),
    dateLabel: r.dateLabel,
    replacement: r.replacement,
    decisionNote: r.decisionNote,
    /** No answer yet and the item is being left in place. */
    leaveInPlace: r.status === "PENDING" && r.escalatedAt !== null,
  }));
}

export async function loadFoodPhoto(householdId: string, requestId: string): Promise<Buffer | null> {
  const r = await db.foodDisposalRequest.findFirst({ where: { id: requestId, householdId }, select: { photoViewerRef: true } });
  return r?.photoViewerRef ? readRef(r.photoViewerRef) : null;
}

// --- No answer: leave it in place and tell the administrator ----------------------

/**
 * Run on a timer. A request nobody has answered after FOOD_RESPONSE_MINUTES
 * (default 30) stays PENDING and the item stays where it is; the administrator
 * is alerted once, with the item and location (the photo is on the request).
 */
export async function escalateStaleFoodRequests(): Promise<number> {
  const cutoff = new Date(Date.now() - responseMinutes() * 60_000);
  const stale = await db.foodDisposalRequest.findMany({ where: { status: "PENDING", escalatedAt: null, createdAt: { lt: cutoff } } });

  let count = 0;
  for (const r of stale) {
    const done = await db.$transaction(async (tx) => {
      const marked = await tx.foodDisposalRequest.updateMany({ where: { id: r.id, status: "PENDING", escalatedAt: null }, data: { escalatedAt: new Date() } });
      if (marked.count !== 1) return false;
      await appendEvent(tx, {
        householdId: r.householdId,
        actorUserId: null,
        actorRole: "ADMIN",
        action: "food_request_escalated",
        shiftId: r.shiftId,
        payload: { requestId: r.id, item: r.item, location: r.location },
      });
      await raiseAlert(tx, {
        householdId: r.householdId,
        actorUserId: null,
        actorRole: "ADMIN",
        type: "food_request_no_response",
        shiftId: r.shiftId,
        refId: r.id,
        dedupeKey: `food_request_no_response:${r.id}`,
        message: `No answer yet about throwing away "${r.item}" (${r.location}). It is being left in place.`,
      });
      return true;
    });
    if (done) {
      count++;
      notifyRoles(r.householdId, ["ADMIN"], "No answer on a food request", `No answer yet about throwing away "${r.item}" (${r.location}). It is being left in place. Open the app to see the photo.`);
    }
  }
  return count;
}
