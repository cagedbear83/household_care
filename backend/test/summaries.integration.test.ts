import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../src/db";
import { hashPassword } from "../src/auth/password";
import { checkIn } from "../src/services/authorization.service";
import { raiseAlert } from "../src/services/alert.service";
import { markAllRead } from "../src/services/alert-feed.service";
import { completeTask } from "../src/services/task.service";
import { buildSummaries, plural, spokenDuration, spokenList, type SummaryViewer } from "../src/services/summary.service";
import { localDateString } from "../src/services/time.service";

let householdId: string;
let ids: { client: string; admin: string; ip: string; famHidden: string; famTimes: string; shift: string };
const here = { lat: 0, lng: 0, accuracyMeters: 5 };
const tasks: Record<string, string> = {};

const viewer = (userId: string, role: SummaryViewer["role"], canViewTimestamps = role !== "FAMILY"): SummaryViewer => ({ userId, householdId, role, canViewTimestamps });
const asClient = () => viewer(ids.client, "CLIENT");
const asAdmin = () => viewer(ids.admin, "ADMIN");
const asFamilyHidden = () => viewer(ids.famHidden, "FAMILY", false);
const asFamilyTimes = () => viewer(ids.famTimes, "FAMILY", true);
const get = async (v: SummaryViewer, id: string, now?: Date) => (await buildSummaries(v, now)).find((s) => s.id === id);

beforeAll(async () => {
  const passwordHash = await hashPassword("test-only-password");
  const h = await db.household.create({ data: { name: "summaries-test", apartmentLat: 0, apartmentLng: 0 } });
  householdId = h.id;
  const mk = (role: "CLIENT" | "ADMIN" | "IP" | "FAMILY", name: string, extra: object = {}) =>
    db.user.create({ data: { householdId, role, name, email: `${name.toLowerCase()}-${h.id}@test.local`, passwordHash, ...extra } });
  const [client, admin, ip, famHidden, famTimes] = await Promise.all([
    mk("CLIENT", "Chris"),
    mk("ADMIN", "Morgan"),
    mk("IP", "Pat"),
    mk("FAMILY", "Sam", { canViewTimestamps: false }),
    mk("FAMILY", "Alex", { canViewTimestamps: true }),
  ]);
  for (const [i, title] of ["Dishes", "Trash", "Sweep floor", "Wipe counters"].entries()) {
    await db.taskTemplate.create({ data: { householdId, groupName: "Kitchen", title, instructions: "x", frequency: "VISIT", requiresPhoto: false, sortOrder: i } });
  }
  const now = new Date();
  const shift = await db.scheduledShift.create({
    data: {
      householdId,
      ipUserId: ip.id,
      localDate: localDateString(now, h.timezone),
      scheduledStartUtc: new Date(now.getTime() - 5 * 60_000),
      scheduledEndUtc: new Date(now.getTime() + 6 * 3_600_000),
      status: "SCHEDULED",
      createdBy: ip.id,
    },
  });
  ids = { client: client.id, admin: admin.id, ip: ip.id, famHidden: famHidden.id, famTimes: famTimes.id, shift: shift.id };
});

afterAll(async () => {
  await db.alertRead.deleteMany({ where: { alert: { householdId } } });
  await db.alert.deleteMany({ where: { householdId } });
  await db.shoppingItem.deleteMany({ where: { householdId } });
  await db.event.deleteMany({ where: { householdId } });
  await db.locationReading.deleteMany({ where: { householdId } });
  await db.taskInstance.deleteMany({ where: { householdId } });
  await db.scheduledShift.deleteMany({ where: { householdId } });
  await db.weekAllowance.deleteMany({ where: { householdId } });
  await db.taskTemplate.deleteMany({ where: { householdId } });
  const convs = await db.conversation.findMany({ where: { householdId }, select: { id: true } });
  const userIds = (await db.user.findMany({ where: { householdId }, select: { id: true } })).map((u) => u.id);
  await db.message.deleteMany({ where: { conversationId: { in: convs.map((c) => c.id) } } });
  await db.conversationRead.deleteMany({ where: { userId: { in: userIds } } });
  await db.conversation.deleteMany({ where: { householdId } });
  await db.user.deleteMany({ where: { householdId } });
  await db.household.delete({ where: { id: householdId } });
  await db.$disconnect();
});

describe("wording helpers", () => {
  it("reads lists the way a person would, and never reads a long one in full", () => {
    expect(spokenList([])).toBe("");
    expect(spokenList(["Eggs"])).toBe("Eggs");
    expect(spokenList(["Eggs", "Milk"])).toBe("Eggs and Milk");
    expect(spokenList(["Eggs", "Milk", "Bread"])).toBe("Eggs, Milk and Bread");
    expect(spokenList(["a", "b", "c", "d", "e", "f", "g", "h"], 6)).toBe("a, b, c, d, e, f and 2 more");
  });

  it("says durations and counts in words", () => {
    expect(spokenDuration(0)).toBe("0 minutes");
    expect(spokenDuration(1)).toBe("1 minute");
    expect(spokenDuration(60)).toBe("1 hour");
    expect(spokenDuration(95)).toBe("1 hour and 35 minutes");
    expect(spokenDuration(2160)).toBe("36 hours");
    expect(plural(1, "task")).toBe("1 task");
    expect(plural(2, "task")).toBe("2 tasks");
  });
});

describe("before the visit starts", () => {
  it("says the IP has not checked in and that nothing is done or listed yet", async () => {
    expect((await get(asClient(), "checkin"))!.text).toMatch(/Pat has not checked in yet/);
    expect((await get(asClient(), "completed"))!.empty).toBe(true);
    expect((await get(asClient(), "left"))!.text).toMatch(/task list is not ready/);
  });

  it("has an honest 'nothing' for the quiet things", async () => {
    expect((await get(asClient(), "decisions"))!.text).toBe("Nothing is waiting for a decision.");
    expect((await get(asClient(), "alerts"))!.text).toBe("You have no new alerts.");
    expect((await get(asClient(), "messages"))!.text).toBe("You have no unread messages.");
    expect((await get(asClient(), "shopping"))!.text).toBe("The shopping list is empty.");
    expect((await get(asClient(), "hours"))!.text).toBe("No hours have been worked yet this week.");
  });
});

describe("during the visit", () => {
  beforeAll(async () => {
    await checkIn({ shiftId: ids.shift, ipUserId: ids.ip, ...here });
    for (const t of await db.taskInstance.findMany({ where: { shiftId: ids.shift } })) tasks[t.titleSnapshot] = t.id;
  });

  it("says when the IP checked in, with the time for those who may hear it", async () => {
    expect((await get(asClient(), "checkin"))!.text).toMatch(/^Pat checked in at \d{1,2}:\d{2} (AM|PM) and is here now\.$/);
    expect((await get(asFamilyTimes(), "checkin"))!.text).toMatch(/checked in at \d{1,2}:\d{2}/);
  });

  it("leaves the time out for a family member who was not approved to see times", async () => {
    const text = (await get(asFamilyHidden(), "checkin"))!.text;
    expect(text).toBe("Pat checked in and is here now.");
    expect(text).not.toMatch(/\d:\d\d/);
  });

  it("lists what is left, then what is done, as tasks get completed", async () => {
    expect((await get(asClient(), "left"))!.text).toBe("4 tasks are still to do today: Dishes, Trash, Sweep floor and Wipe counters.");
    await completeTask(tasks["Dishes"]!, ids.ip);
    await completeTask(tasks["Trash"]!, ids.ip);

    const left = await get(asClient(), "left");
    expect(left!.text).toBe("2 tasks are still to do today: Sweep floor and Wipe counters.");

    const done = await get(asClient(), "completed");
    expect(done!.empty).toBe(false);
    // The spec's "read aloud? yes or no" comes first; the list is only spoken after a yes.
    expect(done!.askFirst).toBe("2 tasks were completed today. Would you like me to read them out loud?");
    expect(done!.text).toContain("Dishes and Trash"); // always in the checklist's own order
    expect(done!.text).toContain("2 are waiting for approval");
  });

  it("tells the client what needs a decision, and tells an administrator the same without saying 'you'", async () => {
    expect((await get(asClient(), "decisions"))!.text).toBe("You have 2 things waiting for a decision: 2 completed tasks to review.");
    expect((await get(asAdmin(), "decisions"))!.text).toBe("There are 2 things waiting for a decision: 2 completed tasks to review.");
  });

  it("gives family members only what they are meant to hear", async () => {
    const hidden = await buildSummaries(asFamilyHidden());
    const ids2 = hidden.map((s) => s.id);
    // No decisions, alerts, shopping, or hours for family; nothing derived from attendance times without approval.
    expect(ids2).not.toContain("decisions");
    expect(ids2).not.toContain("alerts");
    expect(ids2).not.toContain("shopping");
    expect(ids2).not.toContain("hours");
    expect(ids2).toContain("completed");
    // The completed list omits approval status (it is the client's to act on).
    const done = hidden.find((s) => s.id === "completed")!;
    expect(done.text).not.toMatch(/waiting for approval/);
    const allText = hidden.map((s) => s.text).join(" ");
    expect(allText).not.toMatch(/\d{1,2}:\d{2} (AM|PM)/);
    expect(allText).not.toMatch(/photo/);

    // A family member who was approved hears the hours too.
    expect((await buildSummaries(asFamilyTimes())).map((s) => s.id)).toContain("hours");
  });

  it("counts the hours worked this week, including the visit in progress, against the 36 hour limit", async () => {
    const later = new Date(Date.now() + 90 * 60_000);
    const hours = await get(asClient(), "hours", later);
    expect(hours!.text).toMatch(/^Pat has worked 1 hour and \d+ minutes? this week\. .* remain before the limit of 36 hours\.$/);
  });

  it("puts new alerts first, urgent ones spelled out in words, and quiets down once they are read", async () => {
    await db.$transaction((tx) =>
      raiseAlert(tx, { householdId, actorUserId: ids.ip, actorRole: "IP", type: "food_hazard", message: "Mold in the refrigerator.", dedupeKey: "mold" })
    );
    const all = await buildSummaries(asClient());
    expect(all[1]!.id).toBe("alerts"); // right after the full update
    expect(all[1]!.text).toMatch(/new alert.*1 urgent\. Urgent: Mold in the refrigerator\./);
    expect(all[0]!.text).toMatch(/^You have \d+ new alerts?, 1 urgent/);

    await markAllRead({ userId: ids.client, role: "CLIENT", householdId });
    expect((await get(asClient(), "alerts"))!.text).toBe("You have no new alerts.");
  });

  it("reads the shopping list with what is gone first, and trims a long list", async () => {
    await db.shoppingItem.createMany({
      data: [
        { householdId, name: "Milk", nameKey: "milk", status: "NEEDED", source: "CLIENT", createdByUserId: ids.client, quantity: "1 gallon" },
        { householdId, name: "Eggs", nameKey: "eggs", status: "OUT", source: "IP_REPORT", createdByUserId: ids.ip },
        ...["Bread", "Rice", "Apples", "Soap", "Tea", "Salt", "Beans", "Pasta"].map((n) => ({
          householdId, name: n, nameKey: n.toLowerCase(), status: "NEEDED" as const, source: "CLIENT" as const, createdByUserId: ids.client,
        })),
      ],
    });
    const text = (await get(asClient(), "shopping"))!.text;
    expect(text).toMatch(/^The shopping list has 10 items\. Eggs is all gone\. On the list: Eggs, /);
    expect(text).toMatch(/and 2 more\.$/);
  });

  it("uses the same wording for the client and an administrator where it is not about them", async () => {
    expect((await get(asAdmin(), "left"))!.text).toBe((await get(asClient(), "left"))!.text);
  });

  it("builds a full update that counts finished tasks but leaves the list for when it is asked for", async () => {
    const briefing = (await get(asClient(), "briefing"))!;
    expect(briefing.text).toContain("2 tasks have been completed today. Choose done today to hear which.");
    expect(briefing.text).not.toContain("Dishes and Trash");
    expect(briefing.text).toContain("Pat checked in");
    // Quiet sections stay out of the briefing, so it is not padded with "nothing" lines.
    expect(briefing.text).not.toContain("You have no unread messages");
  });
});
