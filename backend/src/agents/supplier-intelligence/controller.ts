import type { Request, Response } from "express";
import logger from "../../config/logger.js";
import ApiError from "../../utils/ApiError.js";
import { detectDocKind, prepareDocument } from "./extractors/index.js";
import { extractContract } from "./service.js";

/**
 * POST /api/supplier-intelligence/extract
 *
 * `multipart/form-data` with a single `file` field. See `uploadMiddleware.ts`
 * for the validation that runs before this handler (size, mime, extension).
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

  logger.info("Supplier Intelligence extraction started", {
    requestId: req.id,
    filename: file.originalname,
    size: file.size,
    kind,
  });

  const prepared = await prepareDocument(kind, file.buffer);
  const { data, validation, model } = await extractContract(prepared, req.id);

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
    },
  });
}
