import { DateTime } from "luxon";
import { db } from "../db";
import { appendEvent } from "./event.service";
import { removeRef } from "./evidence-store";
import { localDateString } from "./time.service";

/**
 * Photos have a shorter life than the records. They exist so the client and
 * family can see that the work is being done, not as payroll records, so a
 * photo is removed one year after it was accepted. This is a fixed rule of the
 * product (no setting, no role can change it) and an approval never removes a
 * photo early.
 *
 * What stays forever (for the full ten-year record): the audit event that the
 * photo was taken, its content hash, when it was accepted, and its location
 * result. Only the picture goes, and an audit event says so.
 *
 * A photo is NOT removed, and is kept like the other records, when:
 *  - its task was ever disputed, had corrective work, or had a mistake reported or corrected, or
 *  - its visit falls inside an active preservation (an audit or dispute; see preservation.service.ts).
 */
export const PHOTO_RETENTION_YEARS = 1;

export const photoRemovalDate = (acceptedAt: Date): Date =>
  DateTime.fromJSDate(acceptedAt, { zone: "utc" }).plus({ years: PHOTO_RETENTION_YEARS }).toJSDate();

const DISPUTE_ACTIONS = ["task_disputed", "task_corrective_submitted", "correction_requested", "correction_appended"];

export interface PhotoPurgeResult {
  removed: number;
  keptForDispute: number;
  keptByPreservation: number;
}

/** True if the household's active preservations cover this local date. */
const covered = (ranges: { fromDate: string; toDate: string }[], localDate: string) => ranges.some((r) => r.fromDate <= localDate && localDate <= r.toDate);

/** Removes a stored file only if no other picture record still points at the same bytes. */
async function removeIfUnused(ref: string, except: { evidenceId?: string; foodId?: string }): Promise<void> {
  const [evidence, food] = await Promise.all([
    db.evidence.count({ where: { purgedAt: null, OR: [{ storageRef: ref }, { viewerStorageRef: ref }], ...(except.evidenceId ? { id: { not: except.evidenceId } } : {}) } }),
    db.foodDisposalRequest.count({ where: { photoPurgedAt: null, OR: [{ photoStorageRef: ref }, { photoViewerRef: ref }], ...(except.foodId ? { id: { not: except.foodId } } : {}) } }),
  ]);
  if (evidence + food === 0) await removeRef(ref);
}

/**
 * Run once a day for every household. Removes photos older than a year, except the ones above.
 * Safe to run twice: a photo already removed is never touched again. (`only` limits it to one household; the
 * tests use it so they never touch anyone else's photos.)
 */
export async function removeExpiredPhotos(now: Date = new Date(), only?: { householdId: string }): Promise<PhotoPurgeResult> {
  const cutoff = DateTime.fromJSDate(now, { zone: "utc" }).minus({ years: PHOTO_RETENTION_YEARS }).toJSDate();
  const result: PhotoPurgeResult = { removed: 0, keptForDispute: 0, keptByPreservation: 0 };
  const tzOf = new Map<string, string>();
  const rangesOf = new Map<string, { fromDate: string; toDate: string }[]>();
  const household = async (id: string) => {
    if (!tzOf.has(id)) {
      tzOf.set(id, (await db.household.findUniqueOrThrow({ where: { id }, select: { timezone: true } })).timezone);
      rangesOf.set(id, await db.preservation.findMany({ where: { householdId: id, releasedAt: null }, select: { fromDate: true, toDate: true } }));
    }
    return { tz: tzOf.get(id)!, ranges: rangesOf.get(id)! };
  };

  // Photos taken for tasks.
  const old = await db.evidence.findMany({
    where: { purgedAt: null, uploadAcceptedAtServer: { lt: cutoff }, ...(only ? { taskInstance: { householdId: only.householdId } } : {}) },
    include: { taskInstance: { select: { id: true, householdId: true, state: true, shift: { select: { localDate: true } } } } },
    take: 500,
  });
  if (old.length > 0) {
    const taskIds = [...new Set(old.map((e) => e.taskInstanceId))];
    const flagged = new Set(
      (await db.event.findMany({ where: { taskInstanceId: { in: taskIds }, action: { in: DISPUTE_ACTIONS } }, select: { taskInstanceId: true } })).map((e) => e.taskInstanceId)
    );
    for (const e of old) {
      const task = e.taskInstance;
      if (flagged.has(task.id) || task.state === "DISPUTED" || task.state === "CORRECTIVE_WORK_SUBMITTED") {
        result.keptForDispute++;
        continue;
      }
      const { ranges } = await household(task.householdId);
      if (covered(ranges, task.shift.localDate)) {
        result.keptByPreservation++;
        continue;
      }
      const claimed = await db.evidence.updateMany({ where: { id: e.id, purgedAt: null }, data: { purgedAt: now } });
      if (claimed.count !== 1) continue; // someone else got there first
      await removeIfUnused(e.storageRef, { evidenceId: e.id });
      await removeIfUnused(e.viewerStorageRef, { evidenceId: e.id });
      await db.$transaction((tx) =>
        appendEvent(tx, {
          householdId: task.householdId,
          actorUserId: null,
          actorRole: "ADMIN",
          action: "evidence_removed",
          taskInstanceId: task.id,
          payload: { evidenceId: e.id, contentHash: e.contentHash, acceptedAtServer: e.uploadAcceptedAtServer.toISOString(), reason: "end_of_photo_period" },
        })
      );
      result.removed++;
    }
  }

  // Photos taken for food requests.
  const food = await db.foodDisposalRequest.findMany({
    where: { ...(only ? { householdId: only.householdId } : {}), photoPurgedAt: null, photoViewerRef: { not: null }, OR: [{ photoAcceptedAt: { lt: cutoff } }, { photoAcceptedAt: null, createdAt: { lt: cutoff } }] },
    take: 500,
  });
  for (const r of food) {
    const { tz, ranges } = await household(r.householdId);
    if (covered(ranges, localDateString(r.createdAt, tz))) {
      result.keptByPreservation++;
      continue;
    }
    const claimed = await db.foodDisposalRequest.updateMany({ where: { id: r.id, photoPurgedAt: null }, data: { photoPurgedAt: now } });
    if (claimed.count !== 1) continue;
    for (const ref of [r.photoStorageRef, r.photoViewerRef]) if (ref) await removeIfUnused(ref, { foodId: r.id });
    await db.$transaction((tx) =>
      appendEvent(tx, {
        householdId: r.householdId,
        actorUserId: null,
        actorRole: "ADMIN",
        action: "food_photo_removed",
        payload: { requestId: r.id, contentHash: r.photoHash, reason: "end_of_photo_period" },
      })
    );
    result.removed++;
  }
  return result;
}

export const isPhotoRemoved = async (householdId: string, evidenceId: string): Promise<boolean> =>
  (await db.evidence.count({ where: { id: evidenceId, purgedAt: { not: null }, taskInstance: { householdId } } })) > 0;

export const isFoodPhotoRemoved = async (householdId: string, requestId: string): Promise<boolean> =>
  (await db.foodDisposalRequest.count({ where: { id: requestId, householdId, photoPurgedAt: { not: null } } })) > 0;
