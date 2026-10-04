import { db } from "../src/db";
import { raiseAlert } from "../src/services/alert.service";

// Dev only: a couple of alerts so the Alerts screen has something to show.
async function main() {
  const h = await db.household.findFirstOrThrow({ where: { name: "Primary household" } });
  const ip = await db.user.findFirstOrThrow({ where: { householdId: h.id, role: "IP" } });
  const stamp = Date.now();
  await db.$transaction(async (tx) => {
    await raiseAlert(tx, {
      householdId: h.id, actorUserId: ip.id, actorRole: "IP", type: "food_hazard",
      message: "Pat reports a food hazard: a leaking carton of milk in the refrigerator. It was thrown away.", dedupeKey: `demo-hazard-${stamp}`,
    });
    await raiseAlert(tx, {
      householdId: h.id, actorUserId: ip.id, actorRole: "IP", type: "low_supply",
      message: "Dish soap is running low. It was added to the shopping list.", dedupeKey: `demo-soap-${stamp}`,
    });
  });
  console.log("raised");
  await db.$disconnect();
}
void main();
