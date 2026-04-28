import type { Request, Response } from "express";
import logger from "../../config/logger.js";
import ApiError from "../../utils/ApiError.js";
import { detectDocKind, prepareDocument } from "./extractors/index.js";
import { extractContract } from "./service.js";

/**
 * Maximum length for the optional user comments field. Picked to be generous
 * enough for an email body but tight enough to keep the prompt bounded —
 * comments get embedded verbatim in the model call and we don't want them
 * blowing past the context window or driving up token costs.
 */
const MAX_COMMENTS_LENGTH = 5000;

/**
 * Parse the required `is_existing_supplier` form field. Multipart bodies
 * always arrive as strings, so accept the common booleanish encodings and
 * reject anything else with a 400 — the field is required by the UI.
 */
function parseExistingSupplier(raw: unknown): boolean {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw ApiError.badRequest(
      "Falta el campo 'is_existing_supplier'. Indica si el proveedor es existente o nuevo.",
    );
  }
  const v = raw.trim().toLowerCase();
  if (v === "true" || v === "1" || v === "yes" || v === "si" || v === "sí") {
    return true;
  }
  if (v === "false" || v === "0" || v === "no") {
    return false;
  }
  throw ApiError.badRequest(
    "Valor inválido para 'is_existing_supplier'. Usa 'true' o 'false'.",
  );
}

function parseComments(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string") {
    throw ApiError.badRequest("'comments' debe ser texto.");
  }
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  if (trimmed.length > MAX_COMMENTS_LENGTH) {
    throw ApiError.badRequest(
      `Los comentarios exceden el máximo permitido (${MAX_COMMENTS_LENGTH} caracteres).`,
    );
  }
  return trimmed;
}

/**
 * POST /api/supplier-intelligence/extract
 *
 * `multipart/form-data` with these fields:
 *   - `file` (required) — the contract document (PDF / Word / Excel).
 *   - `is_existing_supplier` (required) — "true" | "false" toggle from step 1.
 *   - `comments` (optional) — free-form context (e.g. email body excerpts)
 *     forwarded to Claude as additional extraction context.
 *
 * See `uploadMiddleware.ts` for the validation that runs before this handler
 * (size, mime, extension).
 *
 * Response shape is pinned by the product spec:
 *   { success, data, validation, meta }
 * The global error handler emits `{ error: { message, requestId } }` for
 * failures — this controller only deals with the success path.
 */
export async function extractContractHandler(
  req: Request,
  res: Response,
): Promise<void> {
  const file = req.file;
  if (!file) {
    throw ApiError.badRequest(
      "No se recibió ningún archivo. Envía el documento en el campo 'file'.",
    );
  }

  const kind = detectDocKind(file.mimetype, file.originalname);
  if (!kind) {
    // Defensive — the multer fileFilter should have already caught this.
    throw new ApiError(
      415,
      `Tipo de archivo no soportado: ${file.mimetype ?? "desconocido"}.`,
    );
  }

  // Body fields parsed up-front so a bad/missing flag fails fast — before we
  // pay for the Anthropic round-trip.
  const isExistingSupplier = parseExistingSupplier(req.body?.is_existing_supplier);
  const comments = parseComments(req.body?.comments);

  logger.info("Supplier Intelligence extraction started", {
    requestId: req.id,
    filename: file.originalname,
    size: file.size,
    kind,
    isExistingSupplier,
    hasComments: comments !== undefined,
  });

  const prepared = await prepareDocument(kind, file.buffer);
  const { data, validation, model } = await extractContract(prepared, req.id, {
    comments,
    isExistingSupplier,
  });

  logger.info("Supplier Intelligence extraction finished", {
    requestId: req.id,
    filename: file.originalname,
    confianza: data.confianza,
    warnings: validation.warnings.length,
  });

  res.status(200).json({
    success: true,
    data,
    validation,
    meta: {
      filename: file.originalname,
      size_bytes: file.size,
      model,
      processed_at: new Date().toISOString(),
      is_existing_supplier: isExistingSupplier,
    },
  });
}
