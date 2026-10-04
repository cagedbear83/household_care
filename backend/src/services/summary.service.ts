import { DateTime } from "luxon";
import type { Role, TaskState } from "@prisma/client";
import { db } from "../db";
import { localDateString, workweekStartLocalDate } from "./time.service";
import { unreadTotal } from "./chat.service";

/**
 * Spoken summaries. The server writes the exact sentences so every device says
 * the same thing and the wording can be tested; the app only reads the text out
 * loud. Sentences are plain words (no symbols), short, and lead with what
 * matters. Family members never get audit times or photo counts unless the
 * client approved that for them.
 */

export interface SummaryViewer {
  userId: string;
  householdId: string;
  role: Role;
  canViewTimestamps: boolean;
}

export interface Summary {
  id: "briefing" | "decisions" | "completed" | "left" | "checkin" | "hours" | "shopping" | "alerts" | "messages";
  title: string;
  /** What is spoken. */
  text: string;
  /** True when there is nothing to report (the text then says so). */
  empty: boolean;
  /** When set, ask this yes/no question first and read `text` only on "yes". */
  askFirst?: string;
}

// ---------------------------------------------------------------------------------
// Wording helpers (pure, exported for tests)

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "A", "A and B", "A, B and C", "A, B, C and 2 more" (never reads a long list out in full). */
export function spokenList(items: string[], max = 6): string {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0]!;
  if (items.length <= max) return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
  const shown = items.slice(0, max);
  const rest = items.length - max;
  return `${shown.join(", ")} and ${rest} more`;
}

/** "9:04 AM", spoken as written. */
export const spokenTime = (instant: Date, timezone: string) => DateTime.fromJSDate(instant, { zone: timezone }).toFormat("h:mm a");

export function spokenDuration(minutes: number): string {
  const total = Math.max(0, Math.round(minutes));
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return plural(m, "minute");
  if (m === 0) return plural(h, "hour");
  return `${plural(h, "hour")} and ${plural(m, "minute")}`;
}

const seesTimes = (v: SummaryViewer) => v.role !== "FAMILY" || v.canViewTimestamps;
const isStaff = (v: SummaryViewer) => v.role === "CLIENT" || v.role === "ADMIN";

const DONE: TaskState[] = ["COMPLETED_AWAITING_REVIEW", "APPROVED", "CORRECTIVE_WORK_SUBMITTED"];
const OPEN: TaskState[] = ["NOT_STARTED", "IN_PROGRESS", "DISPUTED", "COMPLETION_ERROR_CORRECTED"];

// ---------------------------------------------------------------------------------

export async function buildSummaries(viewer: SummaryViewer, now: Date = new Date()): Promise<Summary[]> {
  const household = await db.household.findUniqueOrThrow({ where: { id: viewer.householdId } });
  const tz = household.timezone;
  const today = localDateString(now, tz);
  const staff = isStaff(viewer);
  const times = seesTimes(viewer);

  const shifts = await db.scheduledShift.findMany({
    where: { householdId: viewer.householdId, localDate: today, supersededAt: null, status: "SCHEDULED" },
    orderBy: { scheduledStartUtc: "asc" },
    include: { ip: { select: { name: true } }, taskInstances: { orderBy: [{ template: { sortOrder: "asc" } }, { createdAt: "asc" }, { id: "asc" }], select: { titleSnapshot: true, state: true, requiresPhotoSnapshot: true, evidence: { select: { id: true } } } } },
  });
  const tasks = shifts.flatMap((s) => s.taskInstances);

  const out: Summary[] = [];

  // --- Alerts and decisions (the people who act on them)
  let alertsSummary: Summary | null = null;
  let decisionsSummary: Summary | null = null;
  if (staff) {
    alertsSummary = await alertsText(viewer);
    decisionsSummary = await decisionsText(viewer);
  }

  // --- Completed today (asks first)
  const doneTasks = tasks.filter((t) => DONE.includes(t.state));
  const completed: Summary = (() => {
    if (doneTasks.length === 0) {
      return { id: "completed", title: "Done today", empty: true, text: shifts.length === 0 ? "No visit is scheduled today, so nothing has been done." : "Nothing has been marked done yet today." };
    }
    const waiting = doneTasks.filter((t) => t.state !== "APPROVED").length;
    const withPhotos = doneTasks.filter((t) => t.evidence.length > 0).length;
    const parts = [
      `${plural(doneTasks.length, "task")} ${doneTasks.length === 1 ? "has" : "have"} been completed today: ${spokenList(doneTasks.map((t) => t.titleSnapshot), 8)}.`,
    ];
    if (times && withPhotos > 0) parts.push(withPhotos === 1 ? "One has a photo." : `${withPhotos} have photos.`);
    if (staff && waiting > 0) parts.push(`${waiting} ${waiting === 1 ? "is" : "are"} waiting for approval.`);
    return {
      id: "completed",
      title: "Done today",
      empty: false,
      askFirst: `${plural(doneTasks.length, "task")} ${doneTasks.length === 1 ? "was" : "were"} completed today. Would you like me to read ${doneTasks.length === 1 ? "it" : "them"} out loud?`,
      text: parts.join(" "),
    };
  })();

  // --- Left to do today
  const left: Summary = (() => {
    if (shifts.length === 0) return { id: "left", title: "Left today", empty: true, text: "No visit is scheduled today." };
    const open = tasks.filter((t) => OPEN.includes(t.state));
    if (tasks.length === 0) return { id: "left", title: "Left today", empty: true, text: "The visit has not started, so today's task list is not ready yet." };
    if (open.length === 0) return { id: "left", title: "Left today", empty: true, text: "Everything on today's list has been taken care of." };
    const disputed = open.filter((t) => t.state === "DISPUTED").length;
    return {
      id: "left",
      title: "Left today",
      empty: false,
      text: `${plural(open.length, "task")} ${open.length === 1 ? "is" : "are"} still to do today: ${spokenList(open.map((t) => t.titleSnapshot), 8)}.${disputed > 0 ? ` ${disputed === 1 ? "One needs" : `${disputed} need`} to be redone.` : ""}`,
    };
  })();

  // --- Check-in
  const checkin: Summary = (() => {
    if (shifts.length === 0) return { id: "checkin", title: "Check-in", empty: true, text: "No visit is scheduled today." };
    const sentences = shifts.map((s) => {
      const startsAt = spokenTime(s.scheduledStartUtc, tz);
      if (!s.observedCheckInUtc) {
        return now < s.scheduledStartUtc
          ? `${s.ip.name} is scheduled to arrive at ${startsAt}.`
          : `${s.ip.name} has not checked in yet. The visit was scheduled for ${startsAt}.`;
      }
      const when = times ? ` at ${spokenTime(s.observedCheckInUtc, tz)}` : "";
      if (s.observedCheckOutUtc) {
        return `${s.ip.name} checked in${when} and has finished${times ? ` at ${spokenTime(s.observedCheckOutUtc, tz)}` : ""}.`;
      }
      return `${s.ip.name} checked in${when} and is here now.`;
    });
    return { id: "checkin", title: "Check-in", empty: false, text: sentences.join(" ") };
  })();

  // --- Hours this week (derived from attendance times, so only for those allowed to see times)
  let hours: Summary | null = null;
  if (times) {
    const weekStart = workweekStartLocalDate(now, tz, household.workweekStartWeekday);
    const allowances = await db.weekAllowance.findMany({ where: { householdId: viewer.householdId, weekStartLocalDate: weekStart } });
    const names = new Map((await db.user.findMany({ where: { id: { in: allowances.map((x) => x.ipUserId) } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
    const live = await db.scheduledShift.findMany({
      where: { householdId: viewer.householdId, observedCheckInUtc: { not: null }, observedCheckOutUtc: null, authorizationClosedAt: null },
      include: { ip: { select: { name: true } } },
    });
    const minutes = new Map<string, { name: string; minutes: number }>();
    for (const a of allowances) minutes.set(a.ipUserId, { name: names.get(a.ipUserId) ?? "The IP", minutes: a.consumedMinutes });
    for (const s of live) {
      const end = s.authorizedEndUtc && s.authorizedEndUtc < now ? s.authorizedEndUtc : now;
      const extra = Math.max(0, (end.getTime() - s.observedCheckInUtc!.getTime()) / 60_000);
      const entry = minutes.get(s.ipUserId) ?? { name: s.ip.name, minutes: 0 };
      minutes.set(s.ipUserId, { ...entry, minutes: entry.minutes + extra });
    }
    if (minutes.size === 0) {
      hours = { id: "hours", title: "Hours this week", empty: true, text: "No hours have been worked yet this week." };
    } else {
      const cap = household.weeklyHourCapMinutes;
      const lines = [...minutes.values()].map((m) => {
        const remaining = Math.max(0, cap - m.minutes);
        return remaining === 0
          ? `${m.name} has worked ${spokenDuration(m.minutes)} this week and has reached the limit of ${spokenDuration(cap)}.`
          : `${m.name} has worked ${spokenDuration(m.minutes)} this week. ${spokenDuration(remaining)} remain before the limit of ${spokenDuration(cap)}.`;
      });
      hours = { id: "hours", title: "Hours this week", empty: false, text: lines.join(" ") };
    }
  }

  // --- Shopping
  let shopping: Summary | null = null;
  if (staff) {
    const items = await db.shoppingItem.findMany({ where: { householdId: viewer.householdId, status: { in: ["NEEDED", "LOW", "OUT"] } } });
    const rank = { OUT: 0, LOW: 1, NEEDED: 2 } as const;
    items.sort((a, b) => rank[a.status as keyof typeof rank] - rank[b.status as keyof typeof rank] || a.createdAt.getTime() - b.createdAt.getTime() || a.name.localeCompare(b.name));
    if (items.length === 0) {
      shopping = { id: "shopping", title: "Shopping list", empty: true, text: "The shopping list is empty." };
    } else {
      const out = items.filter((i) => i.status === "OUT");
      const label = (i: (typeof items)[number]) => (i.quantity ? `${i.name}, ${i.quantity}` : i.name);
      shopping = {
        id: "shopping",
        title: "Shopping list",
        empty: false,
        text: `The shopping list has ${plural(items.length, "item")}.${out.length > 0 ? ` ${spokenList(out.map((i) => i.name), 4)} ${out.length === 1 ? "is" : "are"} all gone.` : ""} On the list: ${spokenList(items.map(label), 8)}.`,
      };
    }
  }

  // --- Messages
  const unreadMessages = await unreadTotal({ userId: viewer.userId, householdId: viewer.householdId });
  const messages: Summary = {
    id: "messages",
    title: "Messages",
    empty: unreadMessages === 0,
    text: unreadMessages === 0 ? "You have no unread messages." : `You have ${plural(unreadMessages, "unread message")}.`,
  };

  // Order: what is urgent first, then what needs a decision, then the day.
  if (alertsSummary) out.push(alertsSummary);
  if (decisionsSummary) out.push(decisionsSummary);
  out.push(completed, left, checkin);
  if (hours) out.push(hours);
  if (shopping) out.push(shopping);
  out.push(messages);

  // The briefing is the short version of everything that is not empty. The list
  // of finished tasks is only counted here; the person asks for it separately.
  const briefParts: string[] = [];
  for (const s of out) {
    if (s.id === "completed") {
      if (!s.empty) briefParts.push(`${plural(doneTasks.length, "task")} ${doneTasks.length === 1 ? "has" : "have"} been completed today. Choose done today to hear which.`);
      continue;
    }
    if (s.empty && ["alerts", "decisions", "messages", "shopping"].includes(s.id)) continue;
    briefParts.push(s.text);
  }
  const briefing: Summary = {
    id: "briefing",
    title: "Full update",
    empty: false,
    text: briefParts.length > 0 ? briefParts.join(" ") : "Nothing needs your attention right now.",
  };
  return [briefing, ...out];
}

async function alertsText(v: SummaryViewer): Promise<Summary> {
  const unread = await db.alert.findMany({
    where: { householdId: v.householdId, audience: { has: v.role }, reads: { none: { userId: v.userId } } },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  if (unread.length === 0) return { id: "alerts", title: "New alerts", empty: true, text: "You have no new alerts." };
  const urgent = unread.filter((a) => a.severity === "URGENT");
  const rest = unread.filter((a) => a.severity !== "URGENT");
  const parts = [`You have ${plural(unread.length, "new alert")}${urgent.length > 0 ? `, ${urgent.length} urgent` : ""}.`];
  for (const a of urgent.slice(0, 3)) parts.push(`Urgent: ${a.message}`);
  if (urgent.length > 3) parts.push(`And ${urgent.length - 3} more urgent.`);
  if (rest.length > 0) parts.push(`Others: ${spokenList(rest.map((a) => a.title.toLowerCase()), 4)}.`);
  return { id: "alerts", title: "New alerts", empty: false, text: parts.join(" ") };
}

async function decisionsText(v: SummaryViewer): Promise<Summary> {
  const [tasks, declines, food, hazards] = await Promise.all([
    db.taskInstance.count({ where: { householdId: v.householdId, state: { in: ["COMPLETED_AWAITING_REVIEW", "CORRECTIVE_WORK_SUBMITTED"] } } }),
    db.taskInstance.count({ where: { householdId: v.householdId, state: "DECLINED_AWAITING_CONFIRMATION" } }),
    db.foodDisposalRequest.count({ where: { householdId: v.householdId, status: "PENDING" } }),
    db.foodDisposalRequest.count({ where: { householdId: v.householdId, status: "HAZARD_REPORTED" } }),
  ]);
  const lines: string[] = [];
  if (hazards > 0) lines.push(`${plural(hazards, "food hazard")} to acknowledge`);
  if (food > 0) lines.push(`${plural(food, "food request")} to approve or decline`);
  if (declines > 0) lines.push(`${plural(declines, "declined item")} to confirm`);
  if (tasks > 0) lines.push(`${plural(tasks, "completed task")} to review`);
  if (lines.length === 0) return { id: "decisions", title: "Needs a decision", empty: true, text: "Nothing is waiting for a decision." };
  const total = hazards + food + declines + tasks;
  const who = v.role === "CLIENT" ? "You have" : "There are";
  return { id: "decisions", title: "Needs a decision", empty: false, text: `${who} ${plural(total, "thing")} waiting for a decision: ${spokenList(lines, 4)}.` };
}
