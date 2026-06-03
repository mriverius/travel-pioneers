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
 * Build a single, stable display filename for the response `meta.filename`
 * field when the user uploads more than one document. We always lead with
 * the first file's name (which is normally the primary contract) and append
 * a "+N más" suffix so the UI and persisted history stay readable.
 */
function combineFilenames(files: Express.Multer.File[]): string {
  if (files.length === 0) return "";
  const first = files[0]!.originalname;
  if (files.length === 1) return first;
  return `${first} (+${files.length - 1} más)`;
}

/**
 * POST /api/supplier-intelligence/extract
 *
 * `multipart/form-data` with these fields:
 *   - `files` (required, 1..MAX_UPLOAD_FILES) — one or more contract documents
 *     (PDF / Word / Excel). All files are bundled into a single Claude call
 *     and produce a single merged extraction; the model is told to treat them
 *     as one logical contract (main contract + amendments + price lists).
 *   - `is_existing_supplier` (required) — "true" | "false" toggle from step 1.
 *   - `comments` (optional) — free-form context (e.g. email body excerpts)
 *     forwarded to Claude as additional extraction context.
 *
 * See `uploadMiddleware.ts` for the validation that runs before this handler
 * (size, mime, extension, file count).
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
  // Multer's `.array("files")` populates `req.files` as an array; the typing
  // is `Express.Multer.File[] | { [fieldname: string]: Express.Multer.File[] }`
  // depending on the multer mode, but `.array(...)` always yields the array
  // form. Narrow defensively before iterating.
  const rawFiles = req.files;
  const files: Express.Multer.File[] = Array.isArray(rawFiles)
    ? rawFiles
    : [];

  if (files.length === 0) {
    throw ApiError.badRequest(
      "No se recibió ningún archivo. Envía los documentos en el campo 'files'.",
    );
  }

  // Body fields parsed up-front so a bad/missing flag fails fast — before we
  // pay for the Anthropic round-trip.
  const isExistingSupplier = parseExistingSupplier(req.body?.is_existing_supplier);
  const comments = parseComments(req.body?.comments);

  // Prepare each document in order (PDFs stay as base64, Word/Excel get
  // converted to plain text). Failures here surface as 400 from the
  // extractors and are returned to the client before we contact Anthropic.
  const prepared = [];
  let totalBytes = 0;
  for (const file of files) {
    const kind = detectDocKind(file.mimetype, file.originalname);
    if (!kind) {
      // Defensive — the multer fileFilter should have already caught this.
      throw new ApiError(
        415,
        `Tipo de archivo no soportado: ${file.originalname} (${file.mimetype ?? "desconocido"}).`,
      );
    }
    const doc = await prepareDocument(
      kind,
      file.buffer,
      file.mimetype,
      file.originalname,
    );
    prepared.push({ ...doc, originalName: file.originalname });
    totalBytes += file.size;
  }

  logger.info("Supplier Intelligence extraction started", {
    requestId: req.id,
    fileCount: files.length,
    filenames: files.map((f) => f.originalname),
    totalSize: totalBytes,
    isExistingSupplier,
    hasComments: comments !== undefined,
  });

  const { data, validation, model, usage, brief, manualPrefill } =
    await extractContract(prepared, req.id, { comments, isExistingSupplier });

  const combinedFilename = combineFilenames(files);

  logger.info("Supplier Intelligence extraction finished", {
    requestId: req.id,
    filename: combinedFilename,
    fileCount: files.length,
    confianza: data.confianza,
    warnings: validation.warnings.length,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    costUsd: usage.costUsd,
    rowCount: data.rows.length,
    // Brief (Fase 1): observabilidad de las reglas globales detectadas y de
    // la meta de completitud vs. filas realmente generadas.
    brief: brief
      ? {
          pricesIncludeTax: brief.prices_include_tax,
          taxRatePct: brief.tax_rate_pct,
          bankAccounts: brief.bank_accounts.length,
          additionalPersonRules: brief.additional_person.length,
          sections: brief.sections.length,
          expectedRows: brief.expected_row_estimate,
        }
      : null,
  });

  res.status(200).json({
    success: true,
    data,
    validation,
    meta: {
      filename: combinedFilename,
      size_bytes: totalBytes,
      model,
      processed_at: new Date().toISOString(),
      is_existing_supplier: isExistingSupplier,
      // Telemetría real reportada por Anthropic — el frontend la persiste
      // junto con el run en el step 3 (saveRun). Si Anthropic no reportó
      // usage (edge case), inputTokens/outputTokens vienen en 0 y costUsd
      // como 0 — preferible a omitir el campo y romper el contrato.
      input_tokens: usage.inputTokens,
      output_tokens: usage.outputTokens,
      cost_usd: usage.costUsd,
      // Prefill de cuentas bancarias 2 y 3 (del brief). El frontend pre-llena
      // los campos manuales de Step 2 con esto. `null` si hay una sola cuenta.
      manual_prefill: manualPrefill,
    },
  });
}
