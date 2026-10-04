import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { hashPassword } from "../src/auth/password";

const db = new PrismaClient();

// Every-visit checklist items from IP-App-Specification.md ("Master every-visit checklist").
// Attendance check-in/out and the safety walkthroughs are handled by the
// shift/authorization flow itself, not as TaskTemplate rows.
const VISIT_TASKS: Array<{ group: string; title: string; instructions: string; requiresPhoto?: boolean }> = [
  { group: "Safety", title: "Check walking paths", instructions: "Clear agreed 36-inch paths and return objects to known locations." },
  { group: "Living room", title: "Gather cups and dishes", instructions: "Take all dirty dishes to the kitchen." },
  { group: "Living room", title: "Gather loose trash", instructions: "Collect bottles, wrappers and approved mail packaging." },
  { group: "Living room", title: "Tidy sitting area", instructions: "Pick up floor items, straighten immediate sitting area and restore familiar object locations." },
  { group: "Kitchen", title: "Gather remaining dishes", instructions: "Include all dirty dishes throughout the apartment." },
  { group: "Kitchen", title: "Hand-wash dishes", instructions: "Wash all dirty dishes; there is no dishwasher." },
  { group: "Kitchen", title: "Put clean dishes away", instructions: "Dry as necessary and return to designated storage." },
  { group: "Kitchen", title: "Clean sink", instructions: "Leave sink/work area clean; requires a fresh in-app photo before completing.", requiresPhoto: true },
  { group: "Kitchen", title: "Wipe counters", instructions: "Separate task beside the dish tasks." },
  { group: "Kitchen", title: "Wipe stove", instructions: "Clean safely after surfaces cool." },
  { group: "Kitchen", title: "Wipe table", instructions: "Separate task beside the dish tasks." },
  { group: "Kitchen", title: "Check and store leftovers", instructions: "Put away food remaining from meals; ask before disposing of questionable food." },
  { group: "Kitchen", title: "Wipe microwave", instructions: "Clean interior spills and accessible surfaces." },
  { group: "Kitchen", title: "Sweep floor", instructions: "Each visit." },
  { group: "Meals", title: "Breakfast assistance", instructions: "Ask what he would like; prepare, serve, record, store leftovers, clean up." },
  { group: "Meals", title: "Lunch assistance", instructions: "Ask what he would like; prepare, serve, record, store leftovers, clean up." },
  { group: "Trash", title: "Check all bins", instructions: "Kitchen, living room and bathroom; include bedroom bin if present." },
  { group: "Trash", title: "Combine and remove trash", instructions: "Kitchen trash must leave the apartment before shift end regardless of fullness." },
  { group: "Trash", title: "Replace liners", instructions: "Immediately replace liners in emptied cans." },
  { group: "Trash", title: "Break down boxes", instructions: "As present; no separate recycling workflow." },
  { group: "Bathroom", title: "Wipe sink", instructions: "Every visit." },
  { group: "Bathroom", title: "Wipe mirror", instructions: "Every visit." },
  { group: "Bathroom", title: "Empty/check trash", instructions: "Apply household consolidation rule and replace any removed liner." },
  { group: "Bathroom", title: "Pick up used towels", instructions: "Place in laundry; return clean towels to shelving outside bathroom." },
  { group: "Bathroom", title: "Refill/check toilet paper", instructions: "Verify available roll and accessible supply before finishing." },
  { group: "Bedroom", title: "Pick up clothes", instructions: "Put in hamper or established storage." },
  { group: "Bedroom", title: "Make bed", instructions: "Every visit; remake after changing sheets." },
  { group: "Bedroom", title: "Clean bedside surfaces", instructions: "Preserve familiar locations of personal items." },
  { group: "Floors", title: "Vacuum living room", instructions: "Each visit, including rugs." },
  { group: "Floors", title: "Vacuum bedroom", instructions: "Each visit." },
  { group: "Supplies", title: "Check household supplies", instructions: "Toilet paper, paper towels, trash bags, dish soap, detergent, cleaning supplies and toiletries." },
  { group: "Safety", title: "Final walkthrough", instructions: "Recheck paths, known object locations, accessible food/drinks, kitchen trash and unresolved tasks." },
];

async function main() {
  const lat = Number(process.env.APARTMENT_LAT ?? "0");
  const lng = Number(process.env.APARTMENT_LNG ?? "0");

  const household = await db.household.create({
    data: {
      name: "Primary household",
      timezone: process.env.HOUSEHOLD_TIMEZONE ?? "America/Chicago",
      weeklyHourCapMinutes: Number(process.env.WEEKLY_HOUR_CAP ?? "36") * 60,
      apartmentLat: lat,
      apartmentLng: lng,
      geofenceRadiusMeters: Number(process.env.GEOFENCE_RADIUS_METERS ?? "60.96"),
    },
  });

  const [admin, client, ip] = await Promise.all([
    db.user.create({
      data: {
        householdId: household.id,
        role: "ADMIN",
        name: "Admin",
        email: "admin@example.com",
        passwordHash: await hashPassword("ChangeMe123!"),
      },
    }),
    db.user.create({
      data: {
        householdId: household.id,
        role: "CLIENT",
        name: "Client",
        email: "client@example.com",
        passwordHash: await hashPassword("ChangeMe123!"),
      },
    }),
    db.user.create({
      data: {
        householdId: household.id,
        role: "IP",
        name: "IP",
        email: "ip@example.com",
        passwordHash: await hashPassword("ChangeMe123!"),
      },
    }),
  ]);

  await db.taskTemplate.createMany({
    data: VISIT_TASKS.map((t, i) => ({
      householdId: household.id,
      groupName: t.group,
      title: t.title,
      instructions: t.instructions,
      frequency: "VISIT" as const,
      requiresPhoto: Boolean(t.requiresPhoto),
      sortOrder: i,
    })),
  });

  // A shift scheduled for "right now" so the mobile app has something to
  // check into immediately during development.
  const now = new Date();
  const start = new Date(now.getTime() - 5 * 60_000);
  const end = new Date(now.getTime() + 6 * 60 * 60_000);
  const localDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: household.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);

  await db.scheduledShift.create({
    data: {
      householdId: household.id,
      ipUserId: ip.id,
      localDate,
      scheduledStartUtc: start,
      scheduledEndUtc: end,
      status: "SCHEDULED",
      createdBy: admin.id,
    },
  });

  console.log("Seeded household", household.id);
  console.log("Login with:");
  console.log("  admin@example.com / ChangeMe123!");
  console.log("  client@example.com / ChangeMe123!");
  console.log("  ip@example.com / ChangeMe123!");
  console.log(`Apartment coords are placeholder (${lat}, ${lng}) — set APARTMENT_LAT/APARTMENT_LNG in .env before testing geofencing for real.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
