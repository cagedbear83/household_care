import type { Role } from "@prisma/client";
import { db } from "../db";
import { notifyRolesNow } from "./household-notify.service";

export interface FeedUser {
  userId: string;
  role: Role;
  householdId: string;
}

export class AlertFeedError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

const visibleTo = (u: FeedUser) => ({ householdId: u.householdId, audience: { has: u.role } });

/** Newest first. The screen decides what to lead with; the order here is just time. */
export async function listAlerts(user: FeedUser, limit = 100) {
  const alerts = await db.alert.findMany({
    where: visibleTo(user),
    orderBy: { createdAt: "desc" },
    take: Math.min(limit, 200),
    include: { reads: { where: { userId: user.userId }, select: { readAt: true } } },
  });
  return alerts.map((a) => ({
    id: a.id,
    type: a.type,
    severity: a.severity,
    title: a.title,
    message: a.message,
    link: a.link,
    createdAt: a.createdAt,
    read: a.reads.length > 0,
    resolved: a.resolvedAt !== null,
  }));
}

/** Counts for the badge, and the newest unread urgent alert (for reading aloud, if the person chose that). */
export async function unreadSummary(user: FeedUser) {
  const unreadWhere = { ...visibleTo(user), reads: { none: { userId: user.userId } } };
  const [unread, urgent, newestUrgent] = await Promise.all([
    db.alert.count({ where: unreadWhere }),
    db.alert.count({ where: { ...unreadWhere, severity: "URGENT" } }),
    db.alert.findFirst({
      where: { ...unreadWhere, severity: "URGENT" },
      orderBy: { createdAt: "desc" },
      select: { id: true, title: true, message: true },
    }),
  ]);
  return { unread, urgent, newestUrgent };
}

export async function markRead(user: FeedUser, alertId: string) {
  const alert = await db.alert.findFirst({ where: { id: alertId, ...visibleTo(user) }, select: { id: true } });
  if (!alert) throw new AlertFeedError("NOT_FOUND", "Alert not found.");
  await db.alertRead.upsert({
    where: { alertId_userId: { alertId, userId: user.userId } },
    create: { alertId, userId: user.userId },
    update: {},
  });
}

export async function markAllRead(user: FeedUser): Promise<number> {
  const unread = await db.alert.findMany({
    where: { ...visibleTo(user), reads: { none: { userId: user.userId } } },
    select: { id: true },
  });
  if (unread.length === 0) return 0;
  await db.alertRead.createMany({ data: unread.map((a) => ({ alertId: a.id, userId: user.userId })), skipDuplicates: true });
  return unread.length;
}

export const MAX_DELIVERY_ATTEMPTS = 3;

/**
 * Texts/emails the people an alert is for, when its type calls for it. Run on
 * a timer: a failed attempt is retried (up to 3 times), and each alert is sent
 * once. Delivery results are also in the outbox table. Alerts whose type
 * already notifies people at the moment it happens are not sent here.
 * Returns how many alerts were delivered in this run.
 */
export async function deliverPendingAlerts(householdId?: string): Promise<number> {
  const pending = await db.alert.findMany({
    where: {
      ...(householdId ? { householdId } : {}),
      notifyPending: true,
      notifiedAt: null,
      notifyAttempts: { lt: MAX_DELIVERY_ATTEMPTS },
      createdAt: { gt: new Date(Date.now() - 24 * 3_600_000) },
    },
    orderBy: { createdAt: "asc" },
    take: 50,
  });

  let done = 0;
  for (const alert of pending) {
    // Claim it: two overlapping runs must not both send.
    const claimed = await db.alert.updateMany({
      where: { id: alert.id, notifiedAt: null, notifyAttempts: alert.notifyAttempts },
      data: { notifyAttempts: { increment: 1 } },
    });
    if (claimed.count !== 1) continue;
    try {
      const result = await notifyRolesNow(alert.householdId, alert.audience, alert.title, alert.message);
      if (result.failed === 0) {
        await db.alert.update({ where: { id: alert.id }, data: { notifiedAt: new Date() } });
        done++;
      }
    } catch {
      // Counted as an attempt; tried again next run until the limit.
    }
  }
  return done;
}
