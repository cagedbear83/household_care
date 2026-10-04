import type { NextFunction, Request, Response } from "express";

/**
 * A small in-memory fixed-window limiter for the public endpoints (sign-in,
 * invitations). It slows guessing; it is per server process and resets on
 * restart, so a real deployment behind several servers should rate-limit at
 * the edge (or with a shared store) as well.
 */
export function rateLimit(options: { max: number; windowMs: number }) {
  const hits = new Map<string, { count: number; resetAt: number }>();

  return (req: Request, res: Response, next: NextFunction) => {
    const now = Date.now();
    if (hits.size > 5000) for (const [key, hit] of hits) if (hit.resetAt < now) hits.delete(key);

    const key = req.ip ?? "unknown";
    const hit = hits.get(key);
    if (!hit || hit.resetAt < now) {
      hits.set(key, { count: 1, resetAt: now + options.windowMs });
      return next();
    }
    if (hit.count >= options.max) {
      res.setHeader("Retry-After", String(Math.ceil((hit.resetAt - now) / 1000)));
      return res.status(429).json({ error: "Too many attempts. Please wait a minute and try again.", code: "RATE_LIMITED" });
    }
    hit.count++;
    next();
  };
}
