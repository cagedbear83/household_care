import { afterAll, beforeAll, describe, expect, it } from "vitest";
import sharp from "sharp";
import { db } from "../src/db";
import { hashPassword } from "../src/auth/password";
import { checkIn } from "../src/services/authorization.service";
import { verifyChainIntegrity } from "../src/services/event.service";
import { acceptEvidence, issueChallenge } from "../src/services/evidence.service";
import { removeHouseholdFiles } from "../src/services/evidence-store";
import { ipTaskById } from "../src/services/ip-dto";
import {
  approveTask,
  confirmDecline,
  denyDecline,
  disputeTask,
  getPending,
  getReviewDay,
  getReviewTask,
} from "../src/services/review.service";
import { completeTask, declineOnClientBehalf, markTaskException, submitCorrectiveWork } from "../src/services/task.service";
import { localDateString } from "../src/services/time.service";

const CLIENT_VIEWER = { role: "CLIENT" as const, canViewTimestamps: true };
let householdId: string;
let otherHouseholdId: string;
let ipId: string;
let clientId: string;
let shiftId: string;
let localDate: string;
const t: Record<string, string> = {};

const client = () => ({ userId: clientId, householdId });
const here = { lat: 0, lng: 0, accuracyMeters: 5 };

const photo = (shade: number) =>
  sharp({ create: { width: 320, height: 240, channels: 3, background: { r: shade, g: 100, b: 100 } } }).jpeg().toBuffer();

async function takePhoto(task: string, shade: number) {
  const { challengeId } = await issueChallenge(ipId, householdId, t[task]!);
  await acceptEvidence({
    userId: ipId, householdId, taskInstanceId: t[task]!, challengeId,
    imageBase64: (await photo(shade)).toString("base64"), ...here,
  });
}

const actionsOf = async (task: string) => (await getReviewTask(householdId, t[task]!)).history.map((h) => h.action);

beforeAll(async () => {
  const passwordHash = await hashPassword("test-only-password");
  const mk = async (name: string) => db.household.create({ data: { name, apartmentLat: 0, apartmentLng: 0 } });
  const h = await mk("review-test");
  const other = await mk("review-test-other");
  householdId = h.id;
  otherHouseholdId = other.id;
  localDate = localDateString(new Date(), h.timezone);

  const ip = await db.user.create({ data: { householdId, role: "IP", name: "Pat", email: `${h.id}-ip@test.local`, passwordHash } });
  const client = await db.user.create({ data: { householdId, role: "CLIENT", name: "Chris", email: `${h.id}-c@test.local`, passwordHash } });
  ipId = ip.id;
  clientId = client.id;

  for (const [i, title] of ["P1", "P2", "P3", "P4", "P5", "PH"].entries()) {
    await db.taskTemplate.create({
      data: { householdId, groupName: "Kitchen", title, instructions: "x", frequency: "VISIT", requiresPhoto: title === "PH", sortOrder: i },
    });
  }
  const now = new Date();
  const shift = await db.scheduledShift.create({
    data: {
      householdId, ipUserId: ipId, localDate,
      scheduledStartUtc: new Date(now.getTime() - 5 * 60_000),
      scheduledEndUtc: new Date(now.getTime() + 6 * 3_600_000),
      status: "SCHEDULED", createdBy: ipId,
    },
  });
  shiftId = shift.id;
  await checkIn({ shiftId, ipUserId: ipId, ...here });
  for (const task of await db.taskInstance.findMany({ where: { shiftId } })) t[task.titleSnapshot] = task.id;
});

afterAll(async () => {
  for (const id of [householdId, otherHouseholdId]) {
    await db.evidence.deleteMany({ where: { taskInstance: { householdId: id } } });
    await db.captureChallenge.deleteMany({ where: { householdId: id } });
    await db.alertRead.deleteMany({ where: { alert: { householdId: id } } });
    await db.alert.deleteMany({ where: { householdId: id } });
    await db.event.deleteMany({ where: { householdId: id } });
    await db.locationReading.deleteMany({ where: { householdId: id } });
    await db.taskInstance.deleteMany({ where: { householdId: id } });
    await db.scheduledShift.deleteMany({ where: { householdId: id } });
    await db.weekAllowance.deleteMany({ where: { householdId: id } });
    await db.taskTemplate.deleteMany({ where: { householdId: id } });
    await db.user.deleteMany({ where: { householdId: id } });
    await db.household.delete({ where: { id } });
    await removeHouseholdFiles(id);
  }
  await db.$disconnect();
});

describe("approving", () => {
  it("shows a completed task in the pending list, then records the client's approval as its own event", async () => {
    await completeTask(t.P1!, ipId);
    expect((await getPending(householdId, CLIENT_VIEWER)).map((x) => x.id)).toContain(t.P1);

    const approved = await approveTask(client(), t.P1!);
    expect(approved.state).toBe("APPROVED");
    expect((await getPending(householdId, CLIENT_VIEWER)).map((x) => x.id)).not.toContain(t.P1);

    const h = approved.history;
    expect(h.map((e) => e.action)).toEqual(["task_completed", "task_approved"]);
    expect(h[0]).toMatchObject({ actorRole: "IP", actorName: "Pat" });
    expect(h[1]).toMatchObject({ actorRole: "CLIENT", actorName: "Chris" });
  });

  it("cannot be decided twice", async () => {
    await expect(approveTask(client(), t.P1!)).rejects.toMatchObject({ code: "ALREADY_DECIDED" });
    await expect(disputeTask(client(), t.P1!, "changed my mind")).rejects.toMatchObject({ code: "ALREADY_DECIDED" });
  });

  it("cannot be undone by the IP: an approved task cannot be re-completed or turned into an exception", async () => {
    await expect(completeTask(t.P1!, ipId)).rejects.toMatchObject({ code: "TASK_STATE" });
    await expect(markTaskException(t.P1!, ipId, "UNABLE_TO_COMPLETE", "other", "oops")).rejects.toMatchObject({ code: "TASK_STATE" });
    await expect(declineOnClientBehalf(t.P1!, ipId)).rejects.toMatchObject({ code: "TASK_STATE" });
    expect((await getReviewTask(householdId, t.P1!)).state).toBe("APPROVED");
  });

  it("cannot be done for a task in another household", async () => {
    await expect(approveTask({ userId: clientId, householdId: otherHouseholdId }, t.P2!)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("only tasks that are actually waiting can be approved", async () => {
    await expect(approveTask(client(), t.P2!)).rejects.toMatchObject({ code: "ALREADY_DECIDED" }); // still NOT_STARTED
  });
});

describe("disputing and corrective work", () => {
  it("needs a reason, then tells the IP what to fix and alerts admins", async () => {
    await completeTask(t.P2!, ipId);
    await expect(disputeTask(client(), t.P2!, "  ")).rejects.toMatchObject({ code: "REASON_REQUIRED" });

    const disputed = await disputeTask(client(), t.P2!, "Counters still sticky");
    expect(disputed.state).toBe("DISPUTED");
    expect(disputed.clientNote).toBe("Counters still sticky");

    const ipView = await ipTaskById(t.P2!);
    expect(ipView.state).toBe("DISPUTED");
    expect(ipView.clientNote).toBe("Counters still sticky");

    const alert = await db.event.findFirst({ where: { householdId, action: "alert_raised", payload: { path: ["type"], equals: "task_disputed" } } });
    expect(alert).not.toBeNull();
  });

  it("only a disputed task accepts corrective work", async () => {
    await expect(submitCorrectiveWork(t.P3!, ipId)).rejects.toMatchObject({ code: "TASK_STATE" });
  });

  it("keeps the completion, dispute, corrective submission and final approval as four separate events", async () => {
    await submitCorrectiveWork(t.P2!, ipId);
    expect((await getReviewTask(householdId, t.P2!)).state).toBe("CORRECTIVE_WORK_SUBMITTED");
    expect((await getPending(householdId, CLIENT_VIEWER)).map((x) => x.id)).toContain(t.P2);

    await approveTask(client(), t.P2!);
    expect(await actionsOf("P2")).toEqual(["task_completed", "task_disputed", "task_corrective_submitted", "task_approved"]);
    expect((await getReviewTask(householdId, t.P2!)).clientNote).toBeNull();
  });

  it("lets the client dispute corrective work again", async () => {
    await completeTask(t.P3!, ipId);
    await disputeTask(client(), t.P3!, "First problem");
    await submitCorrectiveWork(t.P3!, ipId);
    const again = await disputeTask(client(), t.P3!, "Still not right");
    expect(again.state).toBe("DISPUTED");
    expect(again.history.filter((e) => e.action === "task_disputed")).toHaveLength(2);
  });

  it("a disputed photo task needs a NEW photo before corrective work is accepted", async () => {
    await takePhoto("PH", 40);
    await completeTask(t.PH!, ipId);
    await disputeTask(client(), t.PH!, "Sink still has dishes in it");

    expect((await ipTaskById(t.PH!)).hasEvidence).toBe(false); // the old photo no longer counts
    await expect(submitCorrectiveWork(t.PH!, ipId)).rejects.toMatchObject({ code: "EVIDENCE_REQUIRED" });

    await takePhoto("PH", 200);
    expect((await ipTaskById(t.PH!)).hasEvidence).toBe(true);
    await submitCorrectiveWork(t.PH!, ipId);

    const review = await getReviewTask(householdId, t.PH!);
    expect(review.state).toBe("CORRECTIVE_WORK_SUBMITTED");
    expect(review.evidence).toHaveLength(2);
    expect(review.evidence[0]).toMatchObject({ locationVerification: "VERIFIED" });
    expect(review.evidence[0]!.contentHashShort).toHaveLength(12);
  });
});

describe("declines reported by the IP", () => {
  it("stay unresolved until the client confirms them", async () => {
    await declineOnClientBehalf(t.P4!, ipId, "Said he is not hungry");
    expect((await getReviewTask(householdId, t.P4!)).state).toBe("DECLINED_AWAITING_CONFIRMATION");
    expect((await getPending(householdId, CLIENT_VIEWER)).map((x) => x.id)).toContain(t.P4);

    const confirmed = await confirmDecline(client(), t.P4!);
    expect(confirmed.state).toBe("CLIENT_DECLINED_CONFIRMED");
    expect(confirmed.history.map((e) => e.action)).toEqual(["task_decline_reported", "task_decline_confirmed"]);
  });

  it("go back to the IP if the client denies having declined", async () => {
    await declineOnClientBehalf(t.P5!, ipId);
    const denied = await denyDecline(client(), t.P5!, "I do want lunch");
    expect(denied.state).toBe("NOT_STARTED");
    expect((await ipTaskById(t.P5!)).clientNote).toBe("I do want lunch");

    await completeTask(t.P5!, ipId); // the IP now does it
    expect((await ipTaskById(t.P5!)).clientNote).toBeNull();
  });

  it("a decline cannot be confirmed unless it is awaiting confirmation", async () => {
    await expect(confirmDecline(client(), t.P1!)).rejects.toMatchObject({ code: "ALREADY_DECIDED" });
  });
});

describe("the day view", () => {
  it("lists every task of the shift with its state, photos and history", async () => {
    const [shift] = await getReviewDay(householdId, localDate, CLIENT_VIEWER);
    expect(shift!.ipName).toBe("Pat");
    expect(shift!.tasks).toHaveLength(6);
    const states = Object.fromEntries(shift!.tasks.map((x) => [x.title, x.state]));
    expect(states).toMatchObject({
      P1: "APPROVED", P2: "APPROVED", P3: "DISPUTED", P4: "CLIENT_DECLINED_CONFIRMED",
      P5: "COMPLETED_AWAITING_REVIEW", PH: "CORRECTIVE_WORK_SUBMITTED",
    });
    expect(shift!.tasks.every((x) => x.groupName === "Kitchen")).toBe(true);
  });
});

describe("after the authorized window closes", () => {
  it("corrective work is no longer accepted", async () => {
    await db.scheduledShift.update({ where: { id: shiftId }, data: { authorizationClosedAt: new Date() } });
    await expect(submitCorrectiveWork(t.P3!, ipId)).rejects.toMatchObject({ code: "SHIFT_NOT_OPEN" });
  });

  it("but the client can still decide on work already submitted", async () => {
    expect((await approveTask(client(), t.PH!)).state).toBe("APPROVED");
  });

  it("leaves the audit chain intact", async () => {
    expect(await verifyChainIntegrity(householdId)).toEqual({ ok: true });
  });
});
