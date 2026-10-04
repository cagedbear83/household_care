import { afterAll, beforeAll, describe, expect, it } from "vitest";
import sharp from "sharp";
import type { Request, Response } from "express";
import { db } from "../src/db";
import { hashPassword, verifyPassword } from "../src/auth/password";
import { signAuthToken } from "../src/auth/jwt";
import { requireAuth } from "../src/auth/middleware";
import { checkIn } from "../src/services/authorization.service";
import { verifyChainIntegrity } from "../src/services/event.service";
import { readRef, removeHouseholdFiles } from "../src/services/evidence-store";
import { completePasswordReset, requestPasswordReset } from "../src/services/password-reset.service";
import {
  acknowledgeHazard,
  approveRequest,
  createDisposalRequest,
  declineRequest,
  escalateStaleFoodRequests,
  issueFoodChallenge,
  listForIp,
  listForStaff,
  loadFoodPhoto,
  recordDisposal,
  reportHazard,
} from "../src/services/food.service";
import { addItem, closeItem, listShopping, reportLowSupply, updateItem } from "../src/services/shopping.service";
import { localDateString } from "../src/services/time.service";

let householdId: string;
let otherHouseholdId: string;
let ids: { client: string; admin: string; ip: string; ip2: string; other: string; shift: string };
const emails = { client: "", admin: "" };
const clientPhone = `+1312555${String(Math.floor(1000 + Math.random() * 9000))}`;

const ipA = () => ({ userId: ids.ip, householdId });
const client = () => ({ userId: ids.client, role: "CLIENT" as const, householdId });
const admin = () => ({ userId: ids.admin, role: "ADMIN" as const, householdId });
const shopper = (role: "IP" | "CLIENT" | "ADMIN" = "CLIENT") => ({ userId: role === "IP" ? ids.ip : ids.client, role, householdId });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const here = { lat: 0, lng: 0, accuracyMeters: 5 };

const SECRET = "SECRET-FOOD-TAG";
const jpeg = (withExif = false) => {
  const base = sharp({ create: { width: 320, height: 240, channels: 3, background: { r: 200, g: 120, b: 80 } } }).jpeg();
  return (withExif ? base.withMetadata({ exif: { IFD0: { Copyright: SECRET } } }) : base).toBuffer();
};

async function foodRequest(over: Partial<Parameters<typeof createDisposalRequest>[1]> = {}, exif = false) {
  const { challengeId } = await issueFoodChallenge(ipA());
  return createDisposalRequest(ipA(), {
    item: "Milk",
    location: "Refrigerator, door shelf",
    reasonCode: "past_date",
    dateLabel: "Use by Sep 28",
    replacement: "Milk (1 gallon)",
    challengeId,
    imageBase64: (await jpeg(exif)).toString("base64"),
    ...here,
    ...over,
  });
}

const outboundTo = (to: string) => db.outboundMessage.findMany({ where: { toAddress: to }, orderBy: { createdAt: "asc" } });

beforeAll(async () => {
  const passwordHash = await hashPassword("old-password-123");
  const h = await db.household.create({ data: { name: "supplies-test", apartmentLat: 0, apartmentLng: 0 } });
  const o = await db.household.create({ data: { name: "supplies-test-other", apartmentLat: 0, apartmentLng: 0 } });
  householdId = h.id;
  otherHouseholdId = o.id;
  emails.client = `client-${h.id}@test.local`;
  emails.admin = `admin-${h.id}@test.local`;

  const mk = (hid: string, role: "CLIENT" | "ADMIN" | "IP", name: string, email: string, extra: object = {}) =>
    db.user.create({ data: { householdId: hid, role, name, email, passwordHash, ...extra } });
  const [c, a, ip, ip2, other] = await Promise.all([
    mk(householdId, "CLIENT", "Chris", emails.client, { phone: clientPhone }),
    mk(householdId, "ADMIN", "Morgan", emails.admin),
    mk(householdId, "IP", "Pat", `ip-${h.id}@test.local`),
    mk(householdId, "IP", "Quinn", `ip2-${h.id}@test.local`),
    mk(otherHouseholdId, "CLIENT", "Outsider", `out-${h.id}@test.local`),
  ]);

  const now = new Date();
  const shift = await db.scheduledShift.create({
    data: {
      householdId, ipUserId: ip.id, localDate: localDateString(now, h.timezone),
      scheduledStartUtc: new Date(now.getTime() - 5 * 60_000), scheduledEndUtc: new Date(now.getTime() + 6 * 3_600_000),
      status: "SCHEDULED", createdBy: ip.id,
    },
  });
  await checkIn({ shiftId: shift.id, ipUserId: ip.id, ...here });
  ids = { client: c.id, admin: a.id, ip: ip.id, ip2: ip2.id, other: other.id, shift: shift.id };
});

afterAll(async () => {
  for (const id of [householdId, otherHouseholdId]) {
    const users = await db.user.findMany({ where: { householdId: id }, select: { id: true } });
    await db.passwordReset.deleteMany({ where: { userId: { in: users.map((u) => u.id) } } });
    await db.foodDisposalRequest.deleteMany({ where: { householdId: id } });
    await db.shoppingItem.deleteMany({ where: { householdId: id } });
    await db.outboundMessage.deleteMany({ where: { householdId: id } });
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

// ---------------------------------------------------------------------------------

describe("password reset", () => {
  it("says and sends nothing for an unknown account (so it cannot be used to look people up)", async () => {
    const before = await db.outboundMessage.count({ where: { householdId } });
    expect(await requestPasswordReset("nobody-here@test.local")).toEqual({});
    expect(await requestPasswordReset("not even an email")).toEqual({});
    expect(await db.outboundMessage.count({ where: { householdId } })).toBe(before);
  });

  it("sends a 6-digit code to the address that was typed, and records the request", async () => {
    const { devCode } = await requestPasswordReset(emails.client);
    expect(devCode).toMatch(/^\d{6}$/);
    const sent = (await outboundTo(emails.client)).at(-1)!;
    expect(sent).toMatchObject({ channel: "EMAIL", kind: "password_reset", status: "SENT" });
    expect(sent.body).toContain(devCode!);
    expect(await db.event.count({ where: { householdId, action: "password_reset_requested" } })).toBe(1);
    const stored = await db.passwordReset.findFirstOrThrow({ where: { userId: ids.client } });
    expect(stored.codeHash).not.toContain(devCode!); // only a hash is kept
  });

  it("slows repeated requests (60 seconds between codes)", async () => {
    const before = await db.passwordReset.count({ where: { userId: ids.client } });
    expect(await requestPasswordReset(emails.client)).toEqual({});
    expect(await db.passwordReset.count({ where: { userId: ids.client } })).toBe(before);
  });

  it("refuses a weak password and a wrong code, and locks the code after 5 wrong tries", async () => {
    const reset = await db.passwordReset.findFirstOrThrow({ where: { userId: ids.client } });
    await expect(completePasswordReset(emails.client, "123456", "short")).rejects.toMatchObject({ code: "WEAK_PASSWORD" });
    for (let i = 0; i < 5; i++) await expect(completePasswordReset(emails.client, "000000", "brand-new-pass-1")).rejects.toMatchObject({ code: "RESET_INVALID" });
    expect((await db.passwordReset.findUniqueOrThrow({ where: { id: reset.id } })).attempts).toBe(5);

    // Even the right code is now refused until a new one is requested.
    await db.passwordReset.updateMany({ where: { userId: ids.client }, data: { createdAt: new Date(Date.now() - 120_000) } });
    const fresh = await requestPasswordReset(emails.client);
    await expect(completePasswordReset(emails.client, "000000", "brand-new-pass-1")).rejects.toMatchObject({ code: "RESET_INVALID" });
    expect(fresh.devCode).toMatch(/^\d{6}$/);
  });

  it("an expired code and a code for another account are refused the same way", async () => {
    await db.passwordReset.updateMany({ where: { userId: ids.client, usedAt: null }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await expect(completePasswordReset(emails.client, "123456", "brand-new-pass-1")).rejects.toMatchObject({ code: "RESET_INVALID" });
    await expect(completePasswordReset("ghost@test.local", "123456", "brand-new-pass-1")).rejects.toMatchObject({ code: "RESET_INVALID" });
  });

  it("changes the password, ends every existing session, and spends the code", async () => {
    await db.passwordReset.updateMany({ where: { userId: ids.admin }, data: {} });
    const { devCode } = await requestPasswordReset(emails.admin);

    // An old session works until the reset...
    const oldToken = signAuthToken({ userId: ids.admin, householdId, role: "ADMIN" });
    const run = async (token: string) => {
      let status = 200;
      let nexted = false;
      const res = { status(code: number) { status = code; return this; }, json() { return this; } } as unknown as Response;
      await requireAuth({ headers: { authorization: `Bearer ${token}` } } as unknown as Request, res, () => { nexted = true; });
      return { status, nexted };
    };
    expect((await run(oldToken)).nexted).toBe(true);

    await completePasswordReset(emails.admin, devCode!, "brand-new-pass-1");
    const admin = await db.user.findUniqueOrThrow({ where: { id: ids.admin } });
    expect(await verifyPassword("brand-new-pass-1", admin.passwordHash)).toBe(true);
    expect(await verifyPassword("old-password-123", admin.passwordHash)).toBe(false);
    expect(admin.tokensValidAfter).not.toBeNull();

    // ...and not after. A session started later works.
    expect(await run(oldToken)).toMatchObject({ nexted: false, status: 401 });
    await wait(1100);
    expect((await run(signAuthToken({ userId: ids.admin, householdId, role: "ADMIN" }))).nexted).toBe(true);

    await expect(completePasswordReset(emails.admin, devCode!, "another-new-pass-2")).rejects.toMatchObject({ code: "RESET_INVALID" });
    expect((await outboundTo(emails.admin)).some((m) => /was just changed/.test(m.body))).toBe(true); // the "was this you?" notice
    expect(await db.event.count({ where: { householdId, action: "password_reset_completed" } })).toBe(1);
  });

  it("works with a phone number, and is refused for turned-off accounts", async () => {
    await db.passwordReset.updateMany({ where: { userId: ids.client }, data: { createdAt: new Date(Date.now() - 120_000) } }); // past the cooldown
    const digits = clientPhone.slice(2);
    const { devCode } = await requestPasswordReset(`(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`);
    expect(devCode).toMatch(/^\d{6}$/);
    expect((await outboundTo(clientPhone)).at(-1)).toMatchObject({ channel: "SMS", kind: "password_reset" });

    await db.user.update({ where: { id: ids.ip2 }, data: { accessRevokedAt: new Date() } });
    expect(await requestPasswordReset(`ip2-${householdId}@test.local`)).toEqual({});
    await db.user.update({ where: { id: ids.ip2 }, data: { accessRevokedAt: null } });
  });
});

// ---------------------------------------------------------------------------------

describe("food disposal: asking first", () => {
  let requestId: string;

  it("is only for an IP who is checked in on an authorized shift", async () => {
    await expect(issueFoodChallenge({ userId: ids.ip2, householdId })).rejects.toMatchObject({ code: "SHIFT_NOT_OPEN" });
  });

  it("needs the item, its exact location, a reason, and a photo taken with a one-use ticket", async () => {
    await expect(foodRequest({ item: " " })).rejects.toMatchObject({ code: "INVALID" });
    await expect(foodRequest({ location: "" })).rejects.toMatchObject({ code: "INVALID" });
    await expect(foodRequest({ reasonCode: "because" })).rejects.toMatchObject({ code: "INVALID" });
    await expect(foodRequest({ reasonCode: "other" })).rejects.toMatchObject({ code: "INVALID" }); // "other" needs words
    await expect(foodRequest({ challengeId: "11111111-1111-4111-8111-111111111111" })).rejects.toMatchObject({ code: "CHALLENGE_INVALID" });

    const { challengeId } = await issueFoodChallenge(ipA());
    const base = { item: "Milk", location: "Fridge", reasonCode: "spoiled", challengeId, ...here };
    await expect(createDisposalRequest(ipA(), { ...base, imageBase64: Buffer.from("not a photo").toString("base64") })).rejects.toMatchObject({ code: "UNSUPPORTED_IMAGE" });
    // The bad file did not burn the ticket.
    await createDisposalRequest(ipA(), { ...base, item: "Yogurt", imageBase64: (await jpeg()).toString("base64") });
    await expect(createDisposalRequest(ipA(), { ...base, imageBase64: (await jpeg()).toString("base64") })).rejects.toMatchObject({ code: "CHALLENGE_INVALID" });
  });

  it("creates a pending request, keeps the photo untouched, strips metadata from the viewer copy, and alerts people", async () => {
    const original = await jpeg(true);
    expect(original.includes(Buffer.from(SECRET))).toBe(true);
    const created = await foodRequest({ item: "Chicken", location: "Refrigerator, bottom shelf", dateLabel: "Use by Sep 30", reasonCode: "past_date" }, true);
    requestId = created.id;

    expect(created).toMatchObject({ status: "PENDING", kind: "DISPOSAL", item: "Chicken", location: "Refrigerator, bottom shelf", dateLabel: "Use by Sep 30", replacement: "Milk (1 gallon)" });
    expect(created.photoLocationVerification).toBe("VERIFIED");

    const viewer = await readRef(created.photoViewerRef!);
    expect(viewer.includes(Buffer.from(SECRET))).toBe(false);
    expect((await readRef(created.photoStorageRef!)).includes(Buffer.from(SECRET))).toBe(true);
    expect(await loadFoodPhoto(householdId, created.id)).not.toBeNull();
    expect(await loadFoodPhoto(otherHouseholdId, created.id)).toBeNull();

    expect(await db.event.count({ where: { householdId, action: "food_disposal_requested" } })).toBeGreaterThanOrEqual(1);
    expect(await db.event.count({ where: { householdId, action: "alert_raised", payload: { path: ["type"], equals: "food_request" } } })).toBeGreaterThanOrEqual(1);

    await wait(500); // notifications are sent in the background
    const toClient = (await outboundTo(clientPhone)).filter((m) => m.kind === "alert");
    const toAdmin = (await outboundTo(emails.admin)).filter((m) => m.kind === "alert");
    expect(toClient.some((m) => m.channel === "SMS" && m.body.includes("Chicken"))).toBe(true);
    expect(toAdmin.some((m) => m.channel === "EMAIL" && m.body.includes("Chicken"))).toBe(true);
  });

  it("cannot be thrown away before the client approves it", async () => {
    await expect(recordDisposal(ipA(), requestId)).rejects.toMatchObject({ code: "NOT_APPROVED" });
    const mine = await listForIp(ipA());
    expect(mine.find((r) => r.id === requestId)).toMatchObject({ status: "PENDING", leaveInPlace: false });
  });

  it("only the client can decide, once", async () => {
    await expect(approveRequest(admin(), requestId)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(approveRequest({ ...client(), householdId: otherHouseholdId }, requestId)).rejects.toMatchObject({ code: "NOT_FOUND" });

    const approved = await approveRequest(client(), requestId);
    expect(approved).toMatchObject({ status: "APPROVED", decidedByUserId: ids.client });
    await expect(approveRequest(client(), requestId)).rejects.toMatchObject({ code: "ALREADY_DECIDED" });
    await expect(declineRequest(client(), requestId, "changed my mind")).rejects.toMatchObject({ code: "ALREADY_DECIDED" });
  });

  it("after approval the IP records the actual disposal, and the replacement goes on the shopping list", async () => {
    const done = await recordDisposal(ipA(), requestId);
    expect(done).toMatchObject({ status: "DISPOSED", disposedByUserId: ids.ip });
    await expect(recordDisposal(ipA(), requestId)).rejects.toMatchObject({ code: "NOT_APPROVED" }); // not twice

    const list = await listShopping(householdId);
    const item = list.open.find((i) => i.name === "Milk (1 gallon)")!;
    expect(item).toMatchObject({ source: "DISPOSAL", storageLocation: "Refrigerator, bottom shelf", note: "Replacing discarded Chicken", status: "NEEDED" });
  });

  it("a declined request stays in place and cannot be thrown away", async () => {
    const r = await foodRequest({ item: "Leftover soup", replacement: undefined });
    const declined = await declineRequest(client(), r.id, "I am still going to eat that");
    expect(declined).toMatchObject({ status: "DECLINED", decisionNote: "I am still going to eat that" });
    await expect(recordDisposal(ipA(), r.id)).rejects.toMatchObject({ code: "NOT_APPROVED" });
    expect((await listForIp(ipA())).find((x) => x.id === r.id)).toMatchObject({ status: "DECLINED", decisionNote: "I am still going to eat that" });
  });

  it("a second discarded item with the same replacement merges instead of duplicating", async () => {
    const r = await foodRequest({ item: "Old milk carton", location: "Door shelf" });
    await approveRequest(client(), r.id);
    await recordDisposal(ipA(), r.id);
    const rows = (await listShopping(householdId)).open.filter((i) => i.name === "Milk (1 gallon)");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.reportCount).toBe(2);
  });

  it("an item with no replacement adds nothing to the shopping list", async () => {
    const before = (await listShopping(householdId)).open.length;
    const r = await foodRequest({ item: "Bread heel", replacement: undefined });
    await approveRequest(client(), r.id);
    await recordDisposal(ipA(), r.id);
    expect((await listShopping(householdId)).open).toHaveLength(before);
  });
});

describe("food disposal: nobody answers", () => {
  it("is left in place, the administrator is alerted once, and the client can still answer later", async () => {
    const r = await foodRequest({ item: "Cottage cheese", location: "Fridge", replacement: undefined });
    await db.foodDisposalRequest.update({ where: { id: r.id }, data: { createdAt: new Date(Date.now() - 31 * 60_000) } });

    expect(await escalateStaleFoodRequests()).toBeGreaterThanOrEqual(1);
    const after = await db.foodDisposalRequest.findUniqueOrThrow({ where: { id: r.id } });
    expect(after).toMatchObject({ status: "PENDING" }); // not approved, not discarded
    expect(after.escalatedAt).not.toBeNull();
    expect(await escalateStaleFoodRequests()).toBe(0); // once only

    expect(await db.event.count({ where: { householdId, action: "food_request_escalated" } })).toBe(1);
    expect((await listForIp(ipA())).find((x) => x.id === r.id)?.leaveInPlace).toBe(true);
    await wait(500);
    expect((await outboundTo(emails.admin)).some((m) => m.body.includes("No answer yet") && m.body.includes("Cottage cheese"))).toBe(true);

    await expect(recordDisposal(ipA(), r.id)).rejects.toMatchObject({ code: "NOT_APPROVED" });
    expect((await approveRequest(client(), r.id)).status).toBe("APPROVED"); // a late answer still counts
  });
});

describe("food hazards", () => {
  it("need the reason and what was done, and are never treated as an approval", async () => {
    await expect(reportHazard(ipA(), { item: "Raw chicken", location: "Shelf", reason: "", actionTaken: "Threw it out" })).rejects.toMatchObject({ code: "INVALID" });
    await expect(reportHazard(ipA(), { item: "Raw chicken", location: "Shelf", reason: "Leaking onto other food", actionTaken: " " })).rejects.toMatchObject({ code: "INVALID" });
  });

  it("are recorded as an exception, announced straight away, add the replacement, and are acknowledged by the client", async () => {
    const h = await reportHazard(ipA(), { item: "Raw chicken", location: "Refrigerator, top shelf", reason: "Package was leaking onto the produce", actionTaken: "Bagged it, took it out with the trash, wiped the shelf", replacement: "Chicken breasts" });
    expect(h).toMatchObject({ kind: "HAZARD", status: "HAZARD_REPORTED", reasonCode: "hazard", actionTaken: expect.stringContaining("Bagged") });
    expect(h.photoViewerRef).toBeNull(); // a photo is welcome but not required

    expect(await db.event.count({ where: { householdId, action: "food_hazard_reported" } })).toBe(1);
    expect(await db.event.count({ where: { householdId, action: "alert_raised", payload: { path: ["type"], equals: "food_hazard" } } })).toBe(1);
    expect((await listShopping(householdId)).open.some((i) => i.name === "Chicken breasts")).toBe(true);
    await wait(500);
    expect((await outboundTo(clientPhone)).some((m) => m.body.includes("food hazard"))).toBe(true);

    expect((await listForStaff(householdId)).hazards.map((x) => x.id)).toContain(h.id);
    await expect(acknowledgeHazard(admin(), h.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await acknowledgeHazard(client(), h.id)).status).toBe("HAZARD_ACKNOWLEDGED");
    await expect(acknowledgeHazard(client(), h.id)).rejects.toMatchObject({ code: "ALREADY_DECIDED" });
    expect((await listForStaff(householdId)).hazards.map((x) => x.id)).not.toContain(h.id);
  });

  it("can include a photo", async () => {
    const { challengeId } = await issueFoodChallenge(ipA());
    const h = await reportHazard(ipA(), {
      item: "Broken jar", location: "Pantry floor", reason: "Glass on the floor", actionTaken: "Swept it up",
      photo: { challengeId, imageBase64: (await jpeg()).toString("base64"), ...here },
    });
    expect(h.photoViewerRef).not.toBeNull();
  });
});

describe("what each person sees of food requests", () => {
  it("the client and administrator get the full record, the IP only status and the answer", async () => {
    const staff = await listForStaff(householdId);
    const disposed = staff.history.find((x) => x.item === "Chicken")!;
    expect(disposed).toMatchObject({ status: "DISPOSED", requestedBy: "Pat", decidedBy: "Chris", disposedBy: "Pat", reason: "Past the date on the label", dateLabel: "Use by Sep 30", hasPhoto: true });
    expect(disposed.requestedAt).toBeTruthy();
    expect(disposed.decidedAt).toBeTruthy();
    expect(disposed.disposedAt).toBeTruthy();

    const mine = (await listForIp(ipA()))[0]!;
    expect(Object.keys(mine).some((k) => /At$|By$/.test(k))).toBe(false); // no audit timestamps or actors for the IP
    expect(await listForIp({ userId: ids.ip2, householdId })).toEqual([]);
    expect((await listForStaff(otherHouseholdId)).history).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------

describe("shopping list", () => {
  it("merges the same item typed differently, and the worse status wins", async () => {
    const a = await addItem(shopper(), { name: "Eggs", status: "NEEDED" });
    const b = await addItem(shopper("ADMIN"), { name: "  eggs! ", status: "LOW", quantity: "2 dozen", storageLocation: "Refrigerator" });
    expect(b.created).toBe(false);
    expect(b.item.id).toBe(a.item.id);
    expect(b.item).toMatchObject({ status: "LOW", quantity: "2 dozen", storageLocation: "Refrigerator", reportCount: 2 });
    const c = await addItem(shopper(), { name: "EGGS", status: "NEEDED" }); // a milder report never downgrades
    expect(c.item.status).toBe("LOW");
    expect((await addItem(shopper(), { name: "eggs", status: "OUT" })).item.status).toBe("OUT");
    expect((await listShopping(householdId)).open.filter((i) => i.name.toLowerCase().startsWith("egg"))).toHaveLength(1);
  });

  it("two people adding the same item at the same moment still make one row", async () => {
    const results = await Promise.all(Array.from({ length: 6 }, () => addItem(shopper(), { name: "Bananas" })));
    expect(results.filter((r) => r.created)).toHaveLength(1);
    const rows = (await listShopping(householdId)).open.filter((i) => i.name === "Bananas");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.reportCount).toBe(6);
  });

  it("an IP's low-supply report adds the item and tells the client and administrator, once", async () => {
    const before = (await outboundTo(clientPhone)).length;
    const first = await reportLowSupply(shopper("IP"), { item: "Dish soap", level: "LOW", location: "Under the sink", note: "About a quarter left" });
    expect(first.created).toBe(true);
    expect(first.item).toMatchObject({ status: "LOW", source: "IP_REPORT", storageLocation: "Under the sink" });
    await wait(500);
    expect((await outboundTo(clientPhone)).length).toBe(before + 1);
    expect((await outboundTo(emails.admin)).some((m) => m.body.includes("Dish soap") && m.body.includes("running low"))).toBe(true);

    await reportLowSupply(shopper("IP"), { item: "dish soap", level: "LOW" }); // same report again: merged, no second alert
    await wait(500);
    expect((await outboundTo(clientPhone)).length).toBe(before + 1);

    const worse = await reportLowSupply(shopper("IP"), { item: "Dish soap", level: "OUT" });
    expect(worse.worsened).toBe(true);
    await wait(500);
    expect((await outboundTo(clientPhone)).length).toBe(before + 2);
    expect((await listShopping(householdId)).open.filter((i) => i.name === "Dish soap")).toHaveLength(1);
  });

  it("only the IP on an open shift can report, and the IP cannot edit the list", async () => {
    await expect(reportLowSupply({ userId: ids.ip2, role: "IP", householdId }, { item: "Sponges", level: "LOW" })).rejects.toMatchObject({ code: "SHIFT_NOT_OPEN" });
    await expect(reportLowSupply(shopper(), { item: "Sponges", level: "LOW" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(addItem(shopper("IP"), { name: "Candy" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(addItem(shopper(), { name: "   " })).rejects.toMatchObject({ code: "INVALID_NAME" });
  });

  it("lists out-of-stock first, then low, then needed", async () => {
    const order = (await listShopping(householdId)).open.map((i) => i.status);
    const severity = (s: string) => ({ OUT: 3, LOW: 2, NEEDED: 1 })[s]!;
    expect(order.map(severity)).toEqual([...order.map(severity)].sort((a, b) => b - a));
  });

  it("details can be changed on an open item, but not on one already closed", async () => {
    const { item } = await addItem(shopper(), { name: "Coffee" });
    const edited = await updateItem(shopper("ADMIN"), item.id, { quantity: "1 large bag", storageLocation: "Pantry, top shelf", status: "LOW" });
    expect(edited).toMatchObject({ quantity: "1 large bag", storageLocation: "Pantry, top shelf", status: "LOW" });
    await closeItem(shopper(), item.id, "PURCHASED");
    await expect(updateItem(shopper(), item.id, { quantity: "2" })).rejects.toMatchObject({ code: "ALREADY_CLOSED" });
  });

  it("'bought' is recorded once with who and when, stays as history, and a new need starts a new row", async () => {
    const { item } = await addItem(shopper(), { name: "Rice" });
    const results = await Promise.allSettled([closeItem(shopper(), item.id, "PURCHASED"), closeItem(shopper("ADMIN"), item.id, "PURCHASED")]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason).toMatchObject({ code: "ALREADY_CLOSED" });

    const list = await listShopping(householdId);
    expect(list.open.some((i) => i.name === "Rice")).toBe(false);
    expect(list.recent.find((i) => i.name === "Rice")).toMatchObject({ status: "PURCHASED", closedBy: expect.any(String) });

    const again = await addItem(shopper(), { name: "rice" });
    expect(again.created).toBe(true);
    expect(again.item.id).not.toBe(item.id);
  });

  it("an item no longer needed can be dismissed without deleting it", async () => {
    const { item } = await addItem(shopper(), { name: "Cookies" });
    await closeItem(shopper(), item.id, "DISMISSED");
    expect((await listShopping(householdId)).recent.find((i) => i.id === item.id)?.status).toBe("DISMISSED");
    expect(await db.shoppingItem.findUnique({ where: { id: item.id } })).not.toBeNull();
  });

  it("is separate for each household", async () => {
    const { item } = await addItem(shopper(), { name: "Secret item" });
    const outsider = { userId: ids.other, role: "CLIENT" as const, householdId: otherHouseholdId };
    await expect(updateItem(outsider, item.id, { quantity: "9" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(closeItem(outsider, item.id, "PURCHASED")).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await listShopping(otherHouseholdId)).open).toEqual([]);
  });
});

describe("a forgotten checkout from an earlier day", () => {
  it("stays on record as missing, but does not lock the IP out of checking in today", async () => {
    const household = await db.household.findUniqueOrThrow({ where: { id: householdId } });
    const now = new Date();
    const yesterday = new Date(now.getTime() - 26 * 3_600_000);
    // Yesterday: checked in, the server closed the authorized window, nobody checked out.
    const old = await db.scheduledShift.create({
      data: {
        householdId, ipUserId: ids.ip2, localDate: localDateString(yesterday, household.timezone),
        scheduledStartUtc: yesterday, scheduledEndUtc: new Date(yesterday.getTime() + 6 * 3_600_000), status: "SCHEDULED", createdBy: ids.ip2,
        checkInEventId: "earlier-check-in", observedCheckInUtc: yesterday,
        authorizedEndUtc: new Date(yesterday.getTime() + 6 * 3_600_000), authorizationClosedAt: new Date(yesterday.getTime() + 6 * 3_600_000),
      },
    });
    const today = await db.scheduledShift.create({
      data: {
        householdId, ipUserId: ids.ip2, localDate: localDateString(now, household.timezone),
        scheduledStartUtc: new Date(now.getTime() - 5 * 60_000), scheduledEndUtc: new Date(now.getTime() + 6 * 3_600_000), status: "SCHEDULED", createdBy: ids.ip2,
      },
    });

    const result = await checkIn({ shiftId: today.id, ipUserId: ids.ip2, ...here });
    expect(result.checkInEventId).not.toBeNull();
    const stillMissing = await db.scheduledShift.findUniqueOrThrow({ where: { id: old.id } });
    expect(stillMissing.checkOutEventId).toBeNull(); // not papered over
  });

  it("but a shift whose window is still open does block a second check-in", async () => {
    const household = await db.household.findUniqueOrThrow({ where: { id: householdId } });
    const now = new Date();
    const later = await db.scheduledShift.create({
      data: {
        householdId, ipUserId: ids.ip, localDate: localDateString(new Date(now.getTime() + 86_400_000), household.timezone),
        scheduledStartUtc: new Date(now.getTime() - 60_000), scheduledEndUtc: new Date(now.getTime() + 3_600_000), status: "SCHEDULED", createdBy: ids.ip,
      },
    });
    // ids.ip is still checked in on the shift from the top of this file.
    await expect(checkIn({ shiftId: later.id, ipUserId: ids.ip, ...here })).rejects.toBeDefined();
  });
});

describe("after the authorized shift ends", () => {
  it("no new food requests, no recording a disposal, no low-supply reports", async () => {
    const approved = await foodRequest({ item: "Late item", replacement: undefined });
    await approveRequest(client(), approved.id);
    await db.scheduledShift.update({ where: { id: ids.shift }, data: { authorizationClosedAt: new Date() } });

    await expect(issueFoodChallenge(ipA())).rejects.toMatchObject({ code: "SHIFT_NOT_OPEN" });
    await expect(recordDisposal(ipA(), approved.id)).rejects.toMatchObject({ code: "SHIFT_NOT_OPEN" });
    await expect(reportHazard(ipA(), { item: "x", location: "y", reason: "z", actionTaken: "w" })).rejects.toMatchObject({ code: "SHIFT_NOT_OPEN" });
    await expect(reportLowSupply(shopper("IP"), { item: "Salt", level: "LOW" })).rejects.toMatchObject({ code: "SHIFT_NOT_OPEN" });
  });

  it("the audit log is intact and holds the whole story", async () => {
    const actions = new Set((await db.event.findMany({ where: { householdId }, select: { action: true } })).map((e) => e.action));
    for (const a of ["food_disposal_requested", "food_disposal_approved", "food_disposal_declined", "food_disposed", "food_hazard_reported", "food_hazard_acknowledged", "food_request_escalated", "low_supply_reported", "shopping_item_added", "shopping_item_merged", "shopping_item_purchased", "shopping_item_dismissed", "password_reset_completed"]) {
      expect(actions.has(a), a).toBe(true);
    }
    expect(await verifyChainIntegrity(householdId)).toEqual({ ok: true });
  });
});
