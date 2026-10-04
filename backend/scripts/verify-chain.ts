import { verifyChainIntegrity } from "../src/services/event.service";
import { db } from "../src/db";

async function main() {
  const households = await db.household.findMany({ select: { id: true } });
  for (const h of households) {
    const result = await verifyChainIntegrity(h.id);
    console.log(h.id, result);
  }
  const events = await db.event.findMany({ orderBy: { serverTimestampUtc: "asc" }, select: { action: true } });
  console.log("event count:", events.length, events.map((e) => e.action));
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
