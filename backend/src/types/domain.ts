/**
 * Domain types — the shape of a user as it lives in our database.
 *
 * This mirrors `prisma/schema.prisma`. Prisma generates its own typed
 * models, but we keep a hand-written mirror here so the project compiles
 * even before `prisma generate` has been run, and so we can reference
 * these types in places where pulling in the full Prisma namespace is
 * overkill.
 */

export type Role = "admin" | "member";

export interface UserRow {
  id: string;
  name: string;
  email: string;
  passwordHash: string;
  role: Role;
  views: string[];
  lastLoginAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Narrow a caught unknown error to a Prisma known-request error without
 * relying on `instanceof` (which requires the generated client to be
 * present at compile time).
 */
export function isPrismaKnownError(
  err: unknown,
): err is { code: string; message: string; meta?: Record<string, unknown> } {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    typeof (err as { code: unknown }).code === "string" &&
    (err as { code: string }).code.startsWith("P")
  );
}
