/**
 * Authentication middleware.
 *
 * - `requireAuth` verifies the Bearer JWT, reloads the user from the DB
 *   to pick up any role / permission changes since the token was issued,
 *   and attaches `{ id, email, role }` to `req.auth`.
 * - `requireAdmin` is a thin wrapper that 403s anyone who isn't an admin.
 *
 * Both middlewares throw `ApiError` so the global handler formats the
 * response consistently.
 */
import type { RequestHandler } from "express";
import jwt, { type JwtPayload } from "jsonwebtoken";
import ApiError from "../utils/ApiError.js";
import logger from "../config/logger.js";
import prisma from "../config/prisma.js";
import type { Role, UserRow } from "../types/domain.js";

interface TokenPayload extends JwtPayload {
  sub: string;
  email?: string;
  role?: Role;
}

function extractBearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const [scheme, token] = header.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !token) return null;
  return token.trim() || null;
}

function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    logger.error("JWT_SECRET is not configured");
    throw ApiError.internal("Server authentication not configured");
  }
  return secret;
}

function isTokenPayload(value: unknown): value is TokenPayload {
  return (
    typeof value === "object" &&
    value !== null &&
    "sub" in value &&
    typeof (value as { sub: unknown }).sub === "string"
  );
}

export const requireAuth: RequestHandler = async (req, _res, next) => {
  try {
    const token = extractBearerToken(req.headers.authorization);
    if (!token) {
      throw ApiError.unauthorized("Authentication required");
    }

    let decoded: unknown;
    try {
      decoded = jwt.verify(token, getJwtSecret());
    } catch (verifyErr) {
      logger.warn("JWT verification failed", {
        requestId: req.id,
        error:
          verifyErr instanceof Error ? verifyErr.message : String(verifyErr),
      });
      throw ApiError.unauthorized("Invalid or expired session");
    }

    if (!isTokenPayload(decoded)) {
      throw ApiError.unauthorized("Invalid session token");
    }

    // Re-read the user so we catch role changes / deletions performed
    // after this token was minted.
    const user = (await prisma.user.findUnique({
      where: { id: decoded.sub },
      select: { id: true, email: true, role: true },
    })) as Pick<UserRow, "id" | "email" | "role"> | null;

    if (!user) {
      logger.warn("Auth token references a user that no longer exists", {
        requestId: req.id,
        userId: decoded.sub,
      });
      throw ApiError.unauthorized("Session no longer valid");
    }

    req.auth = { id: user.id, email: user.email, role: user.role };
    next();
  } catch (err) {
    next(err);
  }
};

export const requireAdmin: RequestHandler = (req, _res, next) => {
  if (!req.auth) {
    next(ApiError.unauthorized("Authentication required"));
    return;
  }
  if (req.auth.role !== "admin") {
    next(ApiError.forbidden("Admin role required"));
    return;
  }
  next();
};
