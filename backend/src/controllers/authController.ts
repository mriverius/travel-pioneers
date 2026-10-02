import bcrypt from "bcryptjs";
import jwt, { type SignOptions } from "jsonwebtoken";
import type { Request, Response } from "express";
import prisma from "../config/prisma.js";
import logger from "../config/logger.js";
import ApiError from "../utils/ApiError.js";
import type { Role, UserRow } from "../types/domain.js";

const JWT_EXPIRES_IN = (process.env.JWT_EXPIRES_IN ?? "7d") as SignOptions["expiresIn"];

interface PublicUser {
  id: string;
  name: string;
  email: string;
  role: Role;
  views: string[];
  createdAt: string;
  updatedAt: string;
}

interface LoginBody {
  email: string;
  password: string;
}

function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    logger.error("JWT_SECRET is not configured");
    throw ApiError.internal("Server authentication not configured");
  }
  return secret;
}

function signToken(user: PublicUser): string {
  return jwt.sign(
    { sub: user.id, email: user.email, role: user.role },
    getJwtSecret(),
    { expiresIn: JWT_EXPIRES_IN },
  );
}

/** Shape returned to clients — never includes the password hash. */
function toPublicUser(row: UserRow): PublicUser {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    views: row.views,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * POST /auth/login
 * Verifies the password and returns a signed JWT.
 */
export async function login(
  req: Request<unknown, unknown, LoginBody>,
  res: Response,
): Promise<void> {
  const { email, password } = req.body;
  const normalizedEmail = email.trim().toLowerCase();

  logger.info("Login attempt", {
    requestId: req.id,
    email: normalizedEmail,
  });

  const row = (await prisma.user.findUnique({
    where: { email: normalizedEmail },
  })) as UserRow | null;

  // Use the same error message whether the user doesn't exist or the password
  // is wrong — avoids leaking whether an email is registered.
  if (!row) {
    logger.warn("Login failed — unknown email", {
      requestId: req.id,
      email: normalizedEmail,
    });
    throw ApiError.unauthorized("Invalid email or password");
  }

  const matches = await bcrypt.compare(password, row.passwordHash);
  if (!matches) {
    logger.warn("Login failed — bad password", {
      requestId: req.id,
      userId: row.id,
    });
    throw ApiError.unauthorized("Invalid email or password");
  }

  // Best-effort last-login update — never block the response on it.
  prisma.user
    .update({
      where: { id: row.id },
      data: { lastLoginAt: new Date() },
    })
    .catch((updateErr: unknown) => {
      logger.warn("Failed to update lastLoginAt", {
        userId: row.id,
        error:
          updateErr instanceof Error ? updateErr.message : String(updateErr),
      });
    });

  const user = toPublicUser(row);
  const token = signToken(user);

  logger.info("Login successful", {
    requestId: req.id,
    userId: user.id,
  });

  res.json({ user, token });
}
