import type { ErrorRequestHandler, RequestHandler } from "express";
import logger from "../config/logger.js";
import ApiError from "../utils/ApiError.js";

/** 404 handler — runs when no route matches. */
export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(ApiError.notFound(`Route ${req.method} ${req.originalUrl} not found`));
};

/**
 * Global error handler. Converts any error into a consistent JSON response
 * and logs at the appropriate level (warn for 4xx, error for 5xx).
 */
export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  const isApiError = err instanceof ApiError;
  const statusCode = isApiError ? err.statusCode : 500;
  const isServerError = statusCode >= 500;

  const logPayload: Record<string, unknown> = {
    method: req.method,
    url: req.originalUrl,
    requestId: req.id,
    statusCode,
  };
  if (isApiError && err.details !== undefined) {
    logPayload.details = err.details;
  }

  const message = err instanceof Error ? err.message : String(err);

  if (isServerError) {
    logger.error(message, {
      ...logPayload,
      stack: err instanceof Error ? err.stack : undefined,
    });
  } else {
    logger.warn(message, logPayload);
  }

  res.status(statusCode).json({
    error: {
      message: isServerError ? "Internal server error" : message,
      ...(isApiError && err.details !== undefined ? { details: err.details } : {}),
      requestId: req.id,
    },
  });
};
