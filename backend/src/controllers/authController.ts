import bcrypt from "bcryptjs";
import jwt, { type SignOptions } from "jsonwebtoken";
import type { Request, Response } from "express";
import prisma from "../config/prisma.js";
import logger from "../config/logger.js";
import ApiError from "../utils/ApiError.js";
import { isPrismaKnownError, type Role, type UserRow } from "../types/domain.js";

const SALT_ROUNDS = Number(process.env.BCRYPT_SALT_ROUNDS ?? 12);
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

interface RegisterBody {
  name: string;
  email: string;
  password: string;
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
 * GET /auth/check-email?email=<address>
 * Lightweight availability check used by the registration form so users get
 * immediate feedback instead of waiting for submit-time 409. Returns the
 * normalized email alongside an `available` flag; never reveals anything
 * beyond that.
 *
 * NOTE: This endpoint leaks whether a given address is registered, which is
 * the same signal the `register` endpoint already leaks via 409. It is
 * rate-limited at the router level for the same reason.
 */
export async function checkEmail(
  req: Request<unknown, unknown, unknown, { email?: string }>,
  res: Response,
): Promise<void> {
  const raw = (req.query.email ?? "").toString();
  const normalizedEmail = raw.trim().toLowerCase();

  if (!normalizedEmail) {
    throw ApiError.badRequest("Email is required");
  }

  const existing = await prisma.user.findUnique({
    where: { email: normalizedEmail },
    select: { id: true },
  });

  res.json({ email: normalizedEmail, available: existing === null });
}

/**
 * POST /auth/register
 * Creates a new user with a bcrypt-hashed password.
 */
export async function register(
  req: Request<unknown, unknown, RegisterBody>,
  res: Response,
): Promise<void> {
  const { name, email, password } = req.body;
  const normalizedEmail = email.trim().toLowerCase();

  logger.info("Registration attempt", {
    requestId: req.id,
    email: normalizedEmail,
  });

  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

  try {
    const created = (await prisma.user.create({
      data: {
        name: name.trim(),
        email: normalizedEmail,
        passwordHash,
        role: "member",
        views: ["supplier-intelligence"],
      },
    })) as UserRow;

    const user = toPublicUser(created);
    const token = signToken(user);

    logger.info("Registration successful", {
      requestId: req.id,
      userId: user.id,
      email: user.email,
    });

    res.status(201).json({ user, token });
  } catch (err: unknown) {
    // P2002 = Prisma unique-constraint violation.
    if (isPrismaKnownError(err) && err.code === "P2002") {
      throw ApiError.conflict("An account with that email already exists");
    }
    logger.error("Prisma insert failed during register", {
      requestId: req.id,
      error: err instanceof Error ? err.message : String(err),
    });
    throw ApiError.internal("Unable to create account");
  }
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
