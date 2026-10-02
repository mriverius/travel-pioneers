import type { Request, Response } from "express";
import prisma from "../../config/prisma.js";
import logger from "../../config/logger.js";
import ApiError from "../../utils/ApiError.js";
import type {
  ContractRow,
  ManualFields,
  SharedFields,
  TipoUnidad,
} from "./types.js";
import { normalizeDate, normalizeSeasonDateField } from "./validators.js";
import { buildQualityReport, coerceFeedback, type RunFeedback } from "./feedback.js";

/**
 * Persistence + read endpoints for Supplier Intelligence runs.
 *
 *   POST /api/supplier-intelligence/contracts          — save a finished run (upsert by extraction_id)
 *   GET  /api/supplier-intelligence/contracts          — list (global, paginated, ?range=&tz=)
 *   GET  /api/supplier-intelligence/contracts/stats    — counts per range (?tz=)
 *
 * The list and the stats endpoints share `rangeStart()` so the number the
 * dashboard shows for a range is, by construction, the `total` the history
 * page reports for the same range: same cutoff instants, same timezone.
 *
 * Scope is global: every authenticated user reads every run; `processedById`
 * is captured for audit only and becomes null if that user is later deleted
 * (runs are never blocked on, or removed with, a user). The product team explicitly chose this over
 * per-user isolation to avoid the "I can't see what my colleague processed"
 * support thread.
 *
 * Body validation here is intentionally hand-rolled (matching `generateController`)
 * rather than relying on a schema lib — the shape is small, stable, and we want
 * the same `ApiError.badRequest` flow used by the rest of the agent surface.
 */

/* -------------------------------------------------------------------------- */
/*                                Coercion                                    */
/* -------------------------------------------------------------------------- */

const stringOrNull = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") return v;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
};

/**
 * Guardrail final: el agente normaliza fechas al extraer, pero el usuario
 * puede editar manualmente en Step 2 antes de guardar. Esto asegura que
 * lo que termina en el histórico SIEMPRE esté en YYYY-MM-DD (o null /
 * "NOT AVAILABLE"). Si no se pudo parsear lo guardamos como null en
 * lugar de meter basura en el DB; la lib del normalizador ya conoce
 * todos los formatos comunes (DD/MM/YYYY, "January 6 2026", etc.).
 */
const dateOrNull = (v: unknown): string | null => {
  return normalizeDate(stringOrNull(v)).value;
};

const seasonDateOrNull = (v: unknown): string | null => {
  return normalizeSeasonDateField(stringOrNull(v)).value;
};

/**
 * Coerce a "Tipo Tarifa" code (cols X, AA, AC, AD, AG — todos los
 * `tipo_tarifa_*` y `t_tar_neta_fds`). El sistema downstream
 * (`xlsxGenerator.inferTipoTarifa`) usa estrictamente los códigos:
 *   - "1" → FIJA
 *   - "2" → PORCENTUAL
 *
 * El dropdown de la UI ahora solo deja ingresar esos dos valores, pero
 * como backstop coercemos en el backend: cualquier otra cosa
 * (texto libre legacy como "Por persona" / "Wholesale" / "Weekend",
 * strings con espacios, null, undefined) se transforma a null y deja
 * que el generator infiera el código a partir del % comisión.
 */
const tipoTarifaCodeOrNull = (v: unknown): string | null => {
  const s = stringOrNull(v);
  if (s === null) return null;
  const trimmed = s.trim();
  return trimmed === "1" || trimmed === "2" ? trimmed : null;
};

/**
 * Coerce a "Condiciones Crédito" code (col AP — `cond_credito`). El
 * maestro Utopía usa los códigos:
 *   - "1" → CONTADO
 *   - "2" → CRÉDITO
 *   - "3" → PREPAGO
 *
 * Cualquier free-text legacy ("30 días neto", "Net 30", etc.) se
 * descarta para no contaminar la celda — esos detalles van a la
 * columna AQ (`plazo`).
 */
const condCreditoCodeOrNull = (v: unknown): string | null => {
  const s = stringOrNull(v);
  if (s === null) return null;
  const trimmed = s.trim();
  return trimmed === "1" || trimmed === "2" || trimmed === "3" ? trimmed : null;
};

function coerceTipoUnidad(v: unknown): TipoUnidad | null {
  return v === "N" || v === "S" ? v : null;
}

function coerceSharedFields(input: unknown): SharedFields {
  if (!input || typeof input !== "object") {
    throw ApiError.badRequest("`shared_fields` debe ser un objeto.");
  }
  const r = input as Record<string, unknown>;
  return {
    fecha: dateOrNull(r.fecha),
    proveedor: stringOrNull(r.proveedor),
    nombre_comercial: stringOrNull(r.nombre_comercial),
    cedula: stringOrNull(r.cedula),
    direccion: stringOrNull(r.direccion),
    telefono: stringOrNull(r.telefono),
    pais: stringOrNull(r.pais),
    state_province: stringOrNull(r.state_province),
    type_of_business: stringOrNull(r.type_of_business),
    contract_starts: dateOrNull(r.contract_starts),
    contract_ends: dateOrNull(r.contract_ends),
    reservations_email: stringOrNull(r.reservations_email),
    tipo_unidad: coerceTipoUnidad(r.tipo_unidad),
    tipo_servicio: stringOrNull(r.tipo_servicio),
    tipo_moneda: stringOrNull(r.tipo_moneda),
    numero_cuenta: stringOrNull(r.numero_cuenta),
    banco: stringOrNull(r.banco),
    others_payment_cancel: stringOrNull(r.others_payment_cancel),
    notes: stringOrNull(r.notes),
  };
}

function coerceRow(input: unknown, index: number): ContractRow {
  if (!input || typeof input !== "object") {
    throw ApiError.badRequest(`rows[${index}] debe ser un objeto.`);
  }
  const r = input as Record<string, unknown>;
  return {
    product_name: stringOrNull(r.product_name),
    categoria: stringOrNull(r.categoria),
    tipo_servicio: stringOrNull(r.tipo_servicio),
    tipo_unidad: coerceTipoUnidad(r.tipo_unidad),
    codigo_servicio: stringOrNull(r.codigo_servicio),
    ocupacion: stringOrNull(r.ocupacion),
    tarifa_persona_adicional: stringOrNull(r.tarifa_persona_adicional),
    season_name: stringOrNull(r.season_name),
    season_starts: seasonDateOrNull(r.season_starts),
    season_ends: seasonDateOrNull(r.season_ends),
    meals_included: stringOrNull(r.meals_included),
    precios_neto_iva: stringOrNull(r.precios_neto_iva),
    precio_rack_iva: stringOrNull(r.precio_rack_iva),
    porcentaje_comision: stringOrNull(r.porcentaje_comision),
    precios_neto_iva_fds: stringOrNull(r.precios_neto_iva_fds),
    precio_rack_iva_fds: stringOrNull(r.precio_rack_iva_fds),
    porcentaje_comision_fds: stringOrNull(r.porcentaje_comision_fds),
    cancellation_policy: stringOrNull(r.cancellation_policy),
    range_payment_policy: stringOrNull(r.range_payment_policy),
    kids_policy: stringOrNull(r.kids_policy),
    other_included: stringOrNull(r.other_included),
    feeds_adicionales: stringOrNull(r.feeds_adicionales),
  };
}

function coerceManualFields(input: unknown): ManualFields | null {
  if (input === null || input === undefined) return null;
  if (typeof input !== "object") {
    throw ApiError.badRequest("`manual_fields` debe ser un objeto o null.");
  }
  const r = input as Record<string, unknown>;
  return {
    tipo_tarifa_neta: tipoTarifaCodeOrNull(r.tipo_tarifa_neta),
    tipo_tarifa_mayorista: tipoTarifaCodeOrNull(r.tipo_tarifa_mayorista),
    tipo_tarifa_fds: tipoTarifaCodeOrNull(r.tipo_tarifa_fds),
    t_tar_neta_fds: tipoTarifaCodeOrNull(r.t_tar_neta_fds),
    tipo_tarifa_mayorista_fds: tipoTarifaCodeOrNull(r.tipo_tarifa_mayorista_fds),
    cond_credito: condCreditoCodeOrNull(r.cond_credito),
    plazo: stringOrNull(r.plazo),
    cuenta_bancaria_2: stringOrNull(r.cuenta_bancaria_2),
    banco_2: stringOrNull(r.banco_2),
    moneda_2: stringOrNull(r.moneda_2),
    cuenta_bancaria_3: stringOrNull(r.cuenta_bancaria_3),
    banco_3: stringOrNull(r.banco_3),
    moneda_3: stringOrNull(r.moneda_3),
  };
}

interface CatalogPrefill {
  tipo_actividad: string | null;
  zona_turismo: string | null;
  proveedor_codigo: string | null;
  codigo_servicio: string | null;
}

/**
 * Telemetría opcional. Aceptamos:
 *   - `undefined` / `null`     → null (cliente viejo, no se persiste nada)
 *   - número entero ≥ 0        → ese valor
 *   - cualquier otra cosa      → 400, para que no entren basura silenciosa
 *     (ej. el cliente mandando "1234" en string por accidente)
 */
function coerceOptionalNonNegativeInt(
  input: unknown,
  fieldName: string,
): number | null {
  if (input === undefined || input === null) return null;
  if (typeof input !== "number" || !Number.isFinite(input)) {
    throw ApiError.badRequest(`\`${fieldName}\` debe ser un número entero ≥ 0.`);
  }
  if (input < 0 || !Number.isInteger(input)) {
    throw ApiError.badRequest(`\`${fieldName}\` debe ser un número entero ≥ 0.`);
  }
  return input;
}

function coerceOptionalNonNegativeFloat(
  input: unknown,
  fieldName: string,
): number | null {
  if (input === undefined || input === null) return null;
  if (typeof input !== "number" || !Number.isFinite(input) || input < 0) {
    throw ApiError.badRequest(
      `\`${fieldName}\` debe ser un número (float) ≥ 0.`,
    );
  }
  return input;
}

function coerceCatalogPrefill(input: unknown): CatalogPrefill | null {
  if (input === null || input === undefined) return null;
  if (typeof input !== "object") {
    throw ApiError.badRequest("`catalog_prefill` debe ser un objeto o null.");
  }
  const r = input as Record<string, unknown>;
  return {
    tipo_actividad: stringOrNull(r.tipo_actividad),
    zona_turismo: stringOrNull(r.zona_turismo),
    proveedor_codigo: stringOrNull(r.proveedor_codigo),
    codigo_servicio: stringOrNull(r.codigo_servicio),
  };
}

/* -------------------------------------------------------------------------- */
/*                              Public shape                                  */
/* -------------------------------------------------------------------------- */

interface PublicContractRun {
  id: string;
  processedAt: string;
  /** Null when the user that processed the run has since been deleted. */
  processedBy: { id: string; name: string; email: string } | null;
  filename: string;
  fileKind: string;
  fileSize: number;
  sharedFields: SharedFields;
  rows: ContractRow[];
  catalogPrefill: CatalogPrefill | null;
  manualFields: ManualFields | null;
  aiModel: string;
  /**
   * Telemetría real reportada por Anthropic (tokens) y el costo estimado
   * en USD computado en el servicio. Nullables porque las filas
   * persistidas antes de esta feature no los tienen.
   */
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
}

interface ContractRunRow {
  id: string;
  processedAt: Date;
  filename: string;
  fileKind: string;
  fileSize: number;
  sharedFields: unknown;
  rows: unknown;
  catalogPrefill: unknown;
  manualFields: unknown;
  aiModel: string;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  processedBy: { id: string; name: string; email: string } | null;
}

function toPublicRun(row: ContractRunRow): PublicContractRun {
  return {
    id: row.id,
    processedAt: row.processedAt.toISOString(),
    processedBy: row.processedBy ?? null,
    filename: row.filename,
    fileKind: row.fileKind,
    fileSize: row.fileSize,
    sharedFields: row.sharedFields as SharedFields,
    rows: row.rows as ContractRow[],
    catalogPrefill: row.catalogPrefill as CatalogPrefill | null,
    manualFields: row.manualFields as ManualFields | null,
    aiModel: row.aiModel,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    costUsd: row.costUsd,
  };
}

/* -------------------------------------------------------------------------- */
/*                               POST /contracts                              */
/* -------------------------------------------------------------------------- */

interface SaveBody {
  filename: unknown;
  file_kind: unknown;
  file_size: unknown;
  ai_model: unknown;
  shared_fields: unknown;
  rows: unknown;
  catalog_prefill?: unknown;
  manual_fields?: unknown;
  /**
   * Telemetría opcional del run. El frontend la reenvía desde `meta` que
   * devolvió `POST /extract`. Si el cliente es viejo (no las envía), las
   * persistimos como null en lugar de bloquear el save — la fila sigue
   * siendo válida para el historial.
   */
  input_tokens?: unknown;
  output_tokens?: unknown;
  cost_usd?: unknown;
  /**
   * Client-generated UUID, one per extraction. When present the save is an
   * upsert: re-downloading the same extraction updates the existing row
   * instead of inserting a duplicate. Optional for backwards compat.
   */
  extraction_id?: unknown;
  /** Señal de aprendizaje (ver `feedback.ts`). Opcional; nunca bloquea el save. */
  feedback?: unknown;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function coerceOptionalUuid(v: unknown, field: string): string | null {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string" || !UUID_RE.test(v)) {
    throw ApiError.badRequest(`\`${field}\` debe ser un UUID.`);
  }
  return v.toLowerCase();
}

const ALLOWED_FILE_KINDS = new Set(["pdf", "docx", "xlsx", "image"]);

export async function saveContractRunHandler(
  req: Request<unknown, unknown, SaveBody>,
  res: Response,
): Promise<void> {
  if (!req.auth?.id) {
    throw ApiError.unauthorized("Authentication required");
  }

  const body = (req.body ?? {}) as SaveBody;

  const filename = typeof body.filename === "string" ? body.filename.trim() : "";
  if (!filename) {
    throw ApiError.badRequest("`filename` es requerido.");
  }
  if (filename.length > 512) {
    throw ApiError.badRequest("`filename` excede 512 caracteres.");
  }

  const fileKind = typeof body.file_kind === "string" ? body.file_kind.trim().toLowerCase() : "";
  if (!ALLOWED_FILE_KINDS.has(fileKind)) {
    throw ApiError.badRequest("`file_kind` debe ser pdf, docx, xlsx o image.");
  }

  const fileSize = typeof body.file_size === "number" ? body.file_size : NaN;
  if (!Number.isFinite(fileSize) || fileSize < 0 || fileSize > 100 * 1024 * 1024) {
    throw ApiError.badRequest("`file_size` debe ser un entero entre 0 y 100MB.");
  }

  const aiModel = typeof body.ai_model === "string" ? body.ai_model.trim() : "";
  if (!aiModel) {
    throw ApiError.badRequest("`ai_model` es requerido.");
  }
  if (aiModel.length > 200) {
    throw ApiError.badRequest("`ai_model` excede 200 caracteres.");
  }

  const sharedFields = coerceSharedFields(body.shared_fields);
  if (!Array.isArray(body.rows)) {
    throw ApiError.badRequest("`rows` debe ser un array.");
  }
  if (body.rows.length === 0) {
    throw ApiError.badRequest("`rows` no puede estar vacío.");
  }
  if (body.rows.length > 500) {
    throw ApiError.badRequest("`rows` excede el máximo permitido (500).");
  }
  const rows = body.rows.map(coerceRow);

  const catalogPrefill = coerceCatalogPrefill(body.catalog_prefill);
  const manualFields = coerceManualFields(body.manual_fields);

  // Telemetría: si llega, debe ser numérica y no-negativa. La rechazamos
  // si es basura, pero un cliente viejo que no la mande sigue funcionando
  // (queda persistido como null).
  const inputTokens = coerceOptionalNonNegativeInt(
    body.input_tokens,
    "input_tokens",
  );
  const outputTokens = coerceOptionalNonNegativeInt(
    body.output_tokens,
    "output_tokens",
  );
  const costUsd = coerceOptionalNonNegativeFloat(body.cost_usd, "cost_usd");
  const extractionId = coerceOptionalUuid(body.extraction_id, "extraction_id");
  const fb = coerceFeedback(body.feedback);
  if (fb.reason) {
    logger.warn("ContractRun feedback dropped", { requestId: req.id, reason: fb.reason });
  }

  const data = {
    filename,
    fileKind,
    fileSize: Math.floor(fileSize),
    aiModel,
    // Cast to satisfy Prisma's `JsonValue` shape — `null` is allowed but
    // requires `as unknown as Prisma.InputJsonValue` at the type level.
    sharedFields: sharedFields as unknown as object,
    rows: rows as unknown as object,
    catalogPrefill: (catalogPrefill ?? undefined) as unknown as object | undefined,
    manualFields: (manualFields ?? undefined) as unknown as object | undefined,
    inputTokens: inputTokens ?? undefined,
    outputTokens: outputTokens ?? undefined,
    costUsd: costUsd ?? undefined,
    feedback: (fb.feedback ?? undefined) as unknown as object | undefined,
  };
  const include = {
    processedBy: { select: { id: true, name: true, email: true } },
  };

  // Idempotent save: the same extraction downloaded twice (Paso 3 button +
  // Paso 4 auto-download, or a re-click) must stay one history row, and so
  // be counted once in the dashboard. On a repeat we refresh the payload
  // (the user may have edited rows between downloads) but keep the original
  // `processedAt` and `processedById` — the run happened once.
  let saved;
  let created = true;
  if (extractionId) {
    const existing = await prisma.contractRun.findUnique({
      where: { extractionId },
      select: { id: true },
    });
    created = existing === null;
    saved = await prisma.contractRun.upsert({
      where: { extractionId },
      create: { ...data, extractionId, processedById: req.auth.id },
      update: data,
      include,
    });
  } else {
    saved = await prisma.contractRun.create({
      data: { ...data, processedById: req.auth.id },
      include,
    });
  }

  logger.info(created ? "ContractRun saved" : "ContractRun updated (same extraction)", {
    requestId: req.id,
    runId: saved.id,
    extractionId,
    actorId: req.auth.id,
    rowCount: rows.length,
    filename,
    inputTokens,
    outputTokens,
    costUsd,
  });

  res
    .status(created ? 201 : 200)
    .json({ run: toPublicRun(saved as unknown as ContractRunRow), created });
}

/* -------------------------------------------------------------------------- */
/*                         Time ranges (shared by list + stats)               */
/* -------------------------------------------------------------------------- */

export const RANGE_KEYS = ["today", "week", "month", "quarter", "all"] as const;
export type RangeKey = (typeof RANGE_KEYS)[number];

function isRangeKey(v: unknown): v is RangeKey {
  return typeof v === "string" && (RANGE_KEYS as readonly string[]).includes(v);
}

/**
 * Resolve the IANA timezone the client asked for (`?tz=America/Costa_Rica`).
 * "Hoy" is a calendar concept, so it must be computed in the *user's* day,
 * not the server's — otherwise an API running in UTC starts "today" at
 * 18:00 Costa Rica time the previous evening and the dashboard disagrees
 * with what the user sees in the history list. Invalid / missing values
 * fall back to UTC so the response is still deterministic.
 */
function resolveTimeZone(raw: unknown): string {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 64) return "UTC";
  try {
    // Throws RangeError for unknown zones.
    new Intl.DateTimeFormat("en-US", { timeZone: raw });
    return raw;
  } catch {
    return "UTC";
  }
}

/** Start of the calendar day containing `now` in `timeZone`, as a UTC instant. */
function startOfDayIn(timeZone: string, now: Date): Date {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts: Record<string, number> = {};
  for (const p of fmt.formatToParts(now)) {
    if (p.type !== "literal") parts[p.type] = Number(p.value);
  }
  const y = parts.year ?? now.getUTCFullYear();
  const m = (parts.month ?? now.getUTCMonth() + 1) - 1;
  const d = parts.day ?? now.getUTCDate();
  // Wall-clock "now" in the zone, read as if it were UTC → the difference to
  // the real instant is the zone's current UTC offset.
  const wallNow = Date.UTC(y, m, d, parts.hour ?? 0, parts.minute ?? 0, parts.second ?? 0);
  const offsetMs = wallNow - Math.floor(now.getTime() / 1000) * 1000;
  return new Date(Date.UTC(y, m, d) - offsetMs);
}

/**
 * Cutoff instant for a range, or null for "all". Rolling windows for
 * week/month/quarter (the user reasons "últimos 7 días"), calendar day for
 * today — both screens must use exactly this function.
 */
export function rangeStart(range: RangeKey, timeZone: string, now = new Date()): Date | null {
  const day = 24 * 60 * 60 * 1000;
  switch (range) {
    case "today":
      return startOfDayIn(timeZone, now);
    case "week":
      return new Date(now.getTime() - 7 * day);
    case "month":
      return new Date(now.getTime() - 30 * day);
    case "quarter":
      return new Date(now.getTime() - 90 * day);
    case "all":
      return null;
  }
}

/* -------------------------------------------------------------------------- */
/*                                GET /contracts                              */
/* -------------------------------------------------------------------------- */

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function parseIntParam(raw: unknown, fallback: number, min: number, max: number): number {
  const n = typeof raw === "string" ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}

/**
 * GET /contracts?range=&tz=&limit=&offset=
 *
 * Returns the page plus `total` — the number of runs matching the range,
 * regardless of pagination — so the history page can show "mostrando X de
 * N" and N always equals the dashboard card for the same range.
 */
export async function listContractRunsHandler(
  req: Request,
  res: Response,
): Promise<void> {
  const limit = parseIntParam(req.query.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
  const offset = parseIntParam(req.query.offset, 0, 0, 1_000_000);
  const range: RangeKey = isRangeKey(req.query.range) ? req.query.range : "all";
  const timeZone = resolveTimeZone(req.query.tz);

  const since = rangeStart(range, timeZone);
  const where = since ? { processedAt: { gte: since } } : {};

  const [rows, total] = await Promise.all([
    prisma.contractRun.findMany({
      where,
      orderBy: { processedAt: "desc" },
      skip: offset,
      take: limit,
      include: {
        processedBy: { select: { id: true, name: true, email: true } },
      },
    }) as unknown as Promise<ContractRunRow[]>,
    prisma.contractRun.count({ where }),
  ]);

  res.json({
    runs: rows.map(toPublicRun),
    total,
    range,
    tz: timeZone,
    limit,
    offset,
  });
}

/* -------------------------------------------------------------------------- */
/*                              GET /contracts/stats                          */
/* -------------------------------------------------------------------------- */

/**
 * Per-time-range counters. Drives both dashboard cards:
 *   - "Contratos procesados" — `contracts[range]`
 *   - "Minutos ahorrados"    — `lines[range] * MINUTES_SAVED_PER_LINE` (en el front)
 *
 * Definitions (all rolling windows, not calendar boundaries — el usuario
 * razona "en los últimos 7 días" y queremos evitar resets sorpresa los
 * lunes a las 00:00):
 *   today    — desde las 00:00 de hoy en la zona horaria del cliente (`?tz=`)
 *   week     — últimos 7 días
 *   month    — últimos 30 días
 *   quarter  — últimos 90 días
 *   all      — total histórico
 *
 * `lines` cuenta filas xlsx generadas (suma de `jsonb_array_length(rows)`
 * sobre los runs del rango). Es mejor proxy del tiempo manual ahorrado que
 * el conteo de contratos porque un contrato con 20 product×season ahorra
 * mucho más trabajo que uno con 1.
 */
interface ContractStatsBuckets {
  today: number;
  week: number;
  month: number;
  quarter: number;
  all: number;
}

export interface ContractStats {
  contracts: ContractStatsBuckets;
  lines: ContractStatsBuckets;
}

/**
 * Raw row shape devuelto por `$queryRaw`. Postgres devuelve `COUNT`/`SUM`
 * como `bigint`, que Prisma serializa a `bigint` en JS — los convertimos a
 * `number` explícitamente (los rangos esperados están muy lejos de los
 * 2^53 límites de Number).
 */
interface StatsRow {
  c_today: bigint;
  c_week: bigint;
  c_month: bigint;
  c_quarter: bigint;
  c_all: bigint;
  l_today: bigint;
  l_week: bigint;
  l_month: bigint;
  l_quarter: bigint;
  l_all: bigint;
}

const toInt = (v: bigint | number | null | undefined): number =>
  typeof v === "bigint" ? Number(v) : typeof v === "number" ? v : 0;

export async function contractRunStatsHandler(
  req: Request,
  res: Response,
): Promise<void> {
  const now = new Date();
  const timeZone = resolveTimeZone(req.query.tz);

  // Same cutoffs as GET /contracts (see `rangeStart`) so the two screens
  // can never disagree on which runs fall inside a range.
  const startOfToday = rangeStart("today", timeZone, now) as Date;
  const sevenDaysAgo = rangeStart("week", timeZone, now) as Date;
  const thirtyDaysAgo = rangeStart("month", timeZone, now) as Date;
  const ninetyDaysAgo = rangeStart("quarter", timeZone, now) as Date;

  // Single round-trip: contamos contratos y sumamos filas (jsonb_array_length)
  // en una sola query usando FILTER clauses. El índice en processed_at hace
  // que cada bucket sea efectivamente un range-scan barato.
  const rows = await prisma.$queryRaw<StatsRow[]>`
    SELECT
      COUNT(*) FILTER (WHERE "processed_at" >= ${startOfToday})  AS c_today,
      COUNT(*) FILTER (WHERE "processed_at" >= ${sevenDaysAgo})  AS c_week,
      COUNT(*) FILTER (WHERE "processed_at" >= ${thirtyDaysAgo}) AS c_month,
      COUNT(*) FILTER (WHERE "processed_at" >= ${ninetyDaysAgo}) AS c_quarter,
      COUNT(*)                                                    AS c_all,
      COALESCE(SUM(jsonb_array_length("rows")) FILTER (WHERE "processed_at" >= ${startOfToday}),  0) AS l_today,
      COALESCE(SUM(jsonb_array_length("rows")) FILTER (WHERE "processed_at" >= ${sevenDaysAgo}),  0) AS l_week,
      COALESCE(SUM(jsonb_array_length("rows")) FILTER (WHERE "processed_at" >= ${thirtyDaysAgo}), 0) AS l_month,
      COALESCE(SUM(jsonb_array_length("rows")) FILTER (WHERE "processed_at" >= ${ninetyDaysAgo}), 0) AS l_quarter,
      COALESCE(SUM(jsonb_array_length("rows")),                                                   0) AS l_all
    FROM "contract_runs"
  `;

  // `$queryRaw` siempre devuelve un array; con agregaciones sin GROUP BY
  // siempre hay exactamente 1 fila (todos zeros si la tabla está vacía).
  const row = rows[0] ?? null;

  const stats: ContractStats = {
    contracts: {
      today: toInt(row?.c_today),
      week: toInt(row?.c_week),
      month: toInt(row?.c_month),
      quarter: toInt(row?.c_quarter),
      all: toInt(row?.c_all),
    },
    lines: {
      today: toInt(row?.l_today),
      week: toInt(row?.l_week),
      month: toInt(row?.l_month),
      quarter: toInt(row?.l_quarter),
      all: toInt(row?.l_all),
    },
  };

  res.json({ stats, tz: timeZone });
}


/* -------------------------------------------------------------------------- */
/*                   GET /contracts/last?supplier=CODIGO (memoria)            */
/* -------------------------------------------------------------------------- */

/**
 * Memoria por proveedor: la última configuración CONFIRMADA por un humano
 * para este proveedor (lo que quedó en el xlsx), resumida. Se inyecta al
 * modelo como "interpretación confirmada anterior" y se muestra en el Paso 2
 * para que el revisor vea qué cambió respecto a la vez pasada.
 *
 * Es memoria explícita y visible, no aprendizaje opaco: siempre se muestra
 * de dónde viene (archivo, fecha) y el documento actual manda.
 */
export interface SupplierMemory {
  runId: string;
  processedAt: string;
  filename: string;
  shared: Record<string, string | null>;
  manual: Record<string, unknown> | null;
  products: string[];
  seasons: { name: string | null; starts: string | null; ends: string | null }[];
  occupancies: string[];
  codigosServicio: string[];
  rowCount: number;
}

export async function lastContractRunForSupplierHandler(
  req: Request,
  res: Response,
): Promise<void> {
  const codigo = typeof req.query.supplier === "string" ? req.query.supplier.trim() : "";
  if (!codigo) throw ApiError.badRequest("`supplier` (código del maestro) es requerido.");

  const rows = await prisma.$queryRaw<
    { id: string; processed_at: Date; filename: string; shared_fields: Record<string, unknown>; manual_fields: Record<string, unknown> | null; rows: Record<string, unknown>[] }[]
  >`
    SELECT id, processed_at, filename, shared_fields, manual_fields, rows
    FROM contract_runs
    WHERE catalog_prefill ->> 'proveedor_codigo' = ${codigo}
    ORDER BY processed_at DESC
    LIMIT 1
  `;
  const r = rows[0];
  if (!r) {
    res.json({ memory: null });
    return;
  }
  const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
  const sf = r.shared_fields ?? {};
  const keep = [
    "proveedor", "nombre_comercial", "cedula", "pais", "state_province", "type_of_business",
    "reservations_email", "telefono", "contract_starts", "contract_ends", "tipo_unidad",
    "tipo_servicio", "tipo_moneda", "numero_cuenta", "banco", "others_payment_cancel",
  ] as const;
  const shared: Record<string, string | null> = {};
  for (const k of keep) shared[k] = str(sf[k]);

  const uniq = (xs: (string | null)[]) => Array.from(new Set(xs.filter((x): x is string => !!x))).slice(0, 40);
  const rowsArr = Array.isArray(r.rows) ? r.rows : [];
  const seasonsSeen = new Map<string, { name: string | null; starts: string | null; ends: string | null }>();
  for (const row of rowsArr) {
    const k = `${str(row.season_name) ?? ""}|${str(row.season_starts) ?? ""}|${str(row.season_ends) ?? ""}`;
    if (!seasonsSeen.has(k)) seasonsSeen.set(k, { name: str(row.season_name), starts: str(row.season_starts), ends: str(row.season_ends) });
  }

  const memory: SupplierMemory = {
    runId: r.id,
    processedAt: r.processed_at.toISOString(),
    filename: r.filename,
    shared,
    manual: r.manual_fields ?? null,
    products: uniq(rowsArr.map((row) => str(row.product_name))),
    seasons: [...seasonsSeen.values()].slice(0, 12),
    occupancies: uniq(rowsArr.map((row) => str(row.ocupacion))),
    codigosServicio: uniq(rowsArr.map((row) => str(row.codigo_servicio))),
    rowCount: rowsArr.length,
  };
  res.json({ memory });
}

/* -------------------------------------------------------------------------- */
/*                          GET /contracts/quality                            */
/* -------------------------------------------------------------------------- */

/**
 * Panel de calidad: agrega el `feedback` de los runs del rango. Es la
 * versión "gratis" de un fixture por contrato: cada run real mide dónde
 * acertó el pre-scan, cuánto corrigió la persona a la IA y qué hallazgos
 * del QA se repiten. Sin IA, sólo lectura.
 */
export async function contractRunQualityHandler(req: Request, res: Response): Promise<void> {
  const range: RangeKey = isRangeKey(req.query.range) ? req.query.range : "quarter";
  const timeZone = resolveTimeZone(req.query.tz);
  const since = rangeStart(range, timeZone);
  const rows = await prisma.contractRun.findMany({
    where: since ? { processedAt: { gte: since } } : {},
    orderBy: { processedAt: "desc" },
    take: 2000,
    select: { feedback: true, catalogPrefill: true, filename: true },
  });
  const report = buildQualityReport(
    range,
    rows.map((r) => ({
      feedback: (r.feedback as RunFeedback | null) ?? null,
      supplier:
        r.catalogPrefill && typeof r.catalogPrefill === "object"
          ? ((r.catalogPrefill as { proveedor_codigo?: unknown }).proveedor_codigo as string | undefined) ?? null
          : null,
      filename: r.filename,
    })),
  );
  res.json({ quality: report, tz: timeZone });
}
