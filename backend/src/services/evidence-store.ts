import { createHash } from "crypto";
import fs from "fs/promises";
import path from "path";

/**
 * Where evidence bytes live. This local-disk implementation is for
 * development: files are content-addressed and written exactly once, and an
 * existing file is never overwritten. For production, replace the two
 * functions below with an object store that enforces retention at the
 * storage layer (for example S3 Object Lock in compliance mode); the
 * `storageRef` strings stored in the database are the only coupling.
 */
const ROOT = process.env.EVIDENCE_DIR ?? path.join(__dirname, "..", "..", "storage", "evidence");

function resolveRef(ref: string): string {
  if (!ref.startsWith("local:")) throw new Error("Unknown storage reference");
  const full = path.resolve(ROOT, ref.slice("local:".length));
  if (!full.startsWith(path.resolve(ROOT) + path.sep)) throw new Error("Storage reference escapes the evidence directory");
  return full;
}

export function evidenceRefs(householdId: string, contentHash: string) {
  return {
    original: `local:${householdId}/${contentHash}.orig`,
    viewer: `local:${householdId}/${contentHash}.viewer.jpg`,
  };
}

/** Writes the bytes if absent. Identical content hashes to the same name, so
 * an existing file is the same bytes and is left untouched. */
export async function writeOnce(ref: string, bytes: Buffer): Promise<void> {
  const full = resolveRef(ref);
  await fs.mkdir(path.dirname(full), { recursive: true });
  try {
    await fs.writeFile(full, bytes, { flag: "wx", mode: 0o444 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
}

export async function readRef(ref: string): Promise<Buffer> {
  return fs.readFile(resolveRef(ref));
}

/**
 * Removes one stored file. Used only when a photo reaches the end of its fixed period (see photo-retention.ts);
 * nothing else deletes evidence. A file that is already gone is not an error.
 */
export async function removeRef(ref: string): Promise<void> {
  await fs.rm(resolveRef(ref), { force: true });
}

export const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/** Test helper: removes everything stored for one household. */
export async function removeHouseholdFiles(householdId: string): Promise<void> {
  const dir = path.resolve(ROOT, householdId);
  if (!dir.startsWith(path.resolve(ROOT) + path.sep)) return;
  await fs.rm(dir, { recursive: true, force: true });
}
