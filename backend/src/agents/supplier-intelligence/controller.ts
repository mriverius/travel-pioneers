import type { Request, Response } from "express";
import logger from "../../config/logger.js";
import ApiError from "../../utils/ApiError.js";
import { detectDocKind, prepareDocument } from "./extractors/index.js";
import {
  analyzeContractBrief,
  coerceBrief,
  extractContract,
  refineContractBrief,
  type ExtractionContext,
  type PreparedDocumentInput,
} from "./service.js";
import type { BriefChatMessage, ContractBrief } from "./types.js";
import {
  completeExtractionJob,
  createExtractionJob,
  failExtractionJob,
  getExtractionJob,
} from "./extractionJobs.js";

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
 * Parse the optional `brief` form field — the user-confirmed Variables de
 * Configuración from the gated middle step. Arrives as a JSON string in the
 * multipart body. When present and parseable, it's passed to `extractContract`
 * as the brief override (Fase 1 is skipped). Bad JSON is a 400 so the client
 * notices a serialization bug instead of silently re-running the analysis.
 */
function parseBriefField(raw: unknown): ContractBrief | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string" || raw.trim() === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw ApiError.badRequest("El campo 'brief' debe ser JSON válido.");
  }
  return coerceBrief(parsed);
}

/**
 * Parse the optional `briefs` form field — an array of user-confirmed briefs,
 * one per uploaded document (multi-document flow). Arrives as a JSON array
 * string. Falls back to `null` when absent so the single-`brief` path or the
 * internal Fase 1 still applies.
 */
function parseBriefsField(raw: unknown): ContractBrief[] | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string" || raw.trim() === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw ApiError.badRequest("El campo 'briefs' debe ser JSON válido.");
  }
  if (!Array.isArray(parsed)) {
    throw ApiError.badRequest("'briefs' debe ser un array de briefs.");
  }
  const out = parsed.map((b) => coerceBrief(b));
  return out.length > 0 ? out : null;
}

function parseFeedbackField(raw: unknown): string {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw ApiError.badRequest(
      "Falta el campo 'feedback_message' con la corrección del usuario.",
    );
  }
  const trimmed = raw.trim();
  if (trimmed.length > MAX_COMMENTS_LENGTH) {
    throw ApiError.badRequest(
      `El mensaje de corrección excede el máximo (${MAX_COMMENTS_LENGTH} caracteres).`,
    );
  }
  return trimmed;
}

function parseChatHistoryField(raw: unknown): BriefChatMessage[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string" || raw.trim() === "") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw ApiError.badRequest("El campo 'chat_history' debe ser JSON válido.");
  }
  if (!Array.isArray(parsed)) {
    throw ApiError.badRequest("'chat_history' debe ser un array.");
  }
  const out: BriefChatMessage[] = [];
  for (const item of parsed) {
    if (
      item &&
      typeof item === "object" &&
      (item as { role?: string }).role === "user" &&
      typeof (item as { content?: unknown }).content === "string"
    ) {
      out.push({ role: "user", content: (item as { content: string }).content });
    } else if (
      item &&
      typeof item === "object" &&
      (item as { role?: string }).role === "assistant" &&
      typeof (item as { content?: unknown }).content === "string"
    ) {
      out.push({
        role: "assistant",
        content: (item as { content: string }).content,
      });
    }
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Shared upload pipeline for both `/extract` and `/analyze-brief`: narrows
 * `req.files`, parses the required/optional form fields, and prepares each
 * document (PDFs stay base64, Word/Excel become text). Failures surface as
 * 4xx before any Anthropic round-trip.
 */
async function prepareUploadedDocs(req: Request): Promise<{
  prepared: PreparedDocumentInput[];
  files: Express.Multer.File[];
  totalBytes: number;
  context: ExtractionContext;
}> {
  const rawFiles = req.files;
  const files: Express.Multer.File[] = Array.isArray(rawFiles) ? rawFiles : [];

  if (files.length === 0) {
    throw ApiError.badRequest(
      "No se recibió ningún archivo. Envía los documentos en el campo 'files'.",
    );
  }

  const isExistingSupplier = parseExistingSupplier(
    req.body?.is_existing_supplier,
  );
  const comments = parseComments(req.body?.comments);

  const prepared: PreparedDocumentInput[] = [];
  let totalBytes = 0;
  for (const file of files) {
    const kind = detectDocKind(file.mimetype, file.originalname);
    if (!kind) {
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

  return {
    prepared,
    files,
    totalBytes,
    context: { comments, isExistingSupplier },
  };
}

/**
 * POST /api/supplier-intelligence/analyze-brief
 *
 * Fase 1 standalone del flujo gated. Mismo `multipart/form-data` que
 * `/extract` (files + is_existing_supplier + comments), pero corre SOLO el
 * pre-análisis y devuelve las Variables de Configuración para que el usuario
 * las confirme/corrija ANTES de la extracción completa. Mucho más barato y
 * rápido que `/extract` (un pase de Sonnet, sin generar filas).
 *
 * Response:
 *   { success, brief, meta }
 */
export async function analyzeBriefHandler(
  req: Request,
  res: Response,
): Promise<void> {
  const { prepared, files, totalBytes, context } =
    await prepareUploadedDocs(req);

  logger.info("Supplier Intelligence brief analysis started", {
    requestId: req.id,
    fileCount: files.length,
    filenames: files.map((f) => f.originalname),
    totalSize: totalBytes,
    isExistingSupplier: context.isExistingSupplier,
    hasComments: context.comments !== undefined,
  });

  const { brief, model, usage } = await analyzeContractBrief(
    prepared,
    req.id,
    context,
  );

  const combinedFilename = combineFilenames(files);

  logger.info("Supplier Intelligence brief analysis finished", {
    requestId: req.id,
    filename: combinedFilename,
    pricesIncludeTax: brief.prices_include_tax,
    taxRatePct: brief.tax_rate_pct,
    commissionDefaultPct: brief.commission_default_pct,
    seasonsCount: brief.seasons.length,
    seasonsDetailCount: brief.seasons_detail.length,
    seasonNames: brief.seasons,
    bankAccounts: brief.bank_accounts.length,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    costUsd: usage.costUsd,
  });

  res.status(200).json({
    success: true,
    brief,
    meta: {
      filename: combinedFilename,
      size_bytes: totalBytes,
      model,
      processed_at: new Date().toISOString(),
      is_existing_supplier: context.isExistingSupplier,
      input_tokens: usage.inputTokens,
      output_tokens: usage.outputTokens,
      cost_usd: usage.costUsd,
    },
  });
}

/**
 * POST /api/supplier-intelligence/refine-brief
 *
 * Re-analiza el brief tras feedback del usuario en el chat del Paso 2.
 * Mismo multipart que analyze-brief + campos `brief` (JSON anterior) y
 * `feedback_message` (texto del usuario). Opcional: `chat_history` (JSON array).
 */
export async function refineBriefHandler(
  req: Request,
  res: Response,
): Promise<void> {
  const { prepared, files, totalBytes, context } =
    await prepareUploadedDocs(req);

  const previousBrief = parseBriefField(req.body?.brief);
  if (!previousBrief) {
    throw ApiError.badRequest(
      "Falta el campo 'brief' con el análisis anterior.",
    );
  }
  const feedback = parseFeedbackField(req.body?.feedback_message);
  const chatHistory = parseChatHistoryField(req.body?.chat_history);

  logger.info("Supplier Intelligence brief refine started", {
    requestId: req.id,
    fileCount: files.length,
    feedbackLength: feedback.length,
    chatHistoryLength: chatHistory?.length ?? 0,
  });

  const { brief, model, usage } = await refineContractBrief(
    prepared,
    previousBrief,
    feedback,
    req.id,
    context,
    chatHistory,
  );

  const combinedFilename = combineFilenames(files);

  logger.info("Supplier Intelligence brief refine finished", {
    requestId: req.id,
    filename: combinedFilename,
    logicSummaryLength: brief.logic_summary?.length ?? 0,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    costUsd: usage.costUsd,
  });

  res.status(200).json({
    success: true,
    brief,
    meta: {
      filename: combinedFilename,
      size_bytes: totalBytes,
      model,
      processed_at: new Date().toISOString(),
      is_existing_supplier: context.isExistingSupplier,
      input_tokens: usage.inputTokens,
      output_tokens: usage.outputTokens,
      cost_usd: usage.costUsd,
    },
  });
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
/** Map mínimo HTTP status → código legible para el cliente. */
function codeForStatus(status: number): string {
  switch (status) {
    case 400:
      return "bad_request";
    case 413:
      return "file_too_large";
    case 415:
      return "unsupported_file_type";
    case 422:
      return "validation_failed";
    case 429:
      return "rate_limited";
    case 502:
      return "upstream_unavailable";
    default:
      return status >= 500 ? "internal_error" : "error";
  }
}

interface ExtractionJobParams {
  prepared: PreparedDocumentInput[];
  requestId: string;
  context: ExtractionContext;
  briefsOverride: ContractBrief[] | null;
  combinedFilename: string;
  totalBytes: number;
  isExistingSupplier: boolean;
  fileCount: number;
}

/**
 * Corre la extracción Opus en segundo plano (no la espera ninguna conexión
 * HTTP) y deposita el resultado o el error en el job store. El frontend lo
 * recoge vía `GET /extract/:jobId`.
 */
async function runExtractionJob(
  jobId: string,
  p: ExtractionJobParams,
): Promise<void> {
  try {
    const { data, validation, model, usage, brief, manualPrefill } =
      await extractContract(
        p.prepared,
        p.requestId,
        p.context,
        p.briefsOverride,
      );

    logger.info("Supplier Intelligence extraction finished", {
      jobId,
      requestId: p.requestId,
      filename: p.combinedFilename,
      fileCount: p.fileCount,
      confianza: data.confianza,
      warnings: validation.warnings.length,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      costUsd: usage.costUsd,
      rowCount: data.rows.length,
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

    completeExtractionJob(jobId, {
      success: true,
      data,
      validation,
      meta: {
        filename: p.combinedFilename,
        size_bytes: p.totalBytes,
        model,
        processed_at: new Date().toISOString(),
        is_existing_supplier: p.isExistingSupplier,
        // Telemetría real reportada por Anthropic — el frontend la persiste
        // junto con el run en el step 3 (saveRun).
        input_tokens: usage.inputTokens,
        output_tokens: usage.outputTokens,
        cost_usd: usage.costUsd,
        // Prefill de cuentas bancarias 2 y 3 (del brief).
        manual_prefill: manualPrefill,
      },
    });
  } catch (err) {
    const isApiError = err instanceof ApiError;
    const status = isApiError ? err.statusCode : 500;
    const message =
      isApiError && err.message
        ? err.message
        : "Error interno del servidor durante la extracción. Intenta de nuevo.";

    logger.error("Supplier Intelligence extraction job failed", {
      jobId,
      requestId: p.requestId,
      statusCode: status,
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });

    failExtractionJob(jobId, {
      status,
      code: codeForStatus(status),
      message,
      details: isApiError ? err.details : undefined,
    });
  }
}

/**
 * POST /api/supplier-intelligence/extract
 *
 * Arranca un job de extracción y responde 202 con `{ success, job_id }` al
 * instante. El trabajo pesado (Opus, varios minutos) corre en segundo plano;
 * el frontend encuesta `GET /api/supplier-intelligence/extract/:jobId`. Así
 * ninguna conexión HTTP queda abierta durante toda la extracción — evita los
 * cortes de los proxies intermedios en requests largas.
 */
export async function extractContractHandler(
  req: Request,
  res: Response,
): Promise<void> {
  const { prepared, files, totalBytes, context } =
    await prepareUploadedDocs(req);
  const { isExistingSupplier, comments } = context;

  // Variables de Configuración confirmadas por el usuario en el step gated.
  // `briefs` (array, uno por documento) tiene prioridad; `brief` (single) es
  // back-compat. Cuando vienen, `extractContract` salta la Fase 1.
  const briefsOverride =
    parseBriefsField(req.body?.briefs) ??
    (() => {
      const single = parseBriefField(req.body?.brief);
      return single ? [single] : null;
    })();

  const combinedFilename = combineFilenames(files);
  const requestId = req.id;
  const job = createExtractionJob();

  logger.info("Supplier Intelligence extraction job started", {
    jobId: job.id,
    requestId,
    fileCount: files.length,
    filenames: files.map((f) => f.originalname),
    totalSize: totalBytes,
    isExistingSupplier,
    hasComments: comments !== undefined,
    confirmedBriefCount: briefsOverride?.length ?? 0,
  });

  // Responde YA con el id del job; el trabajo sigue en segundo plano.
  res.status(202).json({ success: true, job_id: job.id });

  void runExtractionJob(job.id, {
    prepared,
    requestId,
    context,
    briefsOverride,
    combinedFilename,
    totalBytes,
    isExistingSupplier: isExistingSupplier ?? false,
    fileCount: files.length,
  });
}

/**
 * GET /api/supplier-intelligence/extract/:jobId
 *
 * Encuesta el estado de un job de extracción.
 *   - processing → 200 { success, status: "processing" }
 *   - done       → 200 { success, status: "done", data, validation, meta }
 *   - error      → status original con { success: false, status: "error", error }
 */
export async function getExtractionStatusHandler(
  req: Request,
  res: Response,
): Promise<void> {
  const jobId = typeof req.params.jobId === "string" ? req.params.jobId : "";
  const job = getExtractionJob(jobId);

  if (!job) {
    throw new ApiError(
      404,
      "El trabajo de extracción no existe o expiró. Volvé al Paso 2 e intentá de nuevo.",
    );
  }

  if (job.state === "processing") {
    res.status(200).json({ success: true, status: "processing" });
    return;
  }

  if (job.state === "error") {
    const e = job.error ?? {
      status: 500,
      code: "internal_error",
      message: "Error interno del servidor durante la extracción.",
    };
    res.status(e.status).json({
      success: false,
      status: "error",
      error: {
        code: e.code,
        message: e.message,
        ...(e.details !== undefined ? { details: e.details } : {}),
      },
    });
    return;
  }

  // done — `result` ya es la envolvente { success, data, validation, meta }.
  res
    .status(200)
    .json({ status: "done", ...(job.result as Record<string, unknown>) });
}
