import path from "path";
import fs from "fs";
import EmbeddedPostgres from "embedded-postgres";

/**
 * Runs a real PostgreSQL 18 binary as a plain user process (not a Windows
 * service, no admin rights needed) for local development. Production should
 * point DATABASE_URL at a real managed Postgres instead — this exists only
 * because this environment has no Docker/Postgres and no admin rights to
 * install one as a service.
 */
const DB_NAME = "household_care";
const PORT = 55432;
const PASSWORD = "devlocalpw123";
const DATA_DIR = path.join(__dirname, "..", ".pgdata");

const pg = new EmbeddedPostgres({
  databaseDir: DATA_DIR,
  port: PORT,
  user: "postgres",
  password: PASSWORD,
  persistent: true,
});

async function main() {
  const alreadyInitialised = fs.existsSync(path.join(DATA_DIR, "PG_VERSION"));
  if (!alreadyInitialised) {
    console.log("Initializing local dev Postgres cluster...");
    await pg.initialise();
  }

  await pg.start();

  if (!alreadyInitialised) {
    await pg.createDatabase(DB_NAME);
  }

  const url = `postgresql://postgres:${PASSWORD}@localhost:${PORT}/${DB_NAME}?schema=public`;
  console.log(`\nLocal dev Postgres is running on port ${PORT}.`);
  console.log(`Put this in backend/.env:\n  DATABASE_URL="${url}"\n`);
  console.log("Press Ctrl+C to stop.");

  const shutdown = async () => {
    console.log("\nStopping local dev Postgres...");
    await pg.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
