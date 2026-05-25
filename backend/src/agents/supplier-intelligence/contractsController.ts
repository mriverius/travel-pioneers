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
import { normalizeDate } from "./validators.js";

/**
 * Persistence + read endpoints for Supplier Intelligence runs.
 *
 *   POST /api/supplier-intelligence/contracts          — save a finished run
 *   GET  /api/supplier-intelligence/contracts          — list (global, paginated)
 *   GET  /api/supplier-intelligence/contracts/stats    — counts per range
 *
 * Scope is global: every authenticated user reads every run; `processedById`
 * is captured for audit only. The product team explicitly chose this over
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

/**
 * Coerce a "Tipo Tarifa" code (col X — `tipo_tarifa_neta`). El sistema
 * downstream (`xlsxGenerator.inferTipoTarifa`) usa estrictamente los
 * códigos:
 *   - "1" → FIJA
 *   - "2" → PORCENTUAL
 *
 * El dropdown de la UI ahora solo deja ingresar esos dos valores, pero
 * como backstop coercemos en el backend: cualquier otra cosa
 * (texto libre legacy como "Por persona", strings con espacios, null,
 * undefined) se transforma a null y deja que el generator infiera el
 * código a partir del % comisión.
 */
const tipoTarifaCodeOrNull = (v: unknown): string | null => {
  const s = stringOrNull(v);
  if (s === null) return null;
  const trimmed = s.trim();
  return trimmed === "1" || trimmed === "2" ? trimmed : null;
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
    season_name: stringOrNull(r.season_name),
    season_starts: dateOrNull(r.season_starts),
    season_ends: dateOrNull(r.season_ends),
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
    tipo_tarifa_mayorista: stringOrNull(r.tipo_tarifa_mayorista),
    tipo_tarifa_fds: stringOrNull(r.tipo_tarifa_fds),
    t_tar_neta_fds: stringOrNull(r.t_tar_neta_fds),
    tipo_tarifa_mayorista_fds: stringOrNull(r.tipo_tarifa_mayorista_fds),
    others_payment_cancel: stringOrNull(r.others_payment_cancel),
    cond_credito: stringOrNull(r.cond_credito),
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
  processedBy: { id: string; name: string; email: string };
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
  processedBy: { id: string; name: string; email: string };
}

function toPublicRun(row: ContractRunRow): PublicContractRun {
  return {
    id: row.id,
    processedAt: row.processedAt.toISOString(),
    processedBy: row.processedBy,
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

  const created = await prisma.contractRun.create({
    data: {
      processedById: req.auth.id,
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
    },
    include: {
      processedBy: { select: { id: true, name: true, email: true } },
    },
  });

  logger.info("ContractRun saved", {
    requestId: req.id,
    runId: created.id,
    actorId: req.auth.id,
    rowCount: rows.length,
    filename,
    inputTokens,
    outputTokens,
    costUsd,
  });

  res.status(201).json({ run: toPublicRun(created as unknown as ContractRunRow) });
}

/* -------------------------------------------------------------------------- */
/*                                GET /contracts                              */
/* -------------------------------------------------------------------------- */

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export async function listContractRunsHandler(
  req: Request,
  res: Response,
): Promise<void> {
  const limitRaw = typeof req.query.limit === "string" ? Number.parseInt(req.query.limit, 10) : NaN;
  const limit = Number.isFinite(limitRaw)
    ? Math.max(1, Math.min(MAX_LIMIT, limitRaw))
    : DEFAULT_LIMIT;

  const rows = (await prisma.contractRun.findMany({
    orderBy: { processedAt: "desc" },
    take: limit,
    include: {
      processedBy: { select: { id: true, name: true, email: true } },
    },
  })) as unknown as ContractRunRow[];

  res.json({ runs: rows.map(toPublicRun) });
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
 *   today    — desde las 00:00 de hoy (hora del servidor)
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
  _req: Request,
  res: Response,
): Promise<void> {
  const now = new Date();

  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);

  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);

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

  res.json({ stats });
}
