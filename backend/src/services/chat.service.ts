import type { Role, User } from "@prisma/client";
import { db } from "../db";

export class ChatError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

export interface ChatUser {
  userId: string;
  householdId: string;
}

const MAX_LENGTH = 2000;

// The administrator is also the case manager (per the household's decision).
const ROLE_LABELS: Record<Role, string> = {
  ADMIN: "Administrator (Case Manager)",
  CLIENT: "Client",
  FAMILY: "Family",
  IP: "Individual Provider",
};

type Person = Pick<User, "id" | "name" | "role" | "relationship" | "active" | "accessRevokedAt" | "activatedAt" | "createdAt">;

const roleLabel = (u: Pick<User, "role" | "relationship">) =>
  u.role === "FAMILY" && u.relationship ? `Family (${u.relationship})` : ROLE_LABELS[u.role];
const canChat = (u: Pick<User, "active" | "accessRevokedAt">) => u.active && !u.accessRevokedAt;
/** Group history starts when a person joined, so a new family member does not read earlier conversations. */
const joinedAt = (u: Pick<User, "activatedAt" | "createdAt">) => u.activatedAt ?? u.createdAt;

const PERSON_SELECT = { id: true, name: true, role: true, relationship: true, active: true, accessRevokedAt: true, activatedAt: true, createdAt: true } as const;

async function loadMe(me: ChatUser): Promise<Person> {
  const user = await db.user.findFirst({ where: { id: me.userId, householdId: me.householdId }, select: PERSON_SELECT });
  if (!user) throw new ChatError("NOT_FOUND", "Account not found.");
  return user;
}

export async function ensureGroup(householdId: string) {
  return db.conversation.upsert({
    where: { uniqueKey: `group:${householdId}` },
    create: { householdId, kind: "GROUP", uniqueKey: `group:${householdId}` },
    update: {},
  });
}

/** Everyone in the household who can chat, except the caller. */
export async function listPeople(me: ChatUser) {
  const people = await db.user.findMany({
    where: { householdId: me.householdId, active: true, accessRevokedAt: null, id: { not: me.userId } },
    select: PERSON_SELECT,
    orderBy: [{ role: "asc" }, { name: "asc" }],
  });
  return people.map((p) => ({ id: p.id, name: p.name, roleLabel: roleLabel(p) }));
}

async function loadConversation(me: Person, householdId: string, conversationId: string) {
  const conversation = await db.conversation.findFirst({ where: { id: conversationId, householdId } });
  if (!conversation) throw new ChatError("NOT_FOUND", "Conversation not found.");
  if (conversation.kind === "DIRECT" && conversation.userAId !== me.id && conversation.userBId !== me.id) {
    // Same answer as "does not exist": a direct message is private to its two people.
    throw new ChatError("NOT_FOUND", "Conversation not found.");
  }
  return conversation;
}

export async function listConversations(meRef: ChatUser) {
  const me = await loadMe(meRef);
  const group = await ensureGroup(meRef.householdId);
  const directs = await db.conversation.findMany({
    where: { householdId: meRef.householdId, kind: "DIRECT", OR: [{ userAId: me.id }, { userBId: me.id }] },
  });

  const out = [];
  for (const c of [group, ...directs]) {
    const floor = c.kind === "GROUP" ? joinedAt(me) : null;
    const read = await db.conversationRead.findUnique({ where: { userId_conversationId: { userId: me.id, conversationId: c.id } } });
    const since = [read?.lastReadAt, floor].filter((d): d is Date => Boolean(d)).sort((a, b) => b.getTime() - a.getTime())[0];

    const [last, unread] = await Promise.all([
      db.message.findFirst({ where: { conversationId: c.id, ...(floor ? { createdAt: { gte: floor } } : {}) }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] }),
      db.message.count({ where: { conversationId: c.id, senderUserId: { not: me.id }, ...(since ? { createdAt: { gt: since } } : {}) } }),
    ]);
    const sender = last ? await db.user.findUnique({ where: { id: last.senderUserId }, select: { name: true } }) : null;

    let title = "Household group chat";
    let subtitle: string | null = "Everyone in the household";
    let canSend = true;
    if (c.kind === "DIRECT") {
      const other = await db.user.findUnique({ where: { id: c.userAId === me.id ? c.userBId! : c.userAId! }, select: PERSON_SELECT });
      title = other?.name ?? "Unknown";
      subtitle = other ? roleLabel(other) : null;
      canSend = other ? canChat(other) : false;
    }
    out.push({
      id: c.id,
      kind: c.kind,
      title,
      subtitle,
      canSend,
      unread,
      lastMessage: last ? { body: last.body, senderName: sender?.name ?? "Someone", at: last.createdAt } : null,
    });
  }

  return out.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "GROUP" ? -1 : 1;
    return (b.lastMessage?.at.getTime() ?? 0) - (a.lastMessage?.at.getTime() ?? 0);
  });
}

export async function unreadTotal(me: ChatUser): Promise<number> {
  return (await listConversations(me)).reduce((sum, c) => sum + c.unread, 0);
}

export async function startDirect(meRef: ChatUser, otherUserId: string) {
  const me = await loadMe(meRef);
  if (otherUserId === me.id) throw new ChatError("INVALID", "You cannot message yourself.");
  const other = await db.user.findFirst({ where: { id: otherUserId, householdId: meRef.householdId }, select: PERSON_SELECT });
  if (!other || !canChat(other)) throw new ChatError("NOT_FOUND", "That person is not available to message.");

  const [a, b] = [me.id, other.id].sort() as [string, string];
  const conversation = await db.conversation.upsert({
    where: { uniqueKey: `dm:${a}:${b}` },
    create: { householdId: meRef.householdId, kind: "DIRECT", uniqueKey: `dm:${a}:${b}`, userAId: a, userBId: b },
    update: {},
  });
  return { id: conversation.id };
}

export async function getMessages(meRef: ChatUser, conversationId: string, opts: { afterId?: string; limit?: number } = {}) {
  const me = await loadMe(meRef);
  const conversation = await loadConversation(me, meRef.householdId, conversationId);
  const floor = conversation.kind === "GROUP" ? joinedAt(me) : null;
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 100);
  const base = { conversationId, ...(floor ? { createdAt: { gte: floor } } : {}) };

  let rows;
  if (opts.afterId) {
    const cursor = await db.message.findFirst({ where: { id: opts.afterId, conversationId } });
    rows = await db.message.findMany({
      where: cursor
        ? { conversationId, AND: [floor ? { createdAt: { gte: floor } } : {}, { OR: [{ createdAt: { gt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { gt: cursor.id } }] }] }
        : base,
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: 100,
    });
  } else {
    rows = (await db.message.findMany({ where: base, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: limit })).reverse();
  }

  const senders = await db.user.findMany({
    where: { id: { in: [...new Set(rows.map((m) => m.senderUserId))] } },
    select: PERSON_SELECT,
  });
  const byId = new Map(senders.map((s) => [s.id, s]));
  return rows.map((m) => ({
    id: m.id,
    senderId: m.senderUserId,
    senderName: byId.get(m.senderUserId)?.name ?? "Someone",
    senderRoleLabel: byId.get(m.senderUserId) ? roleLabel(byId.get(m.senderUserId)!) : "",
    body: m.body,
    at: m.createdAt,
    mine: m.senderUserId === me.id,
  }));
}

export async function sendMessage(meRef: ChatUser, conversationId: string, rawBody: string) {
  const me = await loadMe(meRef);
  const body = rawBody.trim();
  if (body.length < 1 || body.length > MAX_LENGTH) throw new ChatError("INVALID_BODY", `Write a message of 1 to ${MAX_LENGTH} characters.`);
  if (!canChat(me)) throw new ChatError("FORBIDDEN", "Your access is turned off.");

  const conversation = await loadConversation(me, meRef.householdId, conversationId);
  if (conversation.kind === "DIRECT") {
    const other = await db.user.findUnique({ where: { id: conversation.userAId === me.id ? conversation.userBId! : conversation.userAId! }, select: PERSON_SELECT });
    if (!other || !canChat(other)) throw new ChatError("RECIPIENT_UNAVAILABLE", "That person can no longer receive messages.");
  }

  const message = await db.message.create({ data: { conversationId, senderUserId: me.id, body } });
  await db.conversationRead.upsert({
    where: { userId_conversationId: { userId: me.id, conversationId } },
    create: { userId: me.id, conversationId, lastReadAt: message.createdAt },
    update: { lastReadAt: message.createdAt },
  });
  return { id: message.id };
}

export async function markRead(meRef: ChatUser, conversationId: string) {
  const me = await loadMe(meRef);
  await loadConversation(me, meRef.householdId, conversationId);
  const now = new Date();
  await db.conversationRead.upsert({
    where: { userId_conversationId: { userId: me.id, conversationId } },
    create: { userId: me.id, conversationId, lastReadAt: now },
    update: { lastReadAt: now },
  });
}
