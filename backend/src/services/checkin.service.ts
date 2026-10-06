import { DateTime } from "luxon";
import type { CheckInInstrument, Role } from "@prisma/client";
import { db } from "../db";
import { appendEvent } from "./event.service";
import { raiseAlert } from "./alert.service";
import { notifyUsers } from "./household-notify.service";
import { localDateString } from "./time.service";

/**
 * Wellbeing check-ins for the client: PHQ-2 (low mood) and GAD-2 (anxiety),
 * every one, two or three days, set up by an administrator once the client has
 * agreed. These are screening questions, not a diagnosis and not an emergency
 * service. The questions and scoring are the standard published ones (public
 * domain); the wording is not changed.
 *
 * Privacy rules, all enforced here and tested:
 *  - Only an administrator can read answers and scores.
 *  - The IP never sees anything about this: no screen, no alert, no message.
 *  - The audit log records that a check-in was answered and whether it was
 *    flagged, never the answers or the score. No message carries them either.
 *  - The client (and the primary family member, who has the client's access)
 *    answers; what they get back is a gentle message, never a score.
 */
export class CheckInError extends Error {
  constructor(public code: string, message: string, public status = 409) {
    super(message);
  }
}

export interface CheckInActor {
  userId: string;
  /** The role the server sees: the primary family member is CLIENT. */
  role: Role;
  /** The person's own role, for the record. */
  ownRole: Role;
  householdId: string;
}

export const OPTIONS = [
  { value: 0, label: "Not at all" },
  { value: 1, label: "Several days" },
  { value: 2, label: "More than half the days" },
  { value: 3, label: "Nearly every day" },
] as const;

export const INSTRUMENTS: Record<CheckInInstrument, { title: string; topic: string; intro: string; questions: string[] }> = {
  PHQ2: {
    title: "How have you been feeling?",
    topic: "mood",
    intro: "Over the last 2 weeks, how often have you been bothered by the following problems?",
    questions: ["Little interest or pleasure in doing things", "Feeling down, depressed, or hopeless"],
  },
  GAD2: {
    title: "How have you been feeling?",
    topic: "anxiety",
    intro: "Over the last 2 weeks, how often have you been bothered by the following problems?",
    questions: ["Feeling nervous, anxious or on edge", "Not being able to stop or control worrying"],
  },
};

/** The usual screening cutoff for both: a total of 3 or more out of 6. */
export const FLAG_AT = 3;

export const GENTLE_FLAGGED =
  "Thank you for telling us. Many people feel this way at times, and help is available. If you want to talk to someone now, call or text 988 (the Suicide and Crisis Lifeline). If you are in danger, call 911. Someone on your care team may check in with you.";
export const GENTLE_OK = "Thank you. Your answers were saved.";

const isStaff = (role: Role) => role === "CLIENT" || role === "ADMIN";

const daysBetween = (from: string, to: string) => Math.round(DateTime.fromISO(to).diff(DateTime.fromISO(from), "days").days);

const planView = (p: { instrument: CheckInInstrument; everyDays: number; active: boolean; startDate: string; consentRecordedAt: Date; consentNote: string | null }) => ({
  instrument: p.instrument,
  everyDays: p.everyDays,
  active: p.active,
  startDate: p.startDate,
  consentRecordedAt: p.consentRecordedAt,
  consentNote: p.consentNote,
});

// ---------------------------------------------------------------------------
// Plans

/** What is set up. The client side sees which check-ins and how often, never any answers. */
export async function listPlans(viewer: { role: Role; householdId: string }) {
  if (!isStaff(viewer.role)) throw new CheckInError("FORBIDDEN", "Not available.", 403);
  const plans = await db.checkInPlan.findMany({ where: { householdId: viewer.householdId }, orderBy: { instrument: "asc" } });
  return plans.map(planView);
}

export async function setPlan(
  actor: CheckInActor,
  input: { instrument: CheckInInstrument; everyDays: number; active?: boolean; clientAgreed: boolean; consentNote?: string }
) {
  if (actor.role !== "ADMIN") throw new CheckInError("FORBIDDEN", "Only an administrator can set up check-ins.", 403);
  if (![1, 2, 3].includes(input.everyDays)) throw new CheckInError("INVALID", "Choose every day, every 2 days or every 3 days.", 400);
  const household = await db.household.findUniqueOrThrow({ where: { id: actor.householdId }, select: { timezone: true } });
  const existing = await db.checkInPlan.findUnique({ where: { householdId_instrument: { householdId: actor.householdId, instrument: input.instrument } } });
  // The client's agreement is needed to start. Changing how often, or pausing, does not ask again.
  if (!existing && !input.clientAgreed) throw new CheckInError("CONSENT_REQUIRED", "The client has to agree before a check-in is started. Confirm that they have.", 400);
  const note = input.consentNote?.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim().slice(0, 200) || null;

  await db.$transaction(async (tx) => {
    const today = localDateString(new Date(), household.timezone);
    await tx.checkInPlan.upsert({
      where: { householdId_instrument: { householdId: actor.householdId, instrument: input.instrument } },
      create: {
        householdId: actor.householdId,
        instrument: input.instrument,
        everyDays: input.everyDays,
        active: input.active ?? true,
        startDate: today,
        consentRecordedAt: new Date(),
        consentNote: note,
        setByUserId: actor.userId,
      },
      update: { everyDays: input.everyDays, ...(input.active === undefined ? {} : { active: input.active }), setByUserId: actor.userId },
    });
    await appendEvent(tx, {
      householdId: actor.householdId,
      actorUserId: actor.userId,
      actorRole: actor.ownRole,
      action: existing ? "checkin_plan_changed" : "checkin_plan_started",
      payload: { instrument: input.instrument, everyDays: input.everyDays, active: input.active ?? true },
    });
  });
}

/** The client side can pause or resume a check-in. Starting one, or changing how often, is for an administrator. */
export async function setPaused(actor: CheckInActor, instrument: CheckInInstrument, paused: boolean) {
  if (!isStaff(actor.role)) throw new CheckInError("FORBIDDEN", "Not available.", 403);
  await db.$transaction(async (tx) => {
    const changed = await tx.checkInPlan.updateMany({ where: { householdId: actor.householdId, instrument }, data: { active: !paused } });
    if (changed.count === 0) throw new CheckInError("NOT_FOUND", "That check-in is not set up.", 404);
    await appendEvent(tx, {
      householdId: actor.householdId,
      actorUserId: actor.userId,
      actorRole: actor.ownRole,
      action: paused ? "checkin_plan_paused" : "checkin_plan_resumed",
      payload: { instrument },
    });
  });
}

// ---------------------------------------------------------------------------
// Answering

/** The check-ins that are due today for the client, with their questions. */
export async function dueToday(actor: { role: Role; householdId: string }, now: Date = new Date()) {
  if (actor.role !== "CLIENT") return { due: [] as DueCheckIn[] };
  const household = await db.household.findUniqueOrThrow({ where: { id: actor.householdId }, select: { timezone: true } });
  const today = localDateString(now, household.timezone);
  const plans = await db.checkInPlan.findMany({ where: { householdId: actor.householdId, active: true }, orderBy: { instrument: "asc" } });
  const due: DueCheckIn[] = [];
  for (const p of plans) {
    if (today < p.startDate) continue;
    const last = await db.checkInResponse.findFirst({ where: { householdId: actor.householdId, instrument: p.instrument }, orderBy: { localDate: "desc" }, select: { localDate: true } });
    if (last && daysBetween(last.localDate, today) < p.everyDays) continue;
    const def = INSTRUMENTS[p.instrument];
    due.push({ instrument: p.instrument, title: def.title, intro: def.intro, questions: def.questions, options: OPTIONS.map((o) => ({ ...o })) });
  }
  return { due };
}

export interface DueCheckIn {
  instrument: CheckInInstrument;
  title: string;
  intro: string;
  questions: string[];
  options: { value: number; label: string }[];
}

async function requireDue(actor: CheckInActor, instrument: CheckInInstrument, now: Date) {
  if (actor.role !== "CLIENT") throw new CheckInError("FORBIDDEN", "Only the client can answer.", 403);
  const { due } = await dueToday(actor, now);
  if (!due.some((d) => d.instrument === instrument)) throw new CheckInError("NOT_DUE", "There is no check-in to answer right now.");
}

export async function submit(actor: CheckInActor, instrument: CheckInInstrument, answers: number[], now: Date = new Date()) {
  const def = INSTRUMENTS[instrument];
  if (answers.length !== def.questions.length || answers.some((a) => !Number.isInteger(a) || a < 0 || a > 3)) {
    throw new CheckInError("INVALID", "Please answer every question.", 400);
  }
  await requireDue(actor, instrument, now);
  const household = await db.household.findUniqueOrThrow({ where: { id: actor.householdId }, select: { timezone: true } });
  const localDate = localDateString(now, household.timezone);
  const score = answers.reduce((a, b) => a + b, 0);
  const flagged = score >= FLAG_AT;

  const responseId = await db.$transaction(async (tx) => {
    // One a day per instrument: pressing twice, or two devices, saves once.
    const created = await tx.checkInResponse.createMany({
      data: [{ householdId: actor.householdId, instrument, localDate, answers, score, flagged, answeredByUserId: actor.userId, answeredByRole: actor.ownRole }],
      skipDuplicates: true,
    });
    if (created.count === 0) throw new CheckInError("ALREADY_ANSWERED", "That check-in was already answered today.");
    const row = await tx.checkInResponse.findUniqueOrThrow({ where: { householdId_instrument_localDate: { householdId: actor.householdId, instrument, localDate } }, select: { id: true } });
    await appendEvent(tx, {
      householdId: actor.householdId,
      actorUserId: actor.userId,
      actorRole: actor.ownRole,
      action: "wellbeing_checkin_answered",
      payload: { instrument, flagged },
    });
    if (flagged) {
      // Administrators see this in the app. No score, no answers and no mention of the topic.
      await raiseAlert(tx, {
        householdId: actor.householdId,
        actorUserId: actor.userId,
        actorRole: actor.ownRole,
        type: "wellbeing_followup",
        message: "A wellbeing check-in may need a follow-up. Open Wellbeing check-ins to see it.",
        refId: row.id,
        dedupeKey: `wellbeing:${row.id}`,
      });
    }
    return { id: row.id };
  });

  if (flagged) {
    // The primary family member is told too, in a message with nothing in it but "please check in".
    const primary = await db.user.findMany({ where: { householdId: actor.householdId, role: "FAMILY", isPrimaryFamily: true, active: true }, select: { id: true } });
    notifyUsers(actor.householdId, primary.map((u) => u.id), "Please check in with the client", "A wellbeing check-in may need a follow-up. Please check in with the client.");
  }
  return { saved: true as const, flagged, message: flagged ? GENTLE_FLAGGED : GENTLE_OK, id: responseId.id };
}

/** "Not today": counts as this check-in's turn, so it is not asked again until the next one is due. */
export async function skip(actor: CheckInActor, instrument: CheckInInstrument, now: Date = new Date()) {
  await requireDue(actor, instrument, now);
  const household = await db.household.findUniqueOrThrow({ where: { id: actor.householdId }, select: { timezone: true } });
  const localDate = localDateString(now, household.timezone);
  await db.$transaction(async (tx) => {
    const created = await tx.checkInResponse.createMany({
      data: [{ householdId: actor.householdId, instrument, localDate, skipped: true, answers: [], answeredByUserId: actor.userId, answeredByRole: actor.ownRole }],
      skipDuplicates: true,
    });
    if (created.count === 0) throw new CheckInError("ALREADY_ANSWERED", "That check-in was already answered today.");
    await appendEvent(tx, {
      householdId: actor.householdId,
      actorUserId: actor.userId,
      actorRole: actor.ownRole,
      action: "wellbeing_checkin_skipped",
      payload: { instrument },
    });
  });
  return { saved: true as const };
}

// ---------------------------------------------------------------------------
// Reading: administrators only

export async function history(viewer: { role: Role; householdId: string }, opts: { instrument?: CheckInInstrument; days?: number } = {}) {
  if (viewer.role !== "ADMIN") throw new CheckInError("FORBIDDEN", "Only an administrator can see check-in answers.", 403);
  const household = await db.household.findUniqueOrThrow({ where: { id: viewer.householdId }, select: { timezone: true } });
  const today = localDateString(new Date(), household.timezone);
  const from = DateTime.fromISO(today).minus({ days: Math.min(Math.max(opts.days ?? 60, 1), 365) }).toISODate()!;
  const rows = await db.checkInResponse.findMany({
    where: { householdId: viewer.householdId, ...(opts.instrument ? { instrument: opts.instrument } : {}), localDate: { gte: from } },
    orderBy: [{ localDate: "desc" }, { instrument: "asc" }],
  });
  const people = await db.user.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.answeredByUserId))] } }, select: { id: true, name: true } });
  const names = new Map(people.map((p) => [p.id, p.name]));
  return rows.map((r) => ({
    id: r.id,
    instrument: r.instrument,
    localDate: r.localDate,
    skipped: r.skipped,
    answers: r.answers,
    score: r.score,
    flagged: r.flagged,
    answeredBy: names.get(r.answeredByUserId) ?? null,
    answeredByRole: r.answeredByRole,
  }));
}
