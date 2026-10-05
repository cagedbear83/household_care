import { afterAll, beforeAll, describe, expect, it } from "vitest";
import sharp from "sharp";
import { db } from "../src/db";
import { hashPassword } from "../src/auth/password";
import { checkIn } from "../src/services/authorization.service";
import { acceptEvidence, issueChallenge } from "../src/services/evidence.service";
import { completeTask } from "../src/services/task.service";
import { approveTask, disputeTask, getReviewTask } from "../src/services/review.service";
import { readRef, removeHouseholdFiles, writeOnce } from "../src/services/evidence-store";
import { listPreservations, placePreservation, PreservationError, releasePreservation } from "../src/services/preservation.service";
import * as photoRetention from "../src/services/photo-retention";
import { isFoodPhotoRemoved, isPhotoRemoved, PHOTO_RETENTION_YEARS, photoRemovalDate, removeExpiredPhotos } from "../src/services/photo-retention";
import { verifyChainIntegrity } from "../src/services/event.service";
import { localDateString } from "../src/services/time.service";

const DAY = 86_400_000;
let householdId: string;
let ids: { client: string; admin: string; ip: string; family: string; shift: string; today: string };
const t: Record<string, string> = {};
const here = { lat: 0, lng: 0, accuracyMeters: 5 };
const inDays = (n: number) => new Date(Date.now() + n * DAY);
const client = () => ({ userId: ids.client, householdId });
const staff = (role: "CLIENT" | "ADMIN" | "IP" | "FAMILY" = "CLIENT", userId = ids.client) => ({ userId, role, householdId });

const jpeg = (shade: number) => sharp({ create: { width: 320, height: 240, channels: 3, background: { r: shade, g: 90, b: 90 } } }).jpeg().toBuffer();

async function takePhoto(task: string, shade: number) {
  const { challengeId } = await issueChallenge(ids.ip, householdId, t[task]!);
  await acceptEvidence({ userId: ids.ip, householdId, taskInstanceId: t[task]!, challengeId, imageBase64: (await jpeg(shade)).toString("base64"), ...here });
  return db.evidence.findFirstOrThrow({ where: { taskInstanceId: t[task]! }, orderBy: { uploadAcceptedAtServer: "desc" } });
}
const mine = () => ({ householdId });
const fileExists = (ref: string) => readRef(ref).then(() => true, () => false);

beforeAll(async () => {
  const passwordHash = await hashPassword("test-only-password");
  const h = await db.household.create({ data: { name: "photos-test", apartmentLat: 0, apartmentLng: 0 } });
  householdId = h.id;
  const mk = (role: "CLIENT" | "ADMIN" | "IP" | "FAMILY", name: string) =>
    db.user.create({ data: { householdId, role, name, email: `${name.toLowerCase()}-${h.id}@test.local`, passwordHash } });
  const [c, a, ip, f] = await Promise.all([mk("CLIENT", "Chris"), mk("ADMIN", "Morgan"), mk("IP", "Pat"), mk("FAMILY", "Sam")]);
  for (const [i, title] of ["Sink", "Stove", "Mop", "Window"].entries()) {
    await db.taskTemplate.create({ data: { householdId, groupName: "Kitchen", title, instructions: "x", frequency: "VISIT", requiresPhoto: true, sortOrder: i } });
  }
  const now = new Date();
  const today = localDateString(now, h.timezone);
  const shift = await db.scheduledShift.create({
    data: { householdId, ipUserId: ip.id, localDate: today, scheduledStartUtc: new Date(now.getTime() - 5 * 60_000), scheduledEndUtc: new Date(now.getTime() + 6 * 3_600_000), status: "SCHEDULED", createdBy: ip.id },
  });
  await checkIn({ shiftId: shift.id, ipUserId: ip.id, ...here });
  for (const task of await db.taskInstance.findMany({ where: { shiftId: shift.id } })) t[task.titleSnapshot] = task.id;
  ids = { client: c.id, admin: a.id, ip: ip.id, family: f.id, shift: shift.id, today };
});

afterAll(async () => {
  await db.alertRead.deleteMany({ where: { alert: { householdId } } });
  await db.alert.deleteMany({ where: { householdId } });
  await db.preservation.deleteMany({ where: { householdId } });
  await db.foodDisposalRequest.deleteMany({ where: { householdId } });
  await db.evidence.deleteMany({ where: { taskInstance: { householdId } } });
  await db.captureChallenge.deleteMany({ where: { householdId } });
  await db.event.deleteMany({ where: { householdId } });
  await db.locationReading.deleteMany({ where: { householdId } });
  await db.taskInstance.deleteMany({ where: { householdId } });
  await db.scheduledShift.deleteMany({ where: { householdId } });
  await db.weekAllowance.deleteMany({ where: { householdId } });
  await db.taskTemplate.deleteMany({ where: { householdId } });
  await db.user.deleteMany({ where: { householdId } });
  await db.household.delete({ where: { id: householdId } });
  await removeHouseholdFiles(householdId);
  await db.$disconnect();
});

describe("the photo rule is fixed", () => {
  it("is one year and nothing offers a way to change it", () => {
    expect(PHOTO_RETENTION_YEARS).toBe(1);
    expect(photoRemovalDate(new Date("2026-10-04T12:00:00.000Z")).toISOString()).toBe("2027-10-04T12:00:00.000Z");
    expect(Object.keys(photoRetention).sort()).toEqual(["PHOTO_RETENTION_YEARS", "isFoodPhotoRemoved", "isPhotoRemoved", "photoRemovalDate", "removeExpiredPhotos"]);
  });
});

describe("removing photos after a year", () => {
  let sinkRefs: { storageRef: string; viewerStorageRef: string };
  let mopRefs: { storageRef: string; viewerStorageRef: string };
  const evidenceOf = (task: string) => db.evidence.findFirstOrThrow({ where: { taskInstanceId: t[task]! } });

  it("takes photos and has them reviewed", async () => {
    const sink = await takePhoto("Sink", 120);
    await takePhoto("Stove", 120); // an identical picture: the same stored bytes
    const mop = await takePhoto("Mop", 200);
    await takePhoto("Window", 60);
    sinkRefs = { storageRef: sink.storageRef, viewerStorageRef: sink.viewerStorageRef };
    mopRefs = { storageRef: mop.storageRef, viewerStorageRef: mop.viewerStorageRef };
    for (const task of ["Sink", "Stove", "Mop", "Window"]) await completeTask(t[task]!, ids.ip);
    await approveTask(client(), t.Sink!);
    await approveTask(client(), t.Stove!);
    await disputeTask(client(), t.Mop!, "Streaks left on the floor");
    expect(sink.contentHash).toBe((await evidenceOf("Stove")).contentHash);
  }, 30_000);

  it("does not remove a photo before its year is up, and an approval does not remove it", async () => {
    expect(await removeExpiredPhotos(inDays(364), mine())).toEqual({ removed: 0, keptForDispute: 0, keptByPreservation: 0 });
    expect(await removeExpiredPhotos(new Date(), mine())).toEqual({ removed: 0, keptForDispute: 0, keptByPreservation: 0 });
    expect(await fileExists(sinkRefs.viewerStorageRef)).toBe(true);
  });

  it("keeps the stored bytes while another photo record still points at them", async () => {
    // Make the Sink photo ten days older than the rest; the Stove photo has the same bytes.
    await db.evidence.updateMany({ where: { taskInstanceId: t.Sink! }, data: { uploadAcceptedAtServer: inDays(-10) } });
    const result = await removeExpiredPhotos(inDays(356), mine());
    expect(result).toMatchObject({ removed: 1 });
    expect((await evidenceOf("Sink")).purgedAt).not.toBeNull();
    expect((await evidenceOf("Stove")).purgedAt).toBeNull();
    expect(await fileExists(sinkRefs.viewerStorageRef)).toBe(true); // still needed by the Stove photo
  });

  it("keeps everything from a preserved date range, and a disputed task's photo regardless", async () => {
    const placed = await placePreservation(staff(), { fromDate: ids.today, toDate: ids.today, reason: "Audit of October" });
    const result = await removeExpiredPhotos(inDays(366), mine());
    expect(result).toEqual({ removed: 0, keptForDispute: 1, keptByPreservation: 2 }); // Mop (disputed); Stove and Window (preserved)
    expect(await isPhotoRemoved(householdId, (await evidenceOf("Stove")).id)).toBe(false);

    await releasePreservation(staff(), placed.id, "Audit finished");
    expect((await listPreservations(householdId))[0]).toMatchObject({ active: false, releaseReason: "Audit finished" });
  });

  it("removes the rest once nothing protects them, leaves the record, and says so in the audit log", async () => {
    const result = await removeExpiredPhotos(inDays(366), mine());
    expect(result).toEqual({ removed: 2, keptForDispute: 1, keptByPreservation: 0 });

    // The pictures are gone, but the hash, time and audit event remain.
    expect(await fileExists(sinkRefs.viewerStorageRef)).toBe(false);
    expect(await fileExists(sinkRefs.storageRef)).toBe(false);
    expect(await fileExists(mopRefs.viewerStorageRef)).toBe(true); // the disputed one is kept
    const stove = await evidenceOf("Stove");
    expect(stove.purgedAt).not.toBeNull();
    expect(stove.contentHash).toHaveLength(64);
    expect(await isPhotoRemoved(householdId, stove.id)).toBe(true);

    const events = await db.event.findMany({ where: { householdId, action: "evidence_removed" } });
    expect(events).toHaveLength(3); // Sink, Stove and Window
    expect(events.every((e) => e.actorUserId === null)).toBe(true);
    expect(events.find((e) => (e.payload as { evidenceId: string }).evidenceId === stove.id)!.payload).toMatchObject({ contentHash: stove.contentHash, reason: "end_of_photo_period" });
    // The original photo-accepted event is untouched.
    expect(await db.event.findUniqueOrThrow({ where: { id: stove.eventId } })).toMatchObject({ action: "evidence_accepted" });
  });

  it("shows removed photos as removed to the client, and the disputed one as still there", async () => {
    const stove = await getReviewTask(householdId, t.Stove!, { role: "CLIENT", canViewTimestamps: true });
    expect(stove.evidence[0]).toMatchObject({ removed: true });
    const mop = await getReviewTask(householdId, t.Mop!, { role: "CLIENT", canViewTimestamps: true });
    expect(mop.evidence[0]).toMatchObject({ removed: false });
  });

  it("does nothing a second time", async () => {
    expect(await removeExpiredPhotos(inDays(366), mine())).toEqual({ removed: 0, keptForDispute: 1, keptByPreservation: 0 });
  });
});

describe("photos of food requests follow the same rule", () => {
  it("are removed after a year unless the date is preserved", async () => {
    const viewerRef = `local:${householdId}/food-test.viewer.jpg`;
    const origRef = `local:${householdId}/food-test.orig`;
    await writeOnce(viewerRef, await jpeg(30));
    await writeOnce(origRef, await jpeg(30));
    const created = new Date(Date.now() - 400 * DAY);
    const request = await db.foodDisposalRequest.create({
      data: {
        householdId, shiftId: ids.shift, kind: "DISPOSAL", requestedByUserId: ids.ip, item: "Milk", location: "Refrigerator", reasonCode: "past_date", status: "PENDING",
        photoHash: "f".repeat(64), photoStorageRef: origRef, photoViewerRef: viewerRef, photoMime: "image/jpeg", photoBytes: 100, photoAcceptedAt: created, createdAt: created,
      },
    });
    const createdDay = localDateString(created, "America/Chicago");

    const kept = await placePreservation(staff("ADMIN", ids.admin), { fromDate: createdDay, toDate: createdDay, reason: "Dispute about the milk" });
    expect((await removeExpiredPhotos(new Date(), mine())).keptByPreservation).toBeGreaterThanOrEqual(1);
    expect(await isFoodPhotoRemoved(householdId, request.id)).toBe(false);
    await releasePreservation(staff("ADMIN", ids.admin), kept.id, "Resolved");

    await removeExpiredPhotos(new Date(), mine());
    expect(await isFoodPhotoRemoved(householdId, request.id)).toBe(true);
    expect(await fileExists(viewerRef)).toBe(false);
    expect(await db.event.count({ where: { householdId, action: "food_photo_removed" } })).toBe(1);
    expect((await verifyChainIntegrity(householdId)).ok).toBe(true);
  });
});

describe("preservation", () => {
  it("can be placed by the client's side only, with sensible dates and a reason", async () => {
    await expect(placePreservation(staff("IP", ids.ip), { fromDate: "2026-10-01", toDate: "2026-10-02", reason: "Audit" })).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
    await expect(placePreservation(staff("FAMILY", ids.family), { fromDate: "2026-10-01", toDate: "2026-10-02", reason: "Audit" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(placePreservation(staff(), { fromDate: "2026-13-01", toDate: "2026-10-02", reason: "Audit" })).rejects.toMatchObject({ code: "INVALID_DATE" });
    await expect(placePreservation(staff(), { fromDate: "2026-10-05", toDate: "2026-10-02", reason: "Audit" })).rejects.toMatchObject({ code: "INVALID_DATE" });
    await expect(placePreservation(staff(), { fromDate: "2026-10-01", toDate: "2026-10-02", reason: " " })).rejects.toMatchObject({ code: "REASON_REQUIRED" });
  });

  it("needs a reason to release, can be released once, and is written to the audit log", async () => {
    const placed = await placePreservation(staff(), { fromDate: "2026-10-01", toDate: "2026-10-31", reason: "Counselor review" });
    await expect(releasePreservation(staff(), placed.id, "  ")).rejects.toMatchObject({ code: "REASON_REQUIRED" });
    await expect(releasePreservation(staff(), "missing", "Done")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await releasePreservation(staff("ADMIN", ids.admin), placed.id, "Review complete");
    await expect(releasePreservation(staff(), placed.id, "Again")).rejects.toBeInstanceOf(PreservationError);
    const events = await db.event.findMany({ where: { householdId, action: { in: ["preservation_placed", "preservation_released"] } } });
    expect(events.length).toBeGreaterThanOrEqual(4);
  });
});
