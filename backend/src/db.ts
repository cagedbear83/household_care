import { PrismaClient } from "@prisma/client";

// Single shared client; tsx watch / serverless cold starts should not spawn
// a new pool per import.
export const db = new PrismaClient();
