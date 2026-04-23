import type { ErrorRequestHandler } from "express";
import logger from "../../config/logger.js";
import ApiError from "../../utils/ApiError.js";

/**
 * Map HTTP status → machine-readable code. Kept in one place so the frontend
 * can branch on `error.code` rather than parsing prose.
 */
const CODE_FOR_STATUS: Record<number, string> = {
  400: "bad_request",
  401: "unauthorized",
  403: "forbidden",
  404: "not_found",
  413: "file_too_large",
  415: "unsupported_file_type",
  422: "validation_failed",
  429: "rate_limited",
  500: "internal_error",
  502: "upstream_unavailable",
};

/**
 * Scoped error handler for the Supplier Intelligence agent. Emits the
 * envelope shape the product spec pins:
 *
 *   { success: false, error: { code, message } }
 *
 * …without touching the global handler, which other routes still rely on
 * for their existing `{ error: { message } }` format.
 */
export const supplierIntelligenceErrorHandler: ErrorRequestHandler = (
  err,
  req,
  res,
  _next,
) => {
  const isApiError = err instanceof ApiError;
  const statusCode = isApiError ? err.statusCode : 500;
  const isServerError = statusCode >= 500;
  const message = err instanceof Error ? err.message : String(err);

  const logPayload: Record<string, unknown> = {
    method: req.method,
    url: req.originalUrl,
    requestId: req.id,
    statusCode,
  };
  if (isApiError && err.details !== undefined) {
    logPayload.details = err.details;
  }

  if (isServerError) {
    logger.error(message, {
      ...logPayload,
      stack: err instanceof Error ? err.stack : undefined,
    });
  } else {
    logger.warn(message, logPayload);
  }

  const code = CODE_FOR_STATUS[statusCode] ?? "internal_error";
  const clientMessage = isServerError && !isApiError
    ? "Error interno del servidor"
    : message;

  res.status(statusCode).json({
    success: false,
    error: {
      code,
      message: clientMessage,
      ...(isApiError && err.details !== undefined ? { details: err.details } : {}),
      requestId: req.id,
    },
  });
};
