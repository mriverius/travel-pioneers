import type { Request, Response } from "express";
import ApiError from "../../utils/ApiError.js";
import logger from "../../config/logger.js";
import { detectDocKind } from "./extractors/index.js";
import { preScan } from "./preScanService.js";

/**
 * POST /api/supplier-intelligence/pre-scan
 *
 * Multipart (`files`): se analizan TODOS los archivos; el primero es el
 * contrato primario (manda en proveedor y campos escalares) y el resto
 * secundarios (políticas, T&C…) que aportan lo que el primario no tiene.
 * Determinístico y sin IA — ver `preScanService.ts`. Corre cada vez que
 * cambia el conjunto de archivos en el Paso 1.
 */
export async function preScanHandler(req: Request, res: Response): Promise<void> {
  const files = (Array.isArray(req.files) ? req.files : []) as Express.Multer.File[];
  if (files.length === 0) {
    throw ApiError.badRequest("Adjunta el contrato en el campo `files`.");
  }

  const inputs = files.map((file) => {
    const kind = detectDocKind(file.mimetype, file.originalname);
    if (!kind) {
      throw ApiError.badRequest(`Tipo de documento no soportado: ${file.originalname}`);
    }
    return { kind, buffer: file.buffer, filename: file.originalname };
  });

  const result = await preScan(inputs);

  logger.info("pre-scan", {
    requestId: req.id,
    userId: req.auth?.id,
    filename: result.filename,
    files: inputs.length,
    textAvailable: result.textAvailable,
    crossDocumentWarnings: result.crossDocumentWarnings.length,
    confidence: result.supplier.confidence,
    top: result.supplier.candidates[0]?.codigo ?? null,
    durationMs: result.durationMs,
  });

  res.json({ success: true, scan: result });
}
