import type { ContactChannel } from "@prisma/client";
import nodemailer from "nodemailer";
import { db } from "../db";

/**
 * Sends an email or text message and records the result.
 *
 * Providers are chosen from the environment, never from source:
 *   Email: SMTP_URL (e.g. smtps://user:pass@smtp.example.com) and EMAIL_FROM
 *   SMS:   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM
 * With neither configured and NODE_ENV not "production", messages go to the
 * development outbox (the OutboundMessage table and the console) so the whole
 * invite flow can be tried without any account. In production an unconfigured
 * channel fails loudly instead of silently pretending to send.
 *
 * The SMTP and Twilio paths below have NOT been exercised against live
 * services from this repository; test them with real credentials before relying on them.
 */
export interface OutgoingMessage {
  householdId: string;
  channel: ContactChannel;
  to: string;
  subject?: string;
  body: string;
  kind: "invite" | "verification" | "password_reset" | "alert";
}

export const devOutboxEnabled = () => process.env.NODE_ENV !== "production" && process.env.ENABLE_DEV_OUTBOX !== "false";

async function viaSmtp(m: OutgoingMessage): Promise<void> {
  const transport = nodemailer.createTransport(process.env.SMTP_URL!);
  await transport.sendMail({ from: process.env.EMAIL_FROM ?? "Household Care <no-reply@localhost>", to: m.to, subject: m.subject, text: m.body });
}

async function viaTwilio(m: OutgoingMessage): Promise<void> {
  const sid = process.env.TWILIO_ACCOUNT_SID!;
  const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${sid}:${process.env.TWILIO_AUTH_TOKEN}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ To: m.to, From: process.env.TWILIO_FROM!, Body: m.body }),
  });
  if (!response.ok) throw new Error(`Twilio responded ${response.status}`);
}

export async function sendMessage(m: OutgoingMessage): Promise<{ delivered: boolean; provider: string }> {
  const smtp = m.channel === "EMAIL" && Boolean(process.env.SMTP_URL);
  const twilio = m.channel === "SMS" && Boolean(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM);

  let provider = smtp ? "smtp" : twilio ? "twilio" : "dev-outbox";
  let error: string | null = null;

  try {
    if (smtp) await viaSmtp(m);
    else if (twilio) await viaTwilio(m);
    else if (devOutboxEnabled()) {
      // eslint-disable-next-line no-console
      console.log(`\n[DEV OUTBOX ${m.channel}] to ${m.to}\n${m.subject ? `Subject: ${m.subject}\n` : ""}${m.body}\n`);
    } else {
      provider = "none";
      throw new Error(`No ${m.channel === "EMAIL" ? "email" : "SMS"} provider is configured`);
    }
  } catch (err) {
    error = err instanceof Error ? err.message : "Unknown delivery error";
  }

  await db.outboundMessage.create({
    data: {
      householdId: m.householdId,
      channel: m.channel,
      toAddress: m.to,
      subject: m.subject ?? null,
      body: m.body,
      kind: m.kind,
      status: error ? "FAILED" : "SENT",
      provider,
      error,
    },
  });
  return { delivered: !error, provider };
}
