import { useSyncExternalStore } from "react";
import type { Role } from "./api";
import { getAlertsUnread, getUnread } from "./api";
import { autoUrgentOn, isSpeaking, speak } from "./speech";

/** What the floating buttons show: unread alerts (and how many are urgent) and unread messages. */
export interface Badges {
  alertsUnread: number;
  alertsUrgent: number;
  messagesUnread: number;
}

let badges: Badges = { alertsUnread: 0, alertsUrgent: 0, messagesUnread: 0 };
const listeners = new Set<() => void>();
let seenUrgentId: string | null | undefined; // undefined = not looked yet this session

function set(next: Badges) {
  if (next.alertsUnread === badges.alertsUnread && next.alertsUrgent === badges.alertsUrgent && next.messagesUnread === badges.messagesUnread) return;
  badges = next;
  listeners.forEach((l) => l());
}

export function resetBadges() {
  seenUrgentId = undefined;
  set({ alertsUnread: 0, alertsUrgent: 0, messagesUnread: 0 });
}

/** Asks the server for the counts. A failed check keeps the old numbers. */
export async function refreshBadges(token: string, role: Role) {
  const staff = role === "CLIENT" || role === "ADMIN";
  const [messages, alerts] = await Promise.all([
    getUnread(token).then((r) => r.unread).catch(() => badges.messagesUnread),
    staff ? getAlertsUnread(token).catch(() => null) : Promise.resolve(null),
  ]);
  set({ alertsUnread: alerts?.unread ?? 0, alertsUrgent: alerts?.urgent ?? 0, messagesUnread: messages });

  if (!alerts) return;
  const newest = alerts.newestUrgent;
  if (seenUrgentId === undefined) {
    // First look after signing in: urgent items already waiting are on the Alerts screen; only later ones are announced.
    seenUrgentId = newest?.id ?? null;
    return;
  }
  if (newest && newest.id !== seenUrgentId && autoUrgentOn() && !isSpeaking()) {
    seenUrgentId = newest.id;
    speak(`Urgent alert. ${newest.message}`);
  } else if (newest && newest.id !== seenUrgentId && !autoUrgentOn()) {
    seenUrgentId = newest.id;
  }
}

export function useBadges(): Badges {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => badges,
    () => badges
  );
}
