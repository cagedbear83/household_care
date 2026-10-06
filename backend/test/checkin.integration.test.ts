import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "../src/db";
import { hashPassword } from "../src/auth/password";
import { CheckInError, FLAG_AT, GENTLE_FLAGGED, GENTLE_OK, dueToday, history, listPlans, setPaused, setPlan, skip, submit } from "../src/services/checkin.service";
import { verifyChainIntegrity } from "../src/services/event.service";
import { listAlerts } from "../src/services/alert-feed.service";
import * as notify from "../src/services/notify.service";

let householdId: string;
let ids: { client: string; admin: string; ip: string; primary: string; other: string };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const days = (n: number) => new Date(Date.now() + n * 86_400_000);

const actor = (userId: string, role: "CLIENT" | "ADMIN" | "IP" | "FAMILY", ownRole?: "CLIENT" | "ADMIN" | "IP" | "FAMILY") => ({ userId, role, ownRole: ownRole ?? role, householdId });
const asClient = () => actor(ids.client, "CLIENT");
const asAdmin = () => actor(ids.admin, "ADMIN");
const asIp = () => actor(ids.ip, "IP");
const asPrimary = () => actor(ids.primary, "CLIENT", "FAMILY"); // the primary family member: CLIENT to the server

const rejects = async (p: Promise<unknown>, code: string) => {
  const err = await p.then(() => null, (e) => e);
  expect(err).toBeInstanceOf(CheckInError);
  expect((err as CheckInError).code).toBe(code);
};

const clearResponses = () => db.checkInResponse.deleteMany({ where: { householdId } });

beforeAll(async () => {
  const passwordHash = await hashPassword("test-only-password");
  const h = await db.household.create({ data: { name: "checkin-test", apartmentLat: 0, apartmentLng: 0 } });
  householdId = h.id;
  const mk = (role: "CLIENT" | "ADMIN" | "IP" | "FAMILY", name: string, extra: object = {}) =>
    db.user.create({ data: { householdId, role, name, email: `${name.toLowerCase()}-${h.id}@test.local`, passwordHash, ...extra } });
  const [client, admin, ip, primary, other] = await Promise.all([
    mk("CLIENT", "Chris"), mk("ADMIN", "Morgan"), mk("IP", "Pat"),
    mk("FAMILY", "Ann", { isPrimaryFamily: true, activatedAt: new Date(), phone: `+1312555${String(Math.floor(1000 + Math.random() * 9000))}` }),
    mk("FAMILY", "Ben", { activatedAt: new Date() }),
  ]);
  ids = { client: client.id, admin: admin.id, ip: ip.id, primary: primary.id, other: other.id };
});

afterEach(() => vi.restoreAllMocks());

afterAll(async () => {
  await db.alertRead.deleteMany({ where: { alert: { householdId } } });
  await db.alert.deleteMany({ where: { householdId } });
  await db.outboundMessage.deleteMany({ where: { householdId } });
  await db.checkInResponse.deleteMany({ where: { householdId } });
  await db.checkInPlan.deleteMany({ where: { householdId } });
  await db.event.deleteMany({ where: { householdId } });
  await db.user.deleteMany({ where: { householdId } });
  await db.household.delete({ where: { id: householdId } });
  await db.$disconnect();
});

describe("setting up a check-in", () => {
  it("is for an administrator, and needs the client's agreement to start", async () => {
    await rejects(setPlan(asClient(), { instrument: "PHQ2", everyDays: 1, clientAgreed: true }), "FORBIDDEN");
    await rejects(setPlan(asIp(), { instrument: "PHQ2", everyDays: 1, clientAgreed: true }), "FORBIDDEN");
    await rejects(setPlan(asAdmin(), { instrument: "PHQ2", everyDays: 1, clientAgreed: false }), "CONSENT_REQUIRED");
    await rejects(setPlan(asAdmin(), { instrument: "PHQ2", everyDays: 5, clientAgreed: true }), "INVALID");
    expect(await db.checkInPlan.count({ where: { householdId } })).toBe(0);

    await setPlan(asAdmin(), { instrument: "PHQ2", everyDays: 2, clientAgreed: true, consentNote: "Chris agreed on the phone" });
    const [plan] = await listPlans({ role: "CLIENT", householdId });
    expect(plan).toMatchObject({ instrument: "PHQ2", everyDays: 2, active: true, consentNote: "Chris agreed on the phone" });
  });

  it("can be changed later without asking again, and the IP cannot see the plans", async () => {
    await setPlan(asAdmin(), { instrument: "PHQ2", everyDays: 3, clientAgreed: false });
    expect((await listPlans({ role: "ADMIN", householdId }))[0]!.everyDays).toBe(3);
    await setPlan(asAdmin(), { instrument: "PHQ2", everyDays: 2, clientAgreed: false });
    await rejects(listPlans({ role: "IP", householdId }), "FORBIDDEN");
    await rejects(listPlans({ role: "FAMILY", householdId }), "FORBIDDEN");
  });

  it("can be paused and resumed by the client side", async () => {
    await setPaused(asClient(), "PHQ2", true);
    expect((await dueToday(asClient())).due).toHaveLength(0);
    await setPaused(asPrimary(), "PHQ2", false);
    expect((await dueToday(asClient())).due).toHaveLength(1);
    await rejects(setPaused(asIp(), "PHQ2", true), "FORBIDDEN");
    await rejects(setPaused(asClient(), "GAD2", true), "NOT_FOUND");
  });
});

describe("what is due", () => {
  it("shows the standard questions to the client only", async () => {
    const { due } = await dueToday(asClient());
    expect(due).toHaveLength(1);
    expect(due[0]!.instrument).toBe("PHQ2");
    expect(due[0]!.questions).toEqual(["Little interest or pleasure in doing things", "Feeling down, depressed, or hopeless"]);
    expect(due[0]!.options.map((o) => o.value)).toEqual([0, 1, 2, 3]);
    expect((await dueToday(asPrimary())).due).toHaveLength(1);
    expect((await dueToday(asAdmin())).due).toHaveLength(0);
    expect((await dueToday(asIp())).due).toHaveLength(0);
    expect((await dueToday({ role: "FAMILY", householdId })).due).toHaveLength(0);
  });

  it("comes round again after the chosen number of days, not before", async () => {
    await clearResponses();
    await submit(asClient(), "PHQ2", [0, 1]);
    expect((await dueToday(asClient())).due).toHaveLength(0);
    expect((await dueToday(asClient(), days(1))).due).toHaveLength(0); // every 2 days
    expect((await dueToday(asClient(), days(2))).due).toHaveLength(1);
    await setPlan(asAdmin(), { instrument: "PHQ2", everyDays: 1, clientAgreed: false });
    expect((await dueToday(asClient(), days(1))).due).toHaveLength(1); // now daily
    await setPlan(asAdmin(), { instrument: "PHQ2", everyDays: 2, clientAgreed: false });
  });

  it("counts a skip as that turn", async () => {
    await clearResponses();
    await skip(asClient(), "PHQ2");
    expect((await dueToday(asClient())).due).toHaveLength(0);
    expect((await dueToday(asClient(), days(2))).due).toHaveLength(1);
    const [row] = await db.checkInResponse.findMany({ where: { householdId } });
    expect(row).toMatchObject({ skipped: true, score: null, flagged: false, answers: [] });
  });
});

describe("answering", () => {
  it("asks for every answer, in range", async () => {
    await clearResponses();
    await rejects(submit(asClient(), "PHQ2", [1]), "INVALID");
    await rejects(submit(asClient(), "PHQ2", [1, 4]), "INVALID");
    await rejects(submit(asClient(), "PHQ2", [1, -1]), "INVALID");
    await rejects(submit(asClient(), "PHQ2", [1, 0.5]), "INVALID");
  });

  it("is only for the client and the primary family member, and only when one is due", async () => {
    await clearResponses();
    await rejects(submit(asAdmin(), "PHQ2", [3, 3]), "FORBIDDEN");
    await rejects(submit(asIp(), "PHQ2", [3, 3]), "FORBIDDEN");
    await rejects(submit(asClient(), "GAD2", [1, 1]), "NOT_DUE"); // no plan for it
    expect(await db.checkInResponse.count({ where: { householdId } })).toBe(0);
  });

  it("answers once: a second try the same day is turned away", async () => {
    await clearResponses();
    await submit(asClient(), "PHQ2", [1, 1]);
    await rejects(submit(asClient(), "PHQ2", [3, 3]), "NOT_DUE");
    await rejects(skip(asClient(), "PHQ2"), "NOT_DUE");
    expect(await db.checkInResponse.count({ where: { householdId } })).toBe(1);
  });

  it("records the primary family member as the one who answered", async () => {
    await clearResponses();
    await submit(asPrimary(), "PHQ2", [0, 0]);
    const [row] = await db.checkInResponse.findMany({ where: { householdId } });
    expect(row).toMatchObject({ answeredByUserId: ids.primary, answeredByRole: "FAMILY", score: 0 });
  });
});

describe("a score that needs a follow-up", () => {
  it("is flagged at 3 or more, and the client gets a gentle message with no score", async () => {
    expect(FLAG_AT).toBe(3);
    await clearResponses();
    const low = await submit(asClient(), "PHQ2", [1, 1]);
    expect(low).toMatchObject({ flagged: false, message: GENTLE_OK });
    expect(Object.keys(low).sort()).toEqual(["flagged", "id", "message", "saved"]);

    await clearResponses();
    const high = await submit(asClient(), "PHQ2", [2, 1]);
    expect(high.flagged).toBe(true);
    expect(high.message).toBe(GENTLE_FLAGGED);
    expect(high.message).toContain("988");
    expect(high.message).toContain("911");
    expect(JSON.stringify(high)).not.toMatch(/score|PHQ|\b3\b/i);
  });

  it("alerts administrators, with nothing about what was answered, and texts the primary family member", async () => {
    await clearResponses();
    await db.alert.deleteMany({ where: { householdId } });
    const sent = vi.spyOn(notify, "sendMessage").mockResolvedValue({ delivered: true, provider: "test" });
    await submit(asClient(), "PHQ2", [3, 3]);
    await wait(300);

    const alerts = await db.alert.findMany({ where: { householdId, type: "wellbeing_followup" } });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.audience).toEqual(["ADMIN"]);
    expect(`${alerts[0]!.title} ${alerts[0]!.message}`).not.toMatch(/PHQ|GAD|mood|anxi|depress|score|[0-9]/i);

    const adminFeed = await listAlerts({ userId: ids.admin, role: "ADMIN", householdId });
    expect(adminFeed.some((a: { type: string }) => a.type === "wellbeing_followup")).toBe(true);
    for (const role of ["CLIENT", "IP"] as const) {
      const feed = await listAlerts({ userId: role === "CLIENT" ? ids.client : ids.ip, role, householdId });
      expect(feed.some((a: { type: string }) => a.type === "wellbeing_followup")).toBe(false);
    }

    const primary = await db.user.findUniqueOrThrow({ where: { id: ids.primary }, select: { phone: true } });
    const to = sent.mock.calls.map(([m]) => m.to);
    expect(to).toContain(primary.phone);
    for (const [m] of sent.mock.calls) expect(`${m.subject ?? ""} ${m.body}`).not.toMatch(/PHQ|GAD|mood|anxi|depress|score|[0-9]/i);
    const client = await db.user.findUniqueOrThrow({ where: { id: ids.client }, select: { email: true } });
    expect(to).not.toContain(client.email); // the client is not texted about it
  });

  it("is not alerted when the score is lower", async () => {
    await clearResponses();
    await db.alert.deleteMany({ where: { householdId } });
    await submit(asClient(), "PHQ2", [1, 1]);
    expect(await db.alert.count({ where: { householdId, type: "wellbeing_followup" } })).toBe(0);
  });
});

describe("who can read the answers", () => {
  it("is an administrator only", async () => {
    await clearResponses();
    await submit(asClient(), "PHQ2", [2, 2]);
    const rows = await history({ role: "ADMIN", householdId });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ instrument: "PHQ2", answers: [2, 2], score: 4, flagged: true, answeredBy: "Chris", skipped: false });
    for (const role of ["CLIENT", "IP", "FAMILY"] as const) await rejects(history({ role, householdId }), "FORBIDDEN");
  });

  it("is kept out of the audit log, which only says that it happened", async () => {
    const events = await db.event.findMany({ where: { householdId, action: "wellbeing_checkin_answered" } });
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) {
      expect(Object.keys(e.payload as object).sort()).toEqual(["flagged", "instrument"]);
    }
    const everything = JSON.stringify(await db.event.findMany({ where: { householdId } }));
    expect(everything).not.toMatch(/"answers"|"score"/);
    expect((await verifyChainIntegrity(householdId)).ok).toBe(true);
  });
});

describe("GAD-2", () => {
  it("uses its own two questions and the same scoring", async () => {
    await setPlan(asAdmin(), { instrument: "GAD2", everyDays: 3, clientAgreed: true });
    const gad = (await dueToday(asClient())).due.find((d) => d.instrument === "GAD2");
    expect(gad?.questions).toEqual(["Feeling nervous, anxious or on edge", "Not being able to stop or control worrying"]);
    await db.checkInResponse.deleteMany({ where: { householdId, instrument: "GAD2" } });
    expect((await submit(asClient(), "GAD2", [1, 1])).flagged).toBe(false);
    await db.checkInResponse.deleteMany({ where: { householdId, instrument: "GAD2" } });
    expect((await submit(asClient(), "GAD2", [3, 0])).flagged).toBe(true);
  });
});
