import type { Prisma, Role, ShoppingSource, ShoppingStatus } from "@prisma/client";
import { db } from "../db";
import { appendEvent } from "./event.service";
import { raiseAlert, resolveAlerts } from "./alert.service";
import { notifyRoles } from "./household-notify.service";
import { findOpenShiftForIp } from "./ip-shift";

export class ShoppingError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

export interface ShoppingActor {
  userId: string;
  role: Role;
  householdId: string;
}

type OpenStatus = Extract<ShoppingStatus, "NEEDED" | "LOW" | "OUT">;
const OPEN: OpenStatus[] = ["NEEDED", "LOW", "OUT"];
const SEVERITY: Record<OpenStatus, number> = { NEEDED: 1, LOW: 2, OUT: 3 };

/** Same item typed differently ("Eggs", " eggs ", "EGGS!") is one item. */
export const itemKey = (name: string) =>
  name.trim().toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "").replace(/\s+/g, " ");

function clean(value: string | undefined | null, max: number): string | null {
  const v = value?.trim().replace(/\s+/g, " ");
  return v ? v.slice(0, max) : null;
}

export interface AddItemInput {
  name: string;
  quantity?: string | null;
  storageLocation?: string | null;
  status?: OpenStatus;
  note?: string | null;
  source: ShoppingSource;
}

/**
 * Adds an item, or merges into the open item with the same name: the worse
 * status wins (out > low > needed), blanks are filled in, and the report count
 * goes up, so repeated reports never make duplicate rows. Runs inside the
 * caller's transaction under a per-household lock, so two people adding "eggs"
 * at the same moment still end up with one row.
 */
export async function addOrMergeItem(tx: Prisma.TransactionClient, actor: ShoppingActor, input: AddItemInput) {
  const name = clean(input.name, 120);
  if (!name) throw new ShoppingError("INVALID_NAME", "Enter the name of the item.");
  const key = itemKey(name);
  if (!key) throw new ShoppingError("INVALID_NAME", "Enter the name of the item.");
  const status = input.status ?? "NEEDED";

  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${actor.householdId}:shopping`}))`;
  const existing = await tx.shoppingItem.findFirst({ where: { householdId: actor.householdId, nameKey: key, status: { in: OPEN } } });

  if (existing) {
    const worse = SEVERITY[status] > SEVERITY[existing.status as OpenStatus];
    const merged = await tx.shoppingItem.update({
      where: { id: existing.id },
      data: {
        status: worse ? status : existing.status,
        quantity: existing.quantity ?? clean(input.quantity, 60),
        storageLocation: existing.storageLocation ?? clean(input.storageLocation, 120),
        note: existing.note ?? clean(input.note, 300),
        reportCount: { increment: 1 },
      },
    });
    await appendEvent(tx, {
      householdId: actor.householdId,
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: "shopping_item_merged",
      payload: { itemId: existing.id, name: existing.name, from: existing.status, to: merged.status, source: input.source },
    });
    return { item: merged, created: false, worsened: worse };
  }

  const created = await tx.shoppingItem.create({
    data: {
      householdId: actor.householdId,
      name,
      nameKey: key,
      quantity: clean(input.quantity, 60),
      storageLocation: clean(input.storageLocation, 120),
      status,
      source: input.source,
      note: clean(input.note, 300),
      createdByUserId: actor.userId,
    },
  });
  await appendEvent(tx, {
    householdId: actor.householdId,
    actorUserId: actor.userId,
    actorRole: actor.role,
    action: "shopping_item_added",
    payload: { itemId: created.id, name, status, source: input.source },
  });
  return { item: created, created: true, worsened: false };
}

/** Client or administrator adds something by hand. */
export async function addItem(actor: ShoppingActor, input: Omit<AddItemInput, "source">) {
  if (actor.role !== "CLIENT" && actor.role !== "ADMIN") throw new ShoppingError("FORBIDDEN", "Only the client or an administrator can add items.");
  const result = await db.$transaction((tx) => addOrMergeItem(tx, actor, { ...input, source: actor.role === "CLIENT" ? "CLIENT" : "ADMIN" }));
  return result;
}

/**
 * An IP reports something is running low or gone (during their shift). It goes
 * on the list automatically, and the client and administrator are told when it
 * is new or has got worse. There is no shopping duty for the IP: this only
 * reports. "Last of it?" is asked of the IP rather than guessed from meals.
 */
export async function reportLowSupply(
  actor: ShoppingActor,
  input: { item: string; level: "LOW" | "OUT"; location?: string; note?: string }
) {
  if (actor.role !== "IP") throw new ShoppingError("FORBIDDEN", "Only the IP reports low supplies here.");
  const shift = await findOpenShiftForIp(actor.userId, actor.householdId);
  if (!shift) throw new ShoppingError("SHIFT_NOT_OPEN", "You can report supplies while you are checked in on an authorized shift.");

  const result = await db.$transaction(async (tx) => {
    const added = await addOrMergeItem(tx, actor, {
      name: input.item,
      status: input.level,
      storageLocation: input.location,
      note: input.note,
      source: "IP_REPORT",
    });
    await appendEvent(tx, {
      householdId: actor.householdId,
      actorUserId: actor.userId,
      actorRole: "IP",
      action: "low_supply_reported",
      shiftId: shift.id,
      payload: { itemId: added.item.id, name: added.item.name, level: input.level },
    });
    if (added.created || added.worsened) {
      await raiseAlert(tx, {
        householdId: actor.householdId,
        actorUserId: actor.userId,
        actorRole: "IP",
        type: "low_supply",
        shiftId: shift.id,
        message: `${added.item.name} ${added.item.status === "OUT" ? "is all gone" : "is running low"}. It was added to the shopping list.`,
        refId: added.item.id,
        dedupeKey: `low_supply:${added.item.id}:${added.item.status}`,
      });
    }
    return added;
  });

  if (result.created || result.worsened) {
    const what = result.item.status === "OUT" ? "is all gone" : "is running low";
    notifyRoles(actor.householdId, ["CLIENT", "ADMIN"], "A supply needs restocking", `${result.item.name} ${what}. It was added to the shopping list.`);
  }
  return result;
}

async function loadOpenItem(tx: Prisma.TransactionClient, actor: ShoppingActor, id: string) {
  const item = await tx.shoppingItem.findFirst({ where: { id, householdId: actor.householdId } });
  if (!item) throw new ShoppingError("NOT_FOUND", "Item not found.");
  if (!OPEN.includes(item.status as OpenStatus)) throw new ShoppingError("ALREADY_CLOSED", "This item was already bought or removed.");
  return item;
}

export async function updateItem(
  actor: ShoppingActor,
  id: string,
  patch: { quantity?: string | null; storageLocation?: string | null; status?: OpenStatus; note?: string | null }
) {
  if (actor.role !== "CLIENT" && actor.role !== "ADMIN") throw new ShoppingError("FORBIDDEN", "Only the client or an administrator can change items.");
  return db.$transaction(async (tx) => {
    const before = await loadOpenItem(tx, actor, id);
    const after = await tx.shoppingItem.update({
      where: { id },
      data: {
        ...(patch.quantity !== undefined ? { quantity: clean(patch.quantity, 60) } : {}),
        ...(patch.storageLocation !== undefined ? { storageLocation: clean(patch.storageLocation, 120) } : {}),
        ...(patch.note !== undefined ? { note: clean(patch.note, 300) } : {}),
        ...(patch.status ? { status: patch.status } : {}),
      },
    });
    await appendEvent(tx, {
      householdId: actor.householdId,
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: "shopping_item_updated",
      payload: { itemId: id, name: before.name, changes: patch },
    });
    return after;
  });
}

/** "Bought / restocked", or "not needed any more". The row stays as history either way. */
export async function closeItem(actor: ShoppingActor, id: string, outcome: "PURCHASED" | "DISMISSED") {
  if (actor.role !== "CLIENT" && actor.role !== "ADMIN") throw new ShoppingError("FORBIDDEN", "Only the client or an administrator can do that.");
  return db.$transaction(async (tx) => {
    const item = await loadOpenItem(tx, actor, id);
    // Atomic: two people tapping at once close it once.
    const result = await tx.shoppingItem.updateMany({
      where: { id, status: { in: OPEN } },
      data: { status: outcome, closedAt: new Date(), closedByUserId: actor.userId },
    });
    if (result.count !== 1) throw new ShoppingError("ALREADY_CLOSED", "This item was already bought or removed.");
    await resolveAlerts(tx, actor.householdId, "low_supply", id);
    await appendEvent(tx, {
      householdId: actor.householdId,
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: outcome === "PURCHASED" ? "shopping_item_purchased" : "shopping_item_dismissed",
      payload: { itemId: id, name: item.name },
    });
    return tx.shoppingItem.findUniqueOrThrow({ where: { id } });
  });
}

export async function listShopping(householdId: string) {
  const open = await db.shoppingItem.findMany({ where: { householdId, status: { in: OPEN } } });
  const since = new Date(Date.now() - 30 * 86_400_000);
  const closed = await db.shoppingItem.findMany({
    where: { householdId, status: { in: ["PURCHASED", "DISMISSED"] }, closedAt: { gt: since } },
    orderBy: { closedAt: "desc" },
    take: 50,
  });

  const userIds = [...new Set([...open, ...closed].flatMap((i) => [i.createdByUserId, i.closedByUserId]).filter((id): id is string => Boolean(id)))];
  const users = userIds.length ? await db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } }) : [];
  const nameOf = new Map(users.map((u) => [u.id, u.name]));
  const shape = (i: (typeof open)[number]) => ({
    id: i.id,
    name: i.name,
    quantity: i.quantity,
    storageLocation: i.storageLocation,
    status: i.status,
    source: i.source,
    note: i.note,
    reportCount: i.reportCount,
    addedBy: nameOf.get(i.createdByUserId) ?? null,
    addedAt: i.createdAt,
    updatedAt: i.updatedAt,
    closedBy: i.closedByUserId ? (nameOf.get(i.closedByUserId) ?? null) : null,
    closedAt: i.closedAt,
  });

  open.sort((a, b) => SEVERITY[b.status as OpenStatus] - SEVERITY[a.status as OpenStatus] || a.createdAt.getTime() - b.createdAt.getTime());
  return { open: open.map(shape), recent: closed.map(shape) };
}
