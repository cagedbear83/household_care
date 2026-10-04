// All schedule dates are household-local "YYYY-MM-DD" strings. Calendar math
// is done in UTC at noon so it never depends on the phone's own timezone.

const toDate = (d: string) => new Date(`${d}T12:00:00Z`);
const fromDate = (date: Date) => date.toISOString().slice(0, 10);

export function addDays(localDate: string, days: number): string {
  const date = toDate(localDate);
  date.setUTCDate(date.getUTCDate() + days);
  return fromDate(date);
}

/** 0 = Sunday .. 6 = Saturday */
export function weekdayOf(localDate: string): number {
  return toDate(localDate).getUTCDay();
}

export function todayIn(timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(
    new Date()
  );
}

/** First day of the workweek containing `localDate`, given the household's configured start weekday. */
export function weekStartFor(localDate: string, startWeekday: number): string {
  const back = (weekdayOf(localDate) - startWeekday + 7) % 7;
  return addDays(localDate, -back);
}

/** The household-local calendar date ("YYYY-MM-DD") of an instant. */
export function localDateOf(iso: string, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
}

export function formatTime(iso: string, timezone: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "numeric", minute: "2-digit" }).format(new Date(iso));
}

/** "Fri, Oct 2, 4:12 PM" in the given timezone. */
export function formatDateTime(iso: string, timezone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));
}

/** "HH:mm" (24-hour) wall-clock time of an instant in the given timezone. */
export function localTimeOf(iso: string, timezone: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(
    new Date(iso)
  );
}

const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export const weekdayName = (weekday: number) => WEEKDAY_NAMES[weekday] ?? "";

export function formatDay(localDate: string): string {
  const date = toDate(localDate);
  return `${WEEKDAY_NAMES[date.getUTCDay()]}, ${MONTH_NAMES[date.getUTCMonth()]} ${date.getUTCDate()}`;
}

export function formatRange(from: string, to: string): string {
  const a = toDate(from);
  const b = toDate(to);
  return `${MONTH_NAMES[a.getUTCMonth()]} ${a.getUTCDate()} – ${MONTH_NAMES[b.getUTCMonth()]} ${b.getUTCDate()}, ${b.getUTCFullYear()}`;
}

export function formatHours(minutes: number): string {
  const hours = minutes / 60;
  return Number.isInteger(hours) ? `${hours}` : hours.toFixed(1);
}

/** "09:00" + 6 hours -> "15:00" (null if it would pass midnight). */
export function addHoursToTime(time: string, hours: number): string | null {
  const [h, m] = time.split(":").map(Number);
  if (h === undefined || m === undefined || Number.isNaN(h) || Number.isNaN(m)) return null;
  const total = h * 60 + m + hours * 60;
  if (total >= 24 * 60) return null;
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

export const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
