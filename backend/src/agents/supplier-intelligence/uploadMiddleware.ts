import type { NextFunction, Request, RequestHandler, Response } from "express";
import multer, { MulterError } from "multer";
import ApiError from "../../utils/ApiError.js";
import { detectDocKind } from "./extractors/index.js";

export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024; // 20 MB per spec

/**
 * Maximum number of documents allowed in a single extract request. Picked to
 * keep the combined Claude payload under the API's per-message size limit
 * (~32 MB for native PDF blocks) and to bound the prompt token budget when
 * mixing PDFs with extracted Word/Excel text.
 */
export const MAX_UPLOAD_FILES = 10;

/**
 * We use `memoryStorage` intentionally:
 *   - never hits disk (no cleanup, no tmp-file leaks),
 *   - contracts are small (<20 MB) so RAM is not a concern,
 *   - lets us hand the raw buffer directly to Claude / mammoth / sheetjs.
 */
const storage = multer.memoryStorage();

/**
 * Gate uploads at the multer layer using a MIME+extension detector. Rejects
 * as early as possible so we never buffer megabytes of an unsupported file.
 *
 * Note: multer calls `cb(err, false)` on rejection — we pass a plain Error
 * and translate to ApiError in the outer middleware so status codes are
 * consistent with the rest of the API.
 */
const fileFilter: multer.Options["fileFilter"] = (_req, file, cb) => {
  const kind = detectDocKind(file.mimetype, file.originalname);
  if (!kind) {
    cb(
      new ApiError(
        415,
        `Tipo de archivo no soportado: ${file.mimetype ?? "desconocido"}. ` +
          "Solo se aceptan PDF, Word (.docx, .doc) y Excel (.xlsx, .xls).",
      ),
    );
    return;
  }
  cb(null, true);
};

/**
 * Accept multiple files under a single `files` field. Multer enforces the
 * per-file size limit and the per-request file count; anything bigger or
 * a different field name is rejected before the controller runs.
 */
const uploader = multer({
  storage,
  fileFilter,
  limits: { fileSize: MAX_UPLOAD_BYTES, files: MAX_UPLOAD_FILES },
}).array("files", MAX_UPLOAD_FILES);

/**
 * Thin wrapper that runs multer and normalizes its error taxonomy:
 *   - file too large           → 413
 *   - too many files           → 400
 *   - unexpected field name    → 400 ("expected field 'files'")
 *   - unsupported type         → 415 (raised by fileFilter above)
 *   - everything else          → delegated to global error handler
 */
export const handleContractUpload: RequestHandler = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  uploader(req, res, (err: unknown) => {
    if (!err) {
      next();
      return;
    }
    if (err instanceof MulterError) {
      if (err.code === "LIMIT_FILE_SIZE") {
        next(
          new ApiError(
            413,
            `Cada archivo debe pesar 20 MB o menos.`,
          ),
        );
        return;
      }
      if (err.code === "LIMIT_FILE_COUNT") {
        next(
          ApiError.badRequest(
            `Demasiados archivos. Máximo permitido: ${MAX_UPLOAD_FILES}.`,
          ),
        );
        return;
      }
      if (err.code === "LIMIT_UNEXPECTED_FILE") {
        next(
          ApiError.badRequest(
            "Campo de archivo inesperado. Envía los documentos en el campo 'files'.",
          ),
        );
        return;
      }
      next(ApiError.badRequest(err.message));
      return;
    }
    next(err);
  });
};
