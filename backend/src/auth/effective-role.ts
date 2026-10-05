import type { Role, User } from "@prisma/client";

/**
 * The primary family member has the same access as the client, everywhere.
 * That is done in one place: the role the rest of the server sees for them is
 * CLIENT. What is written in the audit log is still the person's own id and
 * name, so it always shows who actually acted.
 */
export const effectiveRole = (user: Pick<User, "role" | "isPrimaryFamily">): Role =>
  user.role === "FAMILY" && user.isPrimaryFamily ? "CLIENT" : user.role;

/** What a signed-in app is told about the person (the same shape for login, sign-up and /me). */
export const sessionUser = (user: Pick<User, "id" | "name" | "role" | "isPrimaryFamily" | "householdId">) => ({
  id: user.id,
  name: user.name,
  role: effectiveRole(user),
  householdId: user.householdId,
  primaryFamily: user.role === "FAMILY" && user.isPrimaryFamily,
});
