import { DateTime } from "luxon";

/**
 * All household-facing dates/times are expressed in the household's configured
 * timezone (default America/Chicago) and converted to UTC instants for storage
 * and comparison. Luxon handles DST transitions (spring-forward gaps, fall-back
 * duplicates) instead of hand-rolled offset math.
 */

export function nowUtc(): Date {
  return new Date();
}

export function localDateString(instantUtc: Date, timezone: string): string {
  return DateTime.fromJSDate(instantUtc, { zone: "utc" }).setZone(timezone).toFormat("yyyy-MM-dd");
}

/** Converts a household-local wall-clock date+time to a UTC Date. Throws if the
 * wall-clock time does not exist (spring-forward gap) rather than silently
 * shifting it. */
export function localToUtc(localDate: string, localTime: string, timezone: string): Date {
  const dt = DateTime.fromFormat(`${localDate} ${localTime}`, "yyyy-MM-dd HH:mm", { zone: timezone });
  if (!dt.isValid) {
    throw new Error(`Invalid local date/time for ${timezone}: ${dt.invalidExplanation}`);
  }
  // Luxon silently moves a nonexistent time (e.g. 02:30 on spring-forward day)
  // to the next valid one, so confirm the wall-clock time round-trips unchanged.
  if (dt.toFormat("HH:mm") !== localTime) {
    throw new Error(`${localTime} on ${localDate} does not exist in ${timezone} (daylight saving gap).`);
  }
  return dt.toJSDate();
}

/** Returns the YYYY-MM-DD local date of the configured workweek start (e.g. the
 * most recent Monday 00:00) that contains the given instant. */
export function workweekStartLocalDate(instantUtc: Date, timezone: string, workweekStartWeekday: number): string {
  let dt = DateTime.fromJSDate(instantUtc, { zone: "utc" }).setZone(timezone).startOf("day");
  // Luxon weekday: 1=Monday .. 7=Sunday. Our stored config uses 0=Sunday..6=Saturday
  // to match JS Date.getDay() conventions used elsewhere in the spec's examples.
  const targetLuxonWeekday = workweekStartWeekday === 0 ? 7 : workweekStartWeekday;
  while (dt.weekday !== targetLuxonWeekday) {
    dt = dt.minus({ days: 1 });
  }
  return dt.toFormat("yyyy-MM-dd");
}

/** Adds calendar days to a YYYY-MM-DD local date (DST-safe: calendar math, not 24h blocks). */
export function addLocalDays(localDate: string, days: number): string {
  return DateTime.fromFormat(localDate, "yyyy-MM-dd", { zone: "utc" }).plus({ days }).toFormat("yyyy-MM-dd");
}

/** 0=Sunday .. 6=Saturday for a YYYY-MM-DD local date. */
export function localWeekday(localDate: string): number {
  return DateTime.fromFormat(localDate, "yyyy-MM-dd", { zone: "utc" }).weekday % 7;
}

export function isValidLocalDate(value: string): boolean {
  return DateTime.fromFormat(value, "yyyy-MM-dd", { zone: "utc" }).isValid;
}

export function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60_000);
}

export function diffMinutes(laterUtc: Date, earlierUtc: Date): number {
  return (laterUtc.getTime() - earlierUtc.getTime()) / 60_000;
}
