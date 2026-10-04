import type { Report, TaskCounts } from "./api";
import { addDays, formatDay, formatRange, formatTime, weekStartFor } from "./dates";

export type RangeKind = "day" | "week" | "month" | "custom";

export const RANGE_LABEL: Record<RangeKind, string> = { day: "Day", week: "Week", month: "Month", custom: "Custom dates" };

export const isDate = (s: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T12:00:00Z`)) && new Date(`${s}T12:00:00Z`).toISOString().slice(0, 10) === s;

const monthBounds = (anchor: string) => {
  const [y, m] = anchor.split("-").map(Number) as [number, number];
  const first = `${y}-${String(m).padStart(2, "0")}-01`;
  const next = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
  return { first, last: addDays(next, -1) };
};

/** The dates a day / week / month report covers around a chosen date. Weeks follow the household's workweek. */
export function rangeFor(kind: Exclude<RangeKind, "custom">, anchor: string, weekStartWeekday: number): { from: string; to: string } {
  if (kind === "day") return { from: anchor, to: anchor };
  if (kind === "week") {
    const from = weekStartFor(anchor, weekStartWeekday);
    return { from, to: addDays(from, 6) };
  }
  const { first, last } = monthBounds(anchor);
  return { from: first, to: last };
}

/** The date to anchor on after pressing Previous or Next. */
export function stepAnchor(kind: Exclude<RangeKind, "custom">, anchor: string, direction: -1 | 1): string {
  if (kind === "day") return addDays(anchor, direction);
  if (kind === "week") return addDays(anchor, direction * 7);
  const { first, last } = monthBounds(anchor);
  return direction < 0 ? addDays(first, -1) : addDays(last, 1);
}

export function minutesLabel(minutes: number): string {
  const total = Math.max(0, Math.round(minutes));
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

export const pctLabel = (p: number | null) => (p === null ? "No tasks assigned" : `${p}%`);

export const rangeLabel = (from: string, to: string) => (from === to ? formatDay(from) : formatRange(from, to));

export const VISIT_STATUS: Record<string, string> = {
  attended: "Attended",
  in_progress: "In progress",
  missed: "No check-in",
  no_checkout: "No checkout recorded",
  upcoming: "Still to come",
};

export const TASK_ROWS: [string, keyof TaskCounts][] = [
  ["Assigned tasks", "assigned"],
  ["Submitted as done", "submitted"],
  ["Approved by the client", "approved"],
  ["Waiting for the client's review", "awaitingReview"],
  ["Disputed (these are included in submitted)", "disputed"],
  ["Decline waiting for the client", "declineAwaitingConfirmation"],
  ["Declined, confirmed by the client", "confirmedDeclined"],
  ["Marked not needed", "notNeeded"],
  ["Marked unable to complete", "unableToComplete"],
  ["Not done by the end of the visit", "missed"],
  ["Not done yet, visit still to come or under way", "stillOpen"],
  ["Recorded in error and corrected (not counted as done)", "correctedErrors"],
];

export const PERCENT_ROWS: { key: keyof Report["tasks"]["percentages"]; label: string; how: string }[] = [
  { key: "completion", label: "Completion", how: "Submitted as done divided by all assigned tasks. Disputed ones are counted and shown separately." },
  { key: "approved", label: "Approved completion", how: "Approved by the client divided by all assigned tasks." },
  { key: "coverage", label: "Coverage", how: "Tasks with any recorded outcome divided by all assigned tasks." },
  { key: "resolution", label: "Resolution", how: "Tasks with a final outcome (approved, confirmed declined, not needed, unable with a reason) divided by all assigned tasks." },
];

/** "9:04 AM" of an instant in the household timezone. */
export const clock = (iso: string | null, tz: string) => (iso ? formatTime(iso, tz) : "—");
