import { afterAll, beforeAll, describe, expect, it } from "vitest";
import sharp from "sharp";
import { db } from "../src/db";
import { hashPassword } from "../src/auth/password";
import { checkIn } from "../src/services/authorization.service";
import { verifyChainIntegrity } from "../src/services/event.service";
import { acceptEvidence, issueChallenge } from "../src/services/evidence.service";
import { readRef, removeHouseholdFiles, sha256 } from "../src/services/evidence-store";
import { ipTaskById } from "../src/services/ip-dto";
import { completeTask } from "../src/services/task.service";
import { localDateString } from "../src/services/time.service";

// Isolated throwaway household with an active, checked-in shift (apartment at 0,0).
let householdId: string;
let ipId: string;
let otherIpId: string;
let shiftId: string;
const taskId: Record<string, string> = {};

const SECRET = "SECRET-DEVICE-TAG";

async function photo(withExif = false) {
  const base = sharp({ create: { width: 320, height: 240, channels: 3, background: { r: 120, g: 160, b: 200 } } }).jpeg();
  return (withExif ? base.withMetadata({ exif: { IFD0: { Copyright: SECRET } } }) : base).toBuffer();
}

const here = { lat: 0, lng: 0, accuracyMeters: 5 };

async function upload(task: string, bytes: Buffer, over: Partial<Parameters<typeof acceptEvidence>[0]> = {}) {
  const { challengeId } = await issueChallenge(ipId, householdId, taskId[task]!);
  return acceptEvidence({
    userId: ipId,
    householdId,
    taskInstanceId: taskId[task]!,
    challengeId,
    imageBase64: bytes.toString("base64"),
    ...here,
    ...over,
  });
}

beforeAll(async () => {
  const passwordHash = await hashPassword("test-only-password");
  const h = await db.household.create({ data: { name: "evidence-test", apartmentLat: 0, apartmentLng: 0 } });
  householdId = h.id;
  const ip = await db.user.create({ data: { householdId, role: "IP", name: "I", email: `${h.id}-ip@test.local`, passwordHash } });
  const ip2 = await db.user.create({ data: { householdId, role: "IP", name: "I2", email: `${h.id}-ip2@test.local`, passwordHash } });
  ipId = ip.id;
  otherIpId = ip2.id;

  const names = ["plain", "A", "B", "C", "D"];
  for (const [i, title] of names.entries()) {
    await db.taskTemplate.create({
      data: { householdId, groupName: "Kitchen", title, instructions: "x", frequency: "VISIT", requiresPhoto: title !== "plain", sortOrder: i },
    });
  }

  const now = new Date();
  const shift = await db.scheduledShift.create({
    data: {
      householdId,
      ipUserId: ipId,
      localDate: localDateString(now, h.timezone),
      scheduledStartUtc: new Date(now.getTime() - 5 * 60_000),
      scheduledEndUtc: new Date(now.getTime() + 6 * 3_600_000),
      status: "SCHEDULED",
      createdBy: ipId,
    },
  });
  shiftId = shift.id;
  await checkIn({ shiftId, ipUserId: ipId, ...here });

  const tasks = await db.taskInstance.findMany({ where: { shiftId } });
  for (const t of tasks) taskId[t.titleSnapshot] = t.id;
});

afterAll(async () => {
  await db.evidence.deleteMany({ where: { taskInstance: { householdId } } });
  await db.captureChallenge.deleteMany({ where: { householdId } });
  await db.alertRead.deleteMany({ where: { alert: { householdId } } });
  await db.alert.deleteMany({ where: { householdId } });
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

describe("photo-required tasks", () => {
  it("cannot be completed without accepted evidence", async () => {
    await expect(completeTask(taskId.A!, ipId)).rejects.toMatchObject({ code: "EVIDENCE_REQUIRED" });
  });

  it("only issue challenges for tasks that need a photo", async () => {
    await expect(issueChallenge(ipId, householdId, taskId.plain!)).rejects.toMatchObject({ code: "PHOTO_NOT_REQUIRED" });
  });

  it("accepts a photo: hashes it, stores the original untouched, and strips metadata from the viewer copy", async () => {
    const original = await photo(true);
    expect(original.includes(Buffer.from(SECRET))).toBe(true); // sanity: the test image really has metadata

    await upload("A", original);

    const evidence = await db.evidence.findFirstOrThrow({ where: { taskInstanceId: taskId.A! } });
    expect(evidence.contentHash).toBe(sha256(original));
    expect(evidence.byteSize).toBe(original.length);

    const storedOriginal = await readRef(evidence.storageRef);
    expect(storedOriginal.equals(original)).toBe(true);

    const viewer = await readRef(evidence.viewerStorageRef);
    expect(viewer.includes(Buffer.from(SECRET))).toBe(false);
    expect((await sharp(viewer).metadata()).exif).toBeUndefined();

    const reading = await db.locationReading.findFirstOrThrow({ where: { shiftId, source: "PHOTO_CAPTURE" } });
    expect(reading.verification).toBe("VERIFIED");

    const ev = await db.event.findFirstOrThrow({ where: { householdId, action: "evidence_accepted", taskInstanceId: taskId.A! } });
    expect(evidence.eventId).toBe(ev.id);
    expect(evidence.uploadAcceptedAtServer.getTime()).toBe(ev.serverTimestampUtc.getTime());
  });

  it("can be completed once evidence is accepted", async () => {
    const done = await completeTask(taskId.A!, ipId);
    expect(done.state).toBe("COMPLETED_AWAITING_REVIEW");
  });

  it("a capture challenge works only once", async () => {
    const { challengeId } = await issueChallenge(ipId, householdId, taskId.B!);
    const args = { userId: ipId, householdId, taskInstanceId: taskId.B!, challengeId, imageBase64: (await photo()).toString("base64"), ...here };
    await acceptEvidence(args);
    await expect(acceptEvidence(args)).rejects.toMatchObject({ code: "CHALLENGE_INVALID" });
  });

  it("rejects an invented or expired challenge", async () => {
    const bytes = await photo();
    await expect(
      acceptEvidence({ userId: ipId, householdId, taskInstanceId: taskId.C!, challengeId: "11111111-1111-4111-8111-111111111111", imageBase64: bytes.toString("base64"), ...here })
    ).rejects.toMatchObject({ code: "CHALLENGE_INVALID" });

    const { challengeId } = await issueChallenge(ipId, householdId, taskId.C!);
    await db.captureChallenge.update({ where: { id: challengeId }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await expect(
      acceptEvidence({ userId: ipId, householdId, taskInstanceId: taskId.C!, challengeId, imageBase64: bytes.toString("base64"), ...here })
    ).rejects.toMatchObject({ code: "CHALLENGE_INVALID" });
  });

  it("will not let another IP use or issue a challenge for someone else's task", async () => {
    const { challengeId } = await issueChallenge(ipId, householdId, taskId.C!);
    await expect(
      acceptEvidence({ userId: otherIpId, householdId, taskInstanceId: taskId.C!, challengeId, imageBase64: (await photo()).toString("base64"), ...here })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(issueChallenge(otherIpId, householdId, taskId.C!)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("rejects files that are not usable photos, without burning the challenge", async () => {
    const { challengeId } = await issueChallenge(ipId, householdId, taskId.D!);
    const base = { userId: ipId, householdId, taskInstanceId: taskId.D!, challengeId, ...here };

    await expect(acceptEvidence({ ...base, imageBase64: Buffer.from("not an image at all").toString("base64") })).rejects.toMatchObject({ code: "UNSUPPORTED_IMAGE" });
    const tiny = await sharp({ create: { width: 10, height: 10, channels: 3, background: "#fff" } }).jpeg().toBuffer();
    await expect(acceptEvidence({ ...base, imageBase64: tiny.toString("base64") })).rejects.toMatchObject({ code: "IMAGE_TOO_SMALL" });
    const truncated = (await photo()).subarray(0, 40);
    await expect(acceptEvidence({ ...base, imageBase64: truncated.toString("base64") })).rejects.toMatchObject({ code: "INVALID_IMAGE" });

    await acceptEvidence({ ...base, imageBase64: (await photo()).toString("base64") }); // same ticket still good
    expect(await db.evidence.count({ where: { taskInstanceId: taskId.D! } })).toBe(1);
  });

  it("accepts a photo from the wrong place but records it as failed and alerts", async () => {
    await upload("C", await photo(), { lat: 10, lng: 10 });
    const reading = await db.locationReading.findFirstOrThrow({ where: { shiftId, source: "PHOTO_CAPTURE", verification: "FAILED" } });
    expect(reading.distanceMeters).toBeGreaterThan(1_000_000);
    const alert = await db.event.findFirst({ where: { householdId, action: "alert_raised", taskInstanceId: null, payload: { path: ["type"], equals: "location_verification_failed" } } });
    expect(alert).not.toBeNull();
  });

  it("shows the IP only a simple 'photo accepted' flag, with no audit timestamps", async () => {
    const dto = await ipTaskById(taskId.A!);
    expect(dto.hasEvidence).toBe(true);
    expect(Object.keys(dto).sort()).toEqual(
      ["clientNote", "correctionStatus", "hasEvidence", "id", "instructionsSnapshot", "reasonCode", "reasonText", "requiresPhotoSnapshot", "state", "titleSnapshot"].sort()
    );
  });

  it("stops accepting photos once the authorized window has closed", async () => {
    await db.scheduledShift.update({ where: { id: shiftId }, data: { authorizationClosedAt: new Date() } });
    await expect(issueChallenge(ipId, householdId, taskId.B!)).rejects.toMatchObject({ code: "SHIFT_NOT_OPEN" });
  });

  it("leaves the audit chain intact", async () => {
    expect(await verifyChainIntegrity(householdId)).toEqual({ ok: true });
  });
});
