import { randomUUID } from "crypto";
import type { AlertSeverity, Prisma, Role } from "@prisma/client";
import { appendEvent } from "./event.service";

export type AlertType =
  | "check_in"
  | "location_verification_failed"
  | "authorization_closed"
  | "excess_time"
  | "task_disputed"
  | "task_decline_reported"
  | "food_request"
  | "food_request_no_response"
  | "food_hazard"
  | "low_supply"
  | "early_check_in"
  | "early_checkout"
  | "unresolved_tasks_near_checkout"
  | "suspicious_pattern"
  | "completion_error_reported"
  | "client_away"
  | "long_day"
  | "wellbeing_followup";

interface AlertMeta {
  title: string;
  severity: AlertSeverity;
  /** Which roles see it on the alerts screen. */
  audience: Role[];
  /** The screen where it can be acted on. */
  link: string;
  /**
   * Whether the delivery job should also text/email the audience. Types that
   * already notify people at the moment they happen (food and low-supply
   * requests) are false here so nobody gets the same message twice.
   */
  notify: boolean;
}

/**
 * Who hears about what, and how urgently. "Urgent" is for things that need a
 * person soon (a hazard, nobody answering, time past the authorized window, a
 * location that could not be verified, an unusual burst of activity). Nothing
 * here ever says something is proven wrong: unusual patterns are flagged "may
 * need a look".
 */
const ALERT_META: Record<AlertType, AlertMeta> = {
  check_in: { title: "IP checked in", severity: "INFO", audience: ["ADMIN"], link: "/review", notify: true },
  early_check_in: { title: "Early check-in", severity: "NORMAL", audience: ["ADMIN"], link: "/schedule", notify: true },
  early_checkout: { title: "Early checkout", severity: "NORMAL", audience: ["ADMIN"], link: "/schedule", notify: true },
  location_verification_failed: { title: "Location could not be verified", severity: "URGENT", audience: ["ADMIN"], link: "/review", notify: true },
  authorization_closed: { title: "Authorized time ended", severity: "NORMAL", audience: ["ADMIN"], link: "/schedule", notify: false },
  excess_time: { title: "Time past the authorized window", severity: "URGENT", audience: ["ADMIN"], link: "/schedule", notify: true },
  unresolved_tasks_near_checkout: { title: "Tasks left undone", severity: "NORMAL", audience: ["ADMIN", "CLIENT"], link: "/review", notify: true },
  task_disputed: { title: "A task was disputed", severity: "NORMAL", audience: ["ADMIN"], link: "/review", notify: true },
  task_decline_reported: { title: "A decline needs confirming", severity: "NORMAL", audience: ["CLIENT", "ADMIN"], link: "/review", notify: true },
  food_request: { title: "Food approval needed", severity: "NORMAL", audience: ["CLIENT", "ADMIN"], link: "/food", notify: false },
  food_request_no_response: { title: "No answer on a food request", severity: "URGENT", audience: ["ADMIN"], link: "/food", notify: false },
  food_hazard: { title: "Food hazard reported", severity: "URGENT", audience: ["CLIENT", "ADMIN"], link: "/food", notify: false },
  low_supply: { title: "A supply is running low", severity: "NORMAL", audience: ["CLIENT", "ADMIN"], link: "/shopping", notify: false },
  completion_error_reported: { title: "A mistake was reported", severity: "NORMAL", audience: ["ADMIN", "CLIENT"], link: "/corrections", notify: true },
  client_away: { title: "Away mode changed", severity: "NORMAL", audience: ["ADMIN", "CLIENT"], link: "/home", notify: false },
  long_day: { title: "A long day", severity: "NORMAL", audience: ["ADMIN", "CLIENT"], link: "/reports", notify: true },
  // Administrators only, and it never says what the check-in was about or what was answered.
  wellbeing_followup: { title: "A check-in may need a follow-up", severity: "NORMAL", audience: ["ADMIN"], link: "/wellbeing", notify: true },
  suspicious_pattern: { title: "Activity that may need a look", severity: "URGENT", audience: ["ADMIN"], link: "/review", notify: true },
};

export interface RaiseAlertInput {
  householdId: string;
  actorUserId: string | null;
  actorRole: Role;
  type: AlertType;
  shiftId?: string | null;
  message: string;
  detail?: Record<string, unknown>;
  /** What the alert is about, so it can be marked handled later. */
  refId?: string;
  /** The same matter does not alert twice. */
  dedupeKey?: string;
}

/**
 * Raises an alert inside the caller's transaction: a row for the alerts
 * screen, plus the permanent `alert_raised` audit event. If the dedupe key was
 * already used, nothing is created and null is returned.
 */
export async function raiseAlert(tx: Prisma.TransactionClient, input: RaiseAlertInput) {
  const meta = ALERT_META[input.type];
  const id = randomUUID();

  const created = await tx.alert.createMany({
    data: [
      {
        id,
        householdId: input.householdId,
        type: input.type,
        severity: meta.severity,
        title: meta.title,
        message: input.message,
        audience: meta.audience,
        link: meta.link,
        shiftId: input.shiftId ?? null,
        actorUserId: input.actorUserId,
        refId: input.refId ?? null,
        dedupeKey: input.dedupeKey ?? null,
        notifyPending: meta.notify,
      },
    ],
    skipDuplicates: true,
  });
  if (created.count === 0) return null;

  const event = await appendEvent(tx, {
    householdId: input.householdId,
    actorUserId: input.actorUserId,
    actorRole: input.actorRole,
    action: "alert_raised",
    shiftId: input.shiftId ?? null,
    payload: { alertId: id, type: input.type, message: input.message, detail: input.detail ?? {} },
  });
  await tx.alert.update({ where: { id }, data: { eventId: event.id } });

  // eslint-disable-next-line no-console
  console.warn(`[ALERT:${input.type}] ${input.message}`);
  return { id };
}

/** The matter an alert was about has been dealt with (for example, the client answered a request). */
export async function resolveAlerts(tx: Prisma.TransactionClient, householdId: string, type: AlertType, refId: string) {
  await tx.alert.updateMany({ where: { householdId, type, refId, resolvedAt: null }, data: { resolvedAt: new Date() } });
}
