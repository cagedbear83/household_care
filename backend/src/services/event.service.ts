import { createHash } from "crypto";
import type { Prisma, Role } from "@prisma/client";
import { db } from "../db";

export interface AppendEventInput {
  householdId: string;
  actorUserId: string | null;
  actorRole: Role;
  action: string;
  payload: unknown;
  shiftId?: string | null;
  taskInstanceId?: string | null;
}

/**
 * Appends one row to the immutable event log inside the given transaction
 * client, chaining it to the household's most recent event by hash. Every
 * domain write (check-in, task state change, dispute, correction, ...) must
 * go through this function instead of writing its own Event row, so the
 * chain and hash are never computed inconsistently.
 *
 * No update/delete path exists for this table anywhere in the codebase —
 * corrections are new events that reference the original by id (see spec:
 * "Append-only database permissions are insufficient by themselves"), and the
 * database/infrastructure-level protections (retention-locked archive,
 * restricted privileged access) are an operational concern layered on top of
 * this, not something the app layer can enforce by itself.
 */
export async function appendEvent(
  tx: Prisma.TransactionClient,
  input: AppendEventInput
) {
  // One writer per household chain at a time (released at commit/rollback).
  // Without this, two concurrent transactions could both read the same
  // "latest" event and fork the chain.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${input.householdId}))`;

  // The chain head is the event nothing else points back to. Following links
  // (instead of ordering by timestamp) stays correct even when two events
  // share the same millisecond.
  const [previous] = await tx.$queryRaw<Array<{ id: string; hash: string }>>`
    SELECT e.id, e.hash FROM "Event" e
    WHERE e."householdId" = ${input.householdId}
      AND NOT EXISTS (SELECT 1 FROM "Event" n WHERE n."previousEventId" = e.id)
    LIMIT 1`;

  const serverTimestampUtc = new Date();
  const payloadJson = JSON.stringify(input.payload ?? {});
  const hash = createHash("sha256")
    .update(previous?.hash ?? "GENESIS")
    .update(input.householdId)
    .update(input.action)
    .update(payloadJson)
    .update(serverTimestampUtc.toISOString())
    .digest("hex");

  return tx.event.create({
    data: {
      householdId: input.householdId,
      actorUserId: input.actorUserId,
      actorRole: input.actorRole,
      shiftId: input.shiftId ?? null,
      taskInstanceId: input.taskInstanceId ?? null,
      action: input.action,
      payload: input.payload as Prisma.InputJsonValue,
      serverTimestampUtc,
      previousEventId: previous?.id ?? null,
      hash,
    },
  });
}

/** Verifies the hash chain for a household has not been altered. Intended for
 * scheduled integrity checks / restore verification, not the request path. */
export async function verifyChainIntegrity(householdId: string): Promise<{ ok: boolean; brokenAtEventId?: string }> {
  const all = await db.event.findMany({ where: { householdId } });

  // Walk the chain by links from the first event, so a fork, a gap, or an
  // orphaned event is reported instead of being hidden by timestamp ordering.
  const byPrevious = new Map<string | null, typeof all>();
  for (const event of all) {
    const list = byPrevious.get(event.previousEventId) ?? [];
    list.push(event);
    byPrevious.set(event.previousEventId, list);
  }

  const events: typeof all = [];
  let cursor: string | null = null;
  for (;;) {
    const next: typeof all = byPrevious.get(cursor) ?? [];
    if (next.length === 0) break;
    if (next.length > 1) return { ok: false, brokenAtEventId: next[0]!.id }; // fork
    events.push(next[0]!);
    cursor = next[0]!.id;
  }
  if (events.length !== all.length) {
    const seen = new Set(events.map((e) => e.id));
    return { ok: false, brokenAtEventId: all.find((e) => !seen.has(e.id))!.id }; // orphan
  }

  let previousHash = "GENESIS";
  for (const event of events) {
    const expected = createHash("sha256")
      .update(previousHash)
      .update(event.householdId)
      .update(event.action)
      .update(JSON.stringify(event.payload))
      .update(event.serverTimestampUtc.toISOString())
      .digest("hex");
    if (expected !== event.hash) {
      return { ok: false, brokenAtEventId: event.id };
    }
    previousHash = event.hash;
  }
  return { ok: true };
}
