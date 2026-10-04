import type { NextFunction, Request, Response } from "express";
import type { Role } from "@prisma/client";
import { verifyAuthToken } from "./jwt";
import { db } from "../db";

export interface AuthenticatedRequest extends Request {
  auth?: {
    userId: string;
    householdId: string;
    role: Role;
    /** Family only: the client approved this person to see photos and times. */
    canViewTimestamps: boolean;
  };
}

/**
 * Verifies the bearer token AND re-checks the user's active/revoked status
 * against the database on every request. The spec requires revoked family
 * (and any deactivated) accounts to lose API access immediately — trusting a
 * previously-issued JWT's claims without this lookup would let a revoked
 * account keep working until the token expires.
 */
export async function requireAuth(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing bearer token" });
  }

  try {
    const token = header.slice("Bearer ".length);
    const payload = verifyAuthToken(token);

    const user = await db.user.findUnique({ where: { id: payload.userId } });
    if (!user || !user.active || user.accessRevokedAt) {
      return res.status(401).json({ error: "Account is not active" });
    }
    // A password reset signs out every session issued before it (compared in whole seconds, erring on the side of signing out).
    if (user.tokensValidAfter && (payload.iat ?? 0) <= Math.floor(user.tokensValidAfter.getTime() / 1000)) {
      return res.status(401).json({ error: "Your session has ended. Please sign in again." });
    }

    req.auth = { userId: user.id, householdId: user.householdId, role: user.role, canViewTimestamps: user.canViewTimestamps };
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

export function requireRole(...roles: Role[]) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (!req.auth || !roles.includes(req.auth.role)) {
      return res.status(403).json({ error: "Not authorized for this action" });
    }
    next();
  };
}
