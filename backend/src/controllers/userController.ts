import bcrypt from "bcryptjs";
import type { Request, Response } from "express";
import prisma from "../config/prisma.js";
import logger from "../config/logger.js";
import ApiError from "../utils/ApiError.js";
import { generateTempPassword } from "../utils/tempPassword.js";
import {
  isPrismaKnownError,
  type Role,
  type UserRow,
} from "../types/domain.js";

/**
 * Closed set of view ids the frontend knows how to render. Anything
 * outside this list is rejected so we never persist junk view keys.
 */
export const ALLOWED_VIEWS = [
  "supplier-intelligence",
  "resources",
  "settings",
  "users",
] as const;
export type ViewId = (typeof ALLOWED_VIEWS)[number];

export const ROLES = ["admin", "member"] as const;

const SALT_ROUNDS = Number(process.env.BCRYPT_SALT_ROUNDS ?? 12);

interface PublicUser {
  id: string;
  name: string;
  email: string;
  role: Role;
  views: string[];
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
}

function toPublicUser(row: UserRow): PublicUser {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    views: row.views,
    lastLoginAt: row.lastLoginAt ? row.lastLoginAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function uniqueViews(views: string[]): ViewId[] {
  const allowed = new Set<string>(ALLOWED_VIEWS);
  const seen = new Set<string>();
  const out: ViewId[] = [];
  for (const v of views) {
    if (!allowed.has(v) || seen.has(v)) continue;
    seen.add(v);
    out.push(v as ViewId);
  }
  return out;
}

/* -------------------------------- list -------------------------------- */

/** GET /users — list all users, newest first. Admin-only. */
export async function list(req: Request, res: Response): Promise<void> {
  const rows = (await prisma.user.findMany({
    orderBy: { createdAt: "desc" },
  })) as UserRow[];

  logger.info("Users listed", {
    requestId: req.id,
    userId: req.auth?.id,
    count: rows.length,
  });

  res.json({ users: rows.map(toPublicUser) });
}

/* ------------------------------- create ------------------------------- */

interface CreateBody {
  name: string;
  email: string;
  role?: Role;
  views?: string[];
}

/**
 * POST /users — admin creates a user with a server-generated temporary
 * password. The password is returned exactly once in the response; admins
 * are expected to share it with the user out-of-band.
 */
export async function create(
  req: Request<unknown, unknown, CreateBody>,
  res: Response,
): Promise<void> {
  const { name, email, role, views } = req.body;
  const normalizedEmail = email.trim().toLowerCase();
  const normalizedName = name.trim();
  const normalizedRole: Role = role === "admin" ? "admin" : "member";
  const normalizedViews = uniqueViews(views ?? ["supplier-intelligence"]);

  const tempPassword = generateTempPassword(14);
  const passwordHash = await bcrypt.hash(tempPassword, SALT_ROUNDS);

  try {
    const created = (await prisma.user.create({
      data: {
        name: normalizedName,
        email: normalizedEmail,
        passwordHash,
        role: normalizedRole,
        views: normalizedViews,
      },
    })) as UserRow;

    logger.info("User created by admin", {
      requestId: req.id,
      actorId: req.auth?.id,
      userId: created.id,
      role: created.role,
    });

    res.status(201).json({
      user: toPublicUser(created),
      tempPassword,
    });
  } catch (err: unknown) {
    if (isPrismaKnownError(err) && err.code === "P2002") {
      throw ApiError.conflict("An account with that email already exists");
    }
    logger.error("Prisma insert failed in users.create", {
      requestId: req.id,
      error: err instanceof Error ? err.message : String(err),
    });
    throw ApiError.internal("Unable to create user");
  }
}

/* ------------------------------- update ------------------------------- */

interface UpdateBody {
  name?: string;
  role?: Role;
  views?: string[];
}

/**
 * PATCH /users/:id — admin updates name / role / views. Admins can't
 * change their own role here (guards against accidentally locking
 * yourself out); do that via a direct DB operation.
 */
export async function update(
  req: Request<{ id: string }, unknown, UpdateBody>,
  res: Response,
): Promise<void> {
  const { id } = req.params;
  const { name, role, views } = req.body;

  const data: Record<string, unknown> = {};
  if (typeof name === "string") data.name = name.trim();
  if (role === "admin" || role === "member") data.role = role;
  if (Array.isArray(views)) data.views = uniqueViews(views);

  if (Object.keys(data).length === 0) {
    throw ApiError.badRequest("No updatable fields provided");
  }

  if (req.auth?.id === id && typeof data.role === "string" && data.role !== req.auth.role) {
    throw ApiError.badRequest("You cannot change your own role");
  }

  try {
    const updated = (await prisma.user.update({
      where: { id },
      data,
    })) as UserRow;

    logger.info("User updated by admin", {
      requestId: req.id,
      actorId: req.auth?.id,
      userId: id,
      fields: Object.keys(data),
    });

    res.json({ user: toPublicUser(updated) });
  } catch (err: unknown) {
    if (isPrismaKnownError(err)) {
      if (err.code === "P2025") {
        throw ApiError.notFound("User not found");
      }
      if (err.code === "P2002") {
        throw ApiError.conflict("An account with that email already exists");
      }
    }
    logger.error("Prisma update failed in users.update", {
      requestId: req.id,
      userId: id,
      error: err instanceof Error ? err.message : String(err),
    });
    throw ApiError.internal("Unable to update user");
  }
}

/* ------------------------------- remove ------------------------------- */

/** DELETE /users/:id — admin deletes a user. Self-delete is blocked. */
export async function remove(
  req: Request<{ id: string }>,
  res: Response,
): Promise<void> {
  const { id } = req.params;
  if (req.auth?.id === id) {
    throw ApiError.badRequest("You cannot delete your own account here");
  }

  try {
    await prisma.user.delete({ where: { id } });
    logger.info("User deleted by admin", {
      requestId: req.id,
      actorId: req.auth?.id,
      userId: id,
    });
    res.status(204).end();
  } catch (err: unknown) {
    if (isPrismaKnownError(err) && err.code === "P2025") {
      throw ApiError.notFound("User not found");
    }
    logger.error("Prisma delete failed in users.remove", {
      requestId: req.id,
      userId: id,
      error: err instanceof Error ? err.message : String(err),
    });
    throw ApiError.internal("Unable to delete user");
  }
}
