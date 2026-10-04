import sharp from "sharp";
import { sha256 } from "./evidence-store";

export class EvidenceRejectedError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

const MAX_BYTES = 8 * 1024 * 1024;
const MIN_DIMENSION = 100;

export interface PreparedImage {
  /** The original bytes exactly as the camera produced them (hashed and kept untouched). */
  bytes: Buffer;
  /** A re-encoded copy with embedded metadata (GPS position, device details) removed, for viewers. */
  viewer: Buffer;
  contentHash: string;
  mimeType: "image/jpeg" | "image/png";
}

/**
 * Checks that an upload really is a usable JPEG or PNG photo and prepares the
 * two stored copies. Shared by task photos and food photos so both get the same
 * checks. Throws EvidenceRejectedError with a code the caller can show.
 */
export async function prepareImage(imageBase64: string): Promise<PreparedImage> {
  const bytes = Buffer.from(imageBase64, "base64");
  if (bytes.length === 0 || bytes.length > MAX_BYTES) {
    throw new EvidenceRejectedError("BAD_SIZE", "The photo is empty or larger than 8 MB.");
  }
  const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const isPng = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  if (!isJpeg && !isPng) {
    throw new EvidenceRejectedError("UNSUPPORTED_IMAGE", "Only JPEG or PNG photos are accepted.");
  }

  let viewer: Buffer;
  try {
    const meta = await sharp(bytes).metadata();
    if (!meta.width || !meta.height || Math.min(meta.width, meta.height) < MIN_DIMENSION) {
      throw new EvidenceRejectedError("IMAGE_TOO_SMALL", "The photo is too small to be useful.");
    }
    // Re-encoding applies the camera orientation and drops the metadata.
    viewer = await sharp(bytes).rotate().jpeg({ quality: 85 }).toBuffer();
  } catch (err) {
    if (err instanceof EvidenceRejectedError) throw err;
    throw new EvidenceRejectedError("INVALID_IMAGE", "That file could not be read as a photo.");
  }

  return { bytes, viewer, contentHash: sha256(bytes), mimeType: isPng ? "image/png" : "image/jpeg" };
}
