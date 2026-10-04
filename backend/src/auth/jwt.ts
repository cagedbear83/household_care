import jwt from "jsonwebtoken";
import type { Role } from "@prisma/client";
import { env } from "../env";

export interface AuthTokenPayload {
  userId: string;
  householdId: string;
  role: Role;
  /** Issued-at (seconds), added by the signer; used to reject sessions older than a password reset. */
  iat?: number;
}

export function signAuthToken(payload: AuthTokenPayload): string {
  const options: jwt.SignOptions = { expiresIn: env.JWT_EXPIRES_IN as jwt.SignOptions["expiresIn"] };
  return jwt.sign(payload, env.JWT_SECRET, options);
}

export function verifyAuthToken(token: string): AuthTokenPayload {
  return jwt.verify(token, env.JWT_SECRET) as AuthTokenPayload & jwt.JwtPayload;
}
