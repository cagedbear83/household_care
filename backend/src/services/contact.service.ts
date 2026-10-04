import { z } from "zod";

/** Lower-cased, trimmed email, or null if it is not a plausible address. */
export function normalizeEmail(input: string): string | null {
  const value = input.trim().toLowerCase();
  return z.string().email().max(254).safeParse(value).success ? value : null;
}

/**
 * Phone numbers are stored in E.164 (+<country><number>). A bare 10-digit
 * number, or 11 digits starting with 1, is treated as a US/Canada number
 * (the household is in America/Chicago); anything else must start with "+".
 */
export function normalizePhone(input: string): string | null {
  const trimmed = input.trim();
  const digits = trimmed.replace(/\D/g, "");
  if (trimmed.startsWith("+")) return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

/** "ann***@gmail.com" / "+1•••••••0123": enough to recognize, not enough to harvest. */
export function maskContact(channel: "EMAIL" | "SMS", value: string): string {
  if (channel === "EMAIL") {
    const [local = "", domain = ""] = value.split("@");
    return `${local.slice(0, 2)}***@${domain}`;
  }
  return `${value.slice(0, 2)}${"•".repeat(Math.max(0, value.length - 6))}${value.slice(-4)}`;
}

/** A person typing "email or phone": decide which it is and normalize it. */
export function parseIdentifier(input: string): { channel: "EMAIL" | "SMS"; value: string } | null {
  if (input.includes("@")) {
    const email = normalizeEmail(input);
    return email ? { channel: "EMAIL", value: email } : null;
  }
  const phone = normalizePhone(input);
  return phone ? { channel: "SMS", value: phone } : null;
}
