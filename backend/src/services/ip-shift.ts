import { db } from "../db";

/** The IP's shift that is checked in and still inside its authorized window, if any. */
export function findOpenShiftForIp(userId: string, householdId: string) {
  return db.scheduledShift.findFirst({
    where: {
      ipUserId: userId,
      householdId,
      supersededAt: null,
      checkInEventId: { not: null },
      checkOutEventId: null,
      authorizationClosedAt: null,
      OR: [{ authorizedEndUtc: null }, { authorizedEndUtc: { gt: new Date() } }],
    },
  });
}
