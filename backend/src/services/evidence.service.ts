import { db } from "../db";
import { AWAY_MESSAGE, clientIsAway } from "./away.service";
import { appendEvent } from "./event.service";
import { raiseAlert } from "./alert.service";
import { evaluateGeofence, type VerificationResult } from "./geofence.service";
import { evidenceRefs, readRef, writeOnce } from "./evidence-store";
import { EvidenceRejectedError, prepareImage } from "./image.service";

export { EvidenceRejectedError };

const CHALLENGE_MINUTES = 10;

// A disputed task is open for corrective work, which for a photo task needs a new photo.
const ACTIONABLE = new Set(["NOT_STARTED", "IN_PROGRESS", "DISPUTED", "COMPLETION_ERROR_CORRECTED"]);

/** When each task was most recently disputed or had its completion corrected as an error, by task id. After either, an earlier photo no longer counts. */
export async function disputeTimes(taskIds: string[]): Promise<Map<string, Date>> {
  const result = new Map<string, Date>();
  if (taskIds.length === 0) return result;
  const events = await db.event.findMany({
    where: {
      taskInstanceId: { in: taskIds },
      OR: [{ action: "task_disputed" }, { action: "correction_appended", payload: { path: ["kind"], equals: "COMPLETION_ERROR" } }],
    },
    select: { taskInstanceId: true, serverTimestampUtc: true },
    orderBy: { serverTimestampUtc: "asc" },
  });
  for (const e of events) if (e.taskInstanceId) result.set(e.taskInstanceId, e.serverTimestampUtc);
  return result;
}

/** True when an accepted photo exists that arrived after the latest dispute (or any photo if never disputed). */
export async function hasFreshEvidence(taskInstanceId: string): Promise<boolean> {
  const since = (await disputeTimes([taskInstanceId])).get(taskInstanceId);
  const count = await db.evidence.count({
    where: { taskInstanceId, ...(since ? { uploadAcceptedAtServer: { gt: since } } : {}) },
  });
  return count > 0;
}

/** Loads the task and checks it is the signed-in IP's, needs a photo, is still
 * open, and belongs to a shift that is checked in and inside its authorized window. */
async function loadPhotoTask(userId: string, householdId: string, taskInstanceId: string) {
  const task = await db.taskInstance.findFirst({
    where: { id: taskInstanceId, householdId },
    include: { shift: true },
  });
  if (!task || task.shift.ipUserId !== userId) {
    throw new EvidenceRejectedError("NOT_FOUND", "Task not found.");
  }
  if (await clientIsAway(householdId)) {
    throw new EvidenceRejectedError("CLIENT_AWAY", AWAY_MESSAGE);
  }
  if (!task.requiresPhotoSnapshot) {
    throw new EvidenceRejectedError("PHOTO_NOT_REQUIRED", "This task does not take a photo.");
  }
  if (!ACTIONABLE.has(task.state)) {
    throw new EvidenceRejectedError("TASK_CLOSED", "This task is no longer open for changes.");
  }
  const s = task.shift;
  const open =
    s.checkInEventId && !s.checkOutEventId && !s.authorizationClosedAt && (!s.authorizedEndUtc || s.authorizedEndUtc > new Date());
  if (!open) {
    throw new EvidenceRejectedError("SHIFT_NOT_OPEN", "This shift is not currently checked in and within its authorized window.");
  }
  return task;
}

/** Issued when the in-app camera opens. Bound to this user, shift and task, and usable once. */
export async function issueChallenge(userId: string, householdId: string, taskInstanceId: string) {
  const task = await loadPhotoTask(userId, householdId, taskInstanceId);
  const challenge = await db.captureChallenge.create({
    data: {
      householdId,
      taskInstanceId,
      shiftId: task.shiftId,
      userId,
      expiresAt: new Date(Date.now() + CHALLENGE_MINUTES * 60_000),
    },
  });
  return { challengeId: challenge.id, expiresAt: challenge.expiresAt };
}

export interface AcceptEvidenceInput {
  userId: string;
  householdId: string;
  taskInstanceId: string;
  challengeId: string;
  imageBase64: string;
  /** Claimed by the phone; stored as a claim, never presented as independently proven. */
  capturedAtDevice?: string | null;
  lat?: number | null;
  lng?: number | null;
  accuracyMeters?: number | null;
}

export async function acceptEvidence(input: AcceptEvidenceInput) {
  const task = await loadPhotoTask(input.userId, input.householdId, input.taskInstanceId);

  // Cheap pre-check so a bad ticket cannot make us write files. The real,
  // race-safe consumption happens inside the transaction below.
  const ticket = await db.captureChallenge.findFirst({
    where: { id: input.challengeId, userId: input.userId, taskInstanceId: input.taskInstanceId, usedAt: null, expiresAt: { gt: new Date() } },
  });
  if (!ticket) {
    throw new EvidenceRejectedError("CHALLENGE_INVALID", "This photo request expired or was already used. Open the camera again.");
  }

  const image = await prepareImage(input.imageBase64);
  const { bytes, viewer, contentHash } = image;
  const isPng = image.mimeType === "image/png";

  const refs = evidenceRefs(input.householdId, contentHash);
  await writeOnce(refs.original, bytes);
  await writeOnce(refs.viewer, viewer);

  const household = await db.household.findUniqueOrThrow({ where: { id: input.householdId } });
  const hasFix = input.lat !== null && input.lat !== undefined && input.lng !== null && input.lng !== undefined;
  const geofence = hasFix
    ? evaluateGeofence({
        lat: input.lat!,
        lng: input.lng!,
        accuracyMeters: input.accuracyMeters,
        apartmentLat: household.apartmentLat,
        apartmentLng: household.apartmentLng,
        radiusMeters: household.geofenceRadiusMeters,
      })
    : { verification: "UNVERIFIED" as VerificationResult, distanceMeters: null };

  return db.$transaction(async (tx) => {
    const used = await tx.captureChallenge.updateMany({
      where: { id: input.challengeId, usedAt: null, expiresAt: { gt: new Date() } },
      data: { usedAt: new Date() },
    });
    if (used.count !== 1) {
      throw new EvidenceRejectedError("CHALLENGE_INVALID", "This photo request expired or was already used. Open the camera again.");
    }

    // Re-check under the transaction: the window may have closed while uploading.
    const shift = await tx.scheduledShift.findUniqueOrThrow({ where: { id: task.shiftId } });
    if (!shift.checkInEventId || shift.checkOutEventId || shift.authorizationClosedAt || (shift.authorizedEndUtc && shift.authorizedEndUtc <= new Date())) {
      throw new EvidenceRejectedError("SHIFT_NOT_OPEN", "The authorized window closed before the photo arrived.");
    }

    await tx.locationReading.create({
      data: {
        householdId: input.householdId,
        shiftId: task.shiftId,
        userId: input.userId,
        source: "PHOTO_CAPTURE",
        observedAtDevice: new Date(),
        lat: input.lat ?? 0,
        lng: input.lng ?? 0,
        accuracyMeters: input.accuracyMeters ?? null,
        distanceMeters: geofence.distanceMeters,
        verification: geofence.verification,
      },
    });

    if (geofence.verification !== "VERIFIED") {
      await raiseAlert(tx, {
        householdId: input.householdId,
        actorUserId: input.userId,
        actorRole: "IP",
        type: "location_verification_failed",
        shiftId: task.shiftId,
        message: `Photo for "${task.titleSnapshot}" was submitted with an unverified location (${geofence.verification}).`,
      });
    }

    const event = await appendEvent(tx, {
      householdId: input.householdId,
      actorUserId: input.userId,
      actorRole: "IP",
      action: "evidence_accepted",
      shiftId: task.shiftId,
      taskInstanceId: task.id,
      payload: {
        contentHash,
        byteSize: bytes.length,
        mimeType: isPng ? "image/png" : "image/jpeg",
        captureChallengeId: input.challengeId,
        capturedAtDeviceClaimed: input.capturedAtDevice ?? null,
        locationVerification: geofence.verification,
      },
    });

    const evidence = await tx.evidence.create({
      data: {
        taskInstanceId: task.id,
        eventId: event.id,
        contentHash,
        storageRef: refs.original,
        viewerStorageRef: refs.viewer,
        mimeType: isPng ? "image/png" : "image/jpeg",
        byteSize: bytes.length,
        captureChallengeId: input.challengeId,
        capturedAtDevice: input.capturedAtDevice ? new Date(input.capturedAtDevice) : null,
        uploadAcceptedAtServer: event.serverTimestampUtc,
        createdByUserId: input.userId,
      },
    });
    return { evidenceId: evidence.id };
  });
}

/** The metadata-stripped copy, scoped to the household. Role checks happen in the route. */
export async function loadViewerImage(householdId: string, evidenceId: string): Promise<Buffer | null> {
  const evidence = await db.evidence.findFirst({
    where: { id: evidenceId, taskInstance: { householdId } },
    select: { viewerStorageRef: true },
  });
  return evidence ? readRef(evidence.viewerStorageRef) : null;
}

export async function listTaskEvidence(householdId: string, taskInstanceId: string) {
  return db.evidence.findMany({
    where: { taskInstanceId, taskInstance: { householdId } },
    orderBy: { uploadAcceptedAtServer: "asc" },
    select: { id: true, contentHash: true, byteSize: true, mimeType: true, uploadAcceptedAtServer: true },
  });
}
