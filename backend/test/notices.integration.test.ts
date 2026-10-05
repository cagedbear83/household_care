import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DateTime } from "luxon";
import { db } from "../src/db";
import { hashPassword } from "../src/auth/password";
import { payPeriodEndingOn, sendPayPeriodReminders, sendWeeklyHoursNotices } from "../src/services/scheduled-notices.service";
import * as notify from "../src/services/notify.service";

const TZ = "America/Chicago";
let householdId: string;
let ids: { client: string; ip: string; ipPhoneOnly: string; primary: string; other: string };
const only = () => ({ householdId });
const at = (iso: string) => DateTime.fromISO(iso, { zone: TZ }).toJSDate();
const sendOk = () => vi.spyOn(notify, "sendMessage").mockResolvedValue({ delivered: true, provider: "test" });

async function visit(ipUserId: string, date: string, inTime: string, outTime: string | null, extra: object = {}) {
  const start = at(`${date}T${inTime}`);
  return db.scheduledShift.create({
    data: {
      householdId, ipUserId, localDate: date, scheduledStartUtc: start, scheduledEndUtc: at(`${date}T${outTime ?? "17:00"}`), authorizedEndUtc: at(`${date}T${outTime ?? "17:00"}`),
      status: "SCHEDULED", createdBy: ipUserId, observedCheckInUtc: start, observedCheckOutUtc: outTime ? at(`${date}T${outTime}`) : null, ...extra,
    },
  });
}

beforeAll(async () => {
  const passwordHash = await hashPassword("test-only-password");
  const h = await db.household.create({ data: { name: "notices-test-household", apartmentLat: 0, apartmentLng: 0 } });
  householdId = h.id;
  const mk = (role: "CLIENT" | "IP" | "FAMILY", name: string, extra: object = {}) =>
    db.user.create({ data: { householdId, role, name, email: `${name.toLowerCase()}-${h.id}@test.local`, passwordHash, ...extra } });
  const [client, ip, ipPhone, primary, other] = await Promise.all([
    mk("CLIENT", "Chris"),
    mk("IP", "Pat"),
    mk("IP", "Quinn", { email: null, phone: `+1312555${String(Math.floor(1000 + Math.random() * 9000))}` }),
    mk("FAMILY", "Ann", { isPrimaryFamily: true, activatedAt: new Date() }),
    mk("FAMILY", "Ben", { activatedAt: new Date() }),
  ]);
  ids = { client: client.id, ip: ip.id, ipPhoneOnly: ipPhone.id, primary: primary.id, other: other.id };

  // The workweek Sunday 2027-03-07 to Saturday 2027-03-13.
  await visit(ids.ip, "2027-03-08", "09:00", "15:00"); // Monday, 6 h
  await visit(ids.ip, "2027-03-10", "09:00", "14:30"); // Wednesday, 5 h 30 min
  await visit(ids.ip, "2027-03-12", "09:00", null, { authorizationClosedAt: at("2027-03-12T17:00"), authorizationClosedReason: "SCHEDULED_END" }); // Friday, forgot to check out
  await visit(ids.ipPhoneOnly, "2027-03-09", "10:00", "13:00"); // Tuesday, 3 h
});

afterEach(() => vi.restoreAllMocks());

afterAll(async () => {
  await db.weeklyHoursNotice.deleteMany({ where: { ipUserId: { in: Object.values(ids) } } });
  await db.payPeriodReminder.deleteMany({ where: { householdId } });
  await db.outboundMessage.deleteMany({ where: { householdId } });
  await db.scheduledShift.deleteMany({ where: { householdId } });
  await db.user.deleteMany({ where: { householdId } });
  await db.household.delete({ where: { id: householdId } });
  await db.$disconnect();
});

describe("the IP's weekly hours", () => {
  it("is not sent before the workweek is over, or before 7 a.m. the next day", async () => {
    const sent = sendOk();
    expect(await sendWeeklyHoursNotices(at("2027-03-13T22:00"), only())).toBe(0); // still Saturday
    expect(await sendWeeklyHoursNotices(at("2027-03-14T06:30"), only())).toBe(0); // Sunday, too early
    expect(sent).not.toHaveBeenCalled();
  });

  it("goes to each IP once the morning after, with totals only", async () => {
    const sent = sendOk();
    expect(await sendWeeklyHoursNotices(at("2027-03-14T07:30"), only())).toBe(2);
    const toPat = sent.mock.calls.map(([m]) => m).find((m) => m.to === `pat-${householdId}@test.local`)!;
    expect(toPat.channel).toBe("EMAIL");
    expect(toPat.kind).toBe("weekly_hours");
    expect(toPat.subject).toBe("Your hours, Sun Mar 7 to Sat Mar 13");
    expect(toPat.body).toContain("Mon Mar 8: 6 h 00 min");
    expect(toPat.body).toContain("Wed Mar 10: 5 h 30 min");
    expect(toPat.body).toContain("Fri Mar 12: no checkout recorded");
    expect(toPat.body).toContain("Time recorded in the app: 11 h 30 min");
    expect(toPat.body).toContain("Counted toward your weekly limit: 19 h 30 min (the limit is 36 h 00 min)"); // Friday counts to the authorized end
    expect(toPat.body).toContain("1 visit has no checkout recorded");
    expect(toPat.body).toMatch(/not the official time sheet and does not replace the state's EVV/);
  });

  it("keeps the client and the household out of it, and shows no clock times", async () => {
    await db.weeklyHoursNotice.deleteMany({ where: { ipUserId: ids.ip } });
    const sent = sendOk();
    await sendWeeklyHoursNotices(at("2027-03-14T08:00"), only());
    const text = sent.mock.calls.map(([m]) => `${m.subject ?? ""} ${m.body}`).join(" ");
    expect(text).not.toMatch(/Chris|notices-test-household|Ann|Ben/);
    expect(text).not.toMatch(/\d{1,2}:\d{2}\s?(AM|PM)?/i);
  });

  it("is sent only once, even when the job runs again", async () => {
    const sent = sendOk();
    expect(await sendWeeklyHoursNotices(at("2027-03-14T09:00"), only())).toBe(0);
    expect(sent).not.toHaveBeenCalled();
    expect(await db.weeklyHoursNotice.count({ where: { ipUserId: { in: [ids.ip, ids.ipPhoneOnly] } } })).toBe(2);
  });

  it("uses a short text for an IP with no email address, and nothing for an IP who did not work", async () => {
    await db.weeklyHoursNotice.deleteMany({ where: { ipUserId: ids.ipPhoneOnly } });
    const sent = sendOk();
    await sendWeeklyHoursNotices(at("2027-03-14T10:00"), only());
    const text = sent.mock.calls.map(([m]) => m).find((m) => m.channel === "SMS")!;
    expect(text.body).toMatch(/^Household Care: your hours for Sun Mar 7 to Sat Mar 13: 3 h 00 min recorded, 3 h 00 min counted/);
    expect(text.body.length).toBeLessThan(200);
    // A week nobody worked sends nothing.
    sent.mockClear();
    expect(await sendWeeklyHoursNotices(at("2027-03-21T07:30"), only())).toBe(0);
    expect(sent).not.toHaveBeenCalled();
  });

  it("tries again later when the message could not be sent, and gives up after three days", async () => {
    await db.weeklyHoursNotice.deleteMany({ where: { ipUserId: { in: [ids.ip, ids.ipPhoneOnly] } } });
    const failing = vi.spyOn(notify, "sendMessage").mockResolvedValue({ delivered: false, provider: "test" });
    expect(await sendWeeklyHoursNotices(at("2027-03-14T07:30"), only())).toBe(0);
    expect(await db.weeklyHoursNotice.count({ where: { ipUserId: { in: [ids.ip, ids.ipPhoneOnly] } } })).toBe(0); // the claim was given back
    failing.mockResolvedValue({ delivered: true, provider: "test" });
    expect(await sendWeeklyHoursNotices(at("2027-03-15T07:30"), only())).toBe(2); // the next day it goes out
    await db.weeklyHoursNotice.deleteMany({ where: { ipUserId: { in: [ids.ip, ids.ipPhoneOnly] } } });
    expect(await sendWeeklyHoursNotices(at("2027-03-17T07:30"), only())).toBe(0); // three days on: too late to send
  });
});

describe("the pay-period reminder", () => {
  it("knows which days end a pay period", () => {
    expect(payPeriodEndingOn("2027-03-15")).toEqual({ from: "2027-03-01", to: "2027-03-15" });
    expect(payPeriodEndingOn("2027-03-31")).toEqual({ from: "2027-03-16", to: "2027-03-31" });
    expect(payPeriodEndingOn("2027-02-28")).toEqual({ from: "2027-02-16", to: "2027-02-28" }); // a short month
    expect(payPeriodEndingOn("2028-02-29")).toEqual({ from: "2028-02-16", to: "2028-02-29" }); // a leap year
    expect(payPeriodEndingOn("2027-03-14")).toBeNull();
    expect(payPeriodEndingOn("2027-03-16")).toBeNull();
  });

  it("is not sent on other days or before 6 p.m.", async () => {
    const sent = sendOk();
    expect(await sendPayPeriodReminders(at("2027-03-14T19:00"), only())).toBe(0);
    expect(await sendPayPeriodReminders(at("2027-03-15T17:59"), only())).toBe(0);
    expect(sent).not.toHaveBeenCalled();
  });

  it("goes to the client and the primary family member only, once, with no details", async () => {
    const sent = sendOk();
    expect(await sendPayPeriodReminders(at("2027-03-15T18:30"), only())).toBe(1);
    const to = sent.mock.calls.map(([m]) => m.to).sort();
    expect(to).toEqual([`ann-${householdId}@test.local`, `chris-${householdId}@test.local`].sort());
    const body = sent.mock.calls[0]![0].body;
    expect(body).toMatch(/pay period Mon Mar 1 to Mon Mar 15 ends today/i);
    expect(body).toMatch(/before signing the time sheet/);
    expect(body).toMatch(/Never sign ahead of time/);
    expect(body).not.toMatch(/Pat|Quinn|hours? \d|\d h/);

    sent.mockClear();
    expect(await sendPayPeriodReminders(at("2027-03-15T21:00"), only())).toBe(0); // already sent
    expect(sent).not.toHaveBeenCalled();
  });

  it("is skipped for a pay period nobody worked in, and tried again if it could not be sent", async () => {
    const sent = sendOk();
    expect(await sendPayPeriodReminders(at("2027-03-31T18:30"), only())).toBe(0); // no visits Mar 16 to 31
    expect(sent).not.toHaveBeenCalled();

    await visit(ids.ip, "2027-04-02", "09:00", "12:00");
    await visit(ids.ip, "2027-04-20", "09:00", "12:00");
    sent.mockResolvedValue({ delivered: false, provider: "test" });
    expect(await sendPayPeriodReminders(at("2027-04-30T18:30"), only())).toBe(0);
    expect(await db.payPeriodReminder.count({ where: { householdId, localDate: "2027-04-30" } })).toBe(0);
    sent.mockResolvedValue({ delivered: true, provider: "test" });
    expect(await sendPayPeriodReminders(at("2027-04-30T19:00"), only())).toBe(1);
  });
});
