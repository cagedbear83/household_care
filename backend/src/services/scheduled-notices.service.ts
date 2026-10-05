import { DateTime } from "luxon";
import { db } from "../db";
import { sendMessage } from "./notify.service";
import { notifyRolesNow } from "./household-notify.service";
import { addLocalDays, localDateString, localToUtc, workweekStartLocalDate } from "./time.service";

/**
 * Two notices that go out on a schedule, each at most once:
 *
 * 1. The IP's weekly hours, the morning after the workweek ends (Sunday to Saturday), for their own records.
 *    Totals only: no client name, no tasks, no clock times, nothing about the household. It says plainly that it
 *    is not the official time sheet and not the state's EVV.
 * 2. A pay-period reminder to the client (and the primary family member, who gets whatever the client gets) on the
 *    15th and the last day of the month, to review the hours before signing the time sheet. The program says
 *    time sheets are never to be pre-signed and must be reviewed before they are submitted.
 */

const SEND_FROM_HOUR = 7; // weekly hours: from 7 a.m. local on the first day of the new week
const CATCH_UP_DAYS = 3; // if the server was down, still send within three days
const REMINDER_HOUR = 18; // pay-period reminder: from 6 p.m. local

const hm = (minutes: number) => {
  const total = Math.max(0, Math.round(minutes));
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${h} h ${String(m).padStart(2, "0")} min`;
};

const fmtDay = (localDate: string) => DateTime.fromISO(localDate).toFormat("ccc LLL d");
const fmtLong = (localDate: string) => DateTime.fromISO(localDate).toFormat("cccc LLL d");

interface HouseholdRow {
  id: string;
  timezone: string;
  workweekStartWeekday: number;
  weeklyHourCapMinutes: number;
}

const households = (only?: { householdId: string }): Promise<HouseholdRow[]> =>
  db.household.findMany({
    where: only ? { id: only.householdId } : {},
    select: { id: true, timezone: true, workweekStartWeekday: true, weeklyHourCapMinutes: true },
  });

// ---------------------------------------------------------------------------------
// 1. The IP's weekly hours

/** Sends each IP their hours for the workweek that just ended. Returns how many were sent. */
export async function sendWeeklyHoursNotices(now: Date = new Date(), only?: { householdId: string }): Promise<number> {
  let sent = 0;
  for (const h of await households(only)) {
    const thisWeek = workweekStartLocalDate(now, h.timezone, h.workweekStartWeekday);
    const opens = localToUtc(thisWeek, `${String(SEND_FROM_HOUR).padStart(2, "0")}:00`, h.timezone);
    const closes = DateTime.fromJSDate(opens).plus({ days: CATCH_UP_DAYS }).toJSDate();
    if (now < opens || now >= closes) continue;

    const weekStart = addLocalDays(thisWeek, -7);
    const weekEnd = addLocalDays(thisWeek, -1);
    const ips = await db.user.findMany({ where: { householdId: h.id, role: "IP", active: true }, select: { id: true, email: true, phone: true } });

    for (const ip of ips) {
      const shifts = await db.scheduledShift.findMany({
        where: { householdId: h.id, ipUserId: ip.id, status: "SCHEDULED", supersededAt: null, localDate: { gte: weekStart, lte: weekEnd }, observedCheckInUtc: { not: null } },
        orderBy: { scheduledStartUtc: "asc" },
      });
      if (shifts.length === 0) continue;

      // Each notice goes out once: claim it first, and give the claim back if the message could not be sent.
      const claim = await db.weeklyHoursNotice.createMany({ data: [{ ipUserId: ip.id, weekStartLocalDate: weekStart }], skipDuplicates: true });
      if (claim.count === 0) continue;

      const lines: string[] = [];
      let recorded = 0;
      let counted = 0;
      let missingCheckout = 0;
      for (const s of shifts) {
        const checkIn = s.observedCheckInUtc!;
        const stop = s.observedCheckOutUtc ?? s.authorizationClosedAt ?? now;
        const authorizedEnd = s.authorizedEndUtc ?? s.scheduledEndUtc;
        const observed = s.observedCheckOutUtc ? Math.max(0, (s.observedCheckOutUtc.getTime() - checkIn.getTime()) / 60_000) : null;
        const countedHere = Math.max(0, ((stop < authorizedEnd ? stop : authorizedEnd).getTime() - checkIn.getTime()) / 60_000);
        counted += countedHere;
        if (observed !== null) recorded += observed;
        else missingCheckout++;
        lines.push(`${fmtDay(s.localDate)}: ${observed !== null ? hm(observed) : "no checkout recorded"}`);
      }

      const body = [
        `Your hours for ${fmtLong(weekStart)} to ${fmtLong(weekEnd)}`,
        "",
        ...lines,
        "",
        `Time recorded in the app: ${hm(recorded)}`,
        `Counted toward your weekly limit: ${hm(counted)} (the limit is ${hm(h.weeklyHourCapMinutes)})`,
        ...(missingCheckout > 0 ? ["", `${missingCheckout} visit${missingCheckout === 1 ? " has" : "s have"} no checkout recorded. If that is a mistake, use "Report a problem" in the app.`] : []),
        "",
        "This is a copy for your own records. It is not the official time sheet and does not replace the state's EVV. Check it against your time sheet before it is signed.",
      ].join("\n");

      const result = ip.email
        ? await sendMessage({ householdId: h.id, channel: "EMAIL", to: ip.email, subject: `Your hours, ${fmtDay(weekStart)} to ${fmtDay(weekEnd)}`, body, kind: "weekly_hours" })
        : ip.phone
          ? await sendMessage({ householdId: h.id, channel: "SMS", to: ip.phone, body: `Household Care: your hours for ${fmtDay(weekStart)} to ${fmtDay(weekEnd)}: ${hm(recorded)} recorded, ${hm(counted)} counted toward your weekly limit. Not the official time sheet.`, kind: "weekly_hours" })
          : null;

      if (result?.delivered) sent++;
      else await db.weeklyHoursNotice.deleteMany({ where: { ipUserId: ip.id, weekStartLocalDate: weekStart } });
    }
  }
  return sent;
}

// ---------------------------------------------------------------------------------
// 2. The pay-period reminder

/** The pay period (the 1st to the 15th, or the 16th to the last day) that ends on this local date, if it is one. */
export function payPeriodEndingOn(localDate: string): { from: string; to: string } | null {
  const d = DateTime.fromISO(localDate);
  if (d.day === 15) return { from: d.set({ day: 1 }).toISODate()!, to: localDate };
  if (d.day === d.daysInMonth) return { from: d.set({ day: 16 }).toISODate()!, to: localDate };
  return null;
}

/** Reminds the client (and the primary family member) to review the hours before signing. Returns how many households were reminded. */
export async function sendPayPeriodReminders(now: Date = new Date(), only?: { householdId: string }): Promise<number> {
  let sent = 0;
  for (const h of await households(only)) {
    const today = localDateString(now, h.timezone);
    const period = payPeriodEndingOn(today);
    if (!period) continue;
    if (now < localToUtc(today, `${String(REMINDER_HOUR).padStart(2, "0")}:00`, h.timezone)) continue;

    const worked = await db.scheduledShift.count({
      where: { householdId: h.id, status: "SCHEDULED", supersededAt: null, localDate: { gte: period.from, lte: period.to }, observedCheckInUtc: { not: null } },
    });
    if (worked === 0) continue;

    const claim = await db.payPeriodReminder.createMany({ data: [{ householdId: h.id, localDate: period.to }], skipDuplicates: true });
    if (claim.count === 0) continue;

    const result = await notifyRolesNow(
      h.id,
      ["CLIENT"],
      "Pay period ends today",
      `The pay period ${fmtDay(period.from)} to ${fmtDay(period.to)} ends today. Review the hours in Reports before signing the time sheet. Never sign ahead of time.`
    );
    if (result.sent > 0) sent++;
    else await db.payPeriodReminder.deleteMany({ where: { householdId: h.id, localDate: period.to } });
  }
  return sent;
}
