import { DateTime } from "luxon";
import { db } from "../db";

/**
 * Record retention is a fixed rule of the product, not a setting. Nobody (no
 * role, no screen, no environment variable) can change it.
 *
 * Every record is kept for at least ten years from when it was recorded. That
 * covers the longest period found in the rules that apply to this kind of
 * employment: the Illinois wage-claim window (10 years), federal and Illinois
 * payroll and pay-stub records (3 years), and federal employment-tax records
 * (about 4 to 5 years).
 *
 * This module only answers "until when" and "what could be archived". The app
 * itself never deletes anything. Moving old records to compressed archive
 * storage is a separate job that works from this rule (see project_state.md).
 */
export const RETENTION_YEARS = 10;

/** The moment a record made at `recordedAt` stops being protected. */
export function retainUntil(recordedAt: Date): Date {
  return DateTime.fromJSDate(recordedAt, { zone: "utc" }).plus({ years: RETENTION_YEARS }).toJSDate();
}

export const isPastRetention = (recordedAt: Date, now: Date = new Date()) => retainUntil(recordedAt) <= now;

export interface ArchiveCandidates {
  /** Events older than the retention period. */
  pastRetention: number;
  /** Of those, kept anyway because they belong to a dispute that is not resolved yet. */
  keptForOpenDispute: number;
  /** Past the period and free to be archived. */
  eligible: number;
}

/**
 * Counts what could be moved to the archive. Records tied to a dispute that is
 * still open are always kept, however old. Counted directly (not with NOT(...),
 * which would silently drop rows where a column is null).
 */
export async function archiveCandidates(householdId: string, now: Date = new Date()): Promise<ArchiveCandidates> {
  const cutoff = DateTime.fromJSDate(now, { zone: "utc" }).minus({ years: RETENTION_YEARS }).toJSDate();
  const past = await db.event.count({ where: { householdId, serverTimestampUtc: { lt: cutoff } } });
  if (past === 0) return { pastRetention: 0, keptForOpenDispute: 0, eligible: 0 };

  const open = await db.taskInstance.findMany({ where: { householdId, state: { in: ["DISPUTED", "CORRECTIVE_WORK_SUBMITTED"] } }, select: { id: true } });
  const kept = open.length
    ? await db.event.count({ where: { householdId, serverTimestampUtc: { lt: cutoff }, taskInstanceId: { in: open.map((t) => t.id) } } })
    : 0;
  return { pastRetention: past, keptForOpenDispute: kept, eligible: past - kept };
}
