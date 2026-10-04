import { db } from "../src/db";
import { checkIn } from "../src/services/authorization.service";
import { approveTask } from "../src/services/review.service";
import { completeTask } from "../src/services/task.service";
import { localDateString } from "../src/services/time.service";

// Dev only: a visit for today, checked in, with a couple of tasks done, so the screens have something to show.
async function main() {
  const h = await db.household.findFirstOrThrow({ where: { name: "Primary household" } });
  const ip = await db.user.findFirstOrThrow({ where: { householdId: h.id, role: "IP" } });
  const client = await db.user.findFirstOrThrow({ where: { householdId: h.id, role: "CLIENT" } });
  const now = new Date();
  const today = localDateString(now, h.timezone);

  let shift = await db.scheduledShift.findFirst({ where: { householdId: h.id, ipUserId: ip.id, localDate: today, supersededAt: null, status: "SCHEDULED" } });
  if (!shift) {
    shift = await db.scheduledShift.create({
      data: {
        householdId: h.id, ipUserId: ip.id, localDate: today,
        scheduledStartUtc: new Date(now.getTime() - 20 * 60_000), scheduledEndUtc: new Date(now.getTime() + 8 * 3_600_000),
        status: "SCHEDULED", createdBy: ip.id,
      },
    });
  }
  if (!shift.checkInEventId) await checkIn({ shiftId: shift.id, ipUserId: ip.id, lat: h.apartmentLat, lng: h.apartmentLng, accuracyMeters: 5 });

  const tasks = await db.taskInstance.findMany({ where: { shiftId: shift.id, requiresPhotoSnapshot: false, state: "NOT_STARTED" }, orderBy: { createdAt: "asc" }, take: 3 });
  for (const t of tasks.slice(0, 3)) await completeTask(t.id, ip.id);
  if (tasks[0]) await approveTask({ userId: client.id, householdId: h.id }, tasks[0].id);
  console.log(`ready: visit ${today}, ${tasks.length} tasks done, first approved`);
  await db.$disconnect();
}
void main();
