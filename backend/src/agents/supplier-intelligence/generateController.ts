import type { Request, Response } from "express";
import logger from "../../config/logger.js";
import ApiError from "../../utils/ApiError.js";
import {
  generateContractXlsx,
  type CatalogPrefillInput,
  type GenerateXlsxInput,
} from "./xlsxGenerator.js";
import type {
  ContractRow,
  ManualFields,
  SharedFields,
  TipoUnidad,
} from "./types.js";
import { normalizeDate } from "./validators.js";

/**
 * POST /api/supplier-intelligence/generate-xlsx
 *
 * Recibe los datos editados/aprobados de step 2 (shared_fields + rows
 * editados por el usuario en la UI) y devuelve un xlsx con la estructura de
 * `plantilla-agente-utopia.xlsx`, con N filas (una por combinación product ×
 * season) escritas a partir de la fila 7. Preserva las hojas "Tipos de
 * Servicio" y "Categorias" intactas.
 *
 * Body JSON:
 * ```
 * {
 *   "shared_fields": { fecha, proveedor, ..., banco },
 *   "rows": [ { product_name, ..., feeds_adicionales }, ... ],
 *   "catalog_prefill": { tipo_actividad, zona_turismo, proveedor_codigo, codigo_servicio } | null
 * }
 * ```
 *
 * Response: `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`
 * con `Content-Disposition: attachment; filename="..."`.
 */

const stringOrNull = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") return v;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
};

/**
 * Guardrail de fechas — TODO campo de fecha (fecha, contract_starts,
 * contract_ends, season_starts, season_ends) que entre al generator
 * tiene que salir en YYYY-MM-DD. Reusa el normalizador que ya usamos en
 * la extracción y en el save.
 */
const dateOrNull = (v: unknown): string | null => {
  return normalizeDate(stringOrNull(v)).value;
};

/**
 * "Tipo Tarifa" sólo acepta los códigos "1" (FIJA) o "2" (PORCENTUAL) —
 * los mismos que emite `inferTipoTarifa` cuando no hay valor manual.
 * Cualquier otro string se transforma a null para que el generator caiga
 * al fallback inferido.
 */
const tipoTarifaCodeOrNull = (v: unknown): string | null => {
  const s = stringOrNull(v);
  if (s === null) return null;
  const trimmed = s.trim();
  return trimmed === "1" || trimmed === "2" ? trimmed : null;
};

function coerceTipoUnidad(v: unknown): TipoUnidad | null {
  if (v === "N" || v === "S") return v;
  return null;
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

function coerceCatalogPrefill(input: unknown): CatalogPrefillInput | null {
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

function parseGenerateInput(body: unknown): GenerateXlsxInput {
  if (!body || typeof body !== "object") {
    throw ApiError.badRequest("El body debe ser un objeto JSON.");
  }
  const b = body as Record<string, unknown>;

  const shared_fields = coerceSharedFields(b.shared_fields);

  if (!Array.isArray(b.rows)) {
    throw ApiError.badRequest("`rows` debe ser un array.");
  }
  if (b.rows.length === 0) {
    throw ApiError.badRequest(
      "`rows` no puede estar vacío. Debe haber al menos una combinación product × season.",
    );
  }
  if (b.rows.length > 500) {
    // Sanity cap — un contrato razonable no excede 200 filas; >500 es señal
    // de un bug o de un payload malicioso.
    throw ApiError.badRequest(
      `Demasiadas filas (${b.rows.length}). El máximo permitido es 500.`,
    );
  }
  const rows = b.rows.map(coerceRow);

  const catalog_prefill = coerceCatalogPrefill(b.catalog_prefill);
  const manual_fields = coerceManualFields(b.manual_fields);

  // Backward-compat: clientes viejos podían mandar `notes` top-level. Si
  // viene y `shared_fields.notes` no está poblado, lo movemos adentro
  // para no perder la información durante el rollout.
  const legacyNotes = stringOrNull((b as Record<string, unknown>).notes);
  if (legacyNotes !== null && shared_fields.notes === null) {
    shared_fields.notes = legacyNotes;
  }

  return { shared_fields, rows, catalog_prefill, manual_fields };
}

export async function generateXlsxHandler(
  req: Request,
  res: Response,
): Promise<void> {
  logger.info("Supplier Intelligence xlsx generation: request received", {
    requestId: req.id,
    bodyBytes: req.headers["content-length"] ?? "?",
  });

  const input = parseGenerateInput(req.body);

  logger.info("Supplier Intelligence xlsx generation: parsed input", {
    requestId: req.id,
    rowCount: input.rows.length,
    proveedor: input.shared_fields.proveedor,
    hasCatalog: input.catalog_prefill !== null && input.catalog_prefill !== undefined,
    hasManual: input.manual_fields !== null && input.manual_fields !== undefined,
  });

  const t0 = Date.now();
  const { buffer, filename } = generateContractXlsx(input);
  const elapsed = Date.now() - t0;

  logger.info("Supplier Intelligence xlsx generation: completed", {
    requestId: req.id,
    rowCount: input.rows.length,
    sizeBytes: buffer.byteLength,
    filename,
    elapsedMs: elapsed,
  });

  // Usar res.set + res.send sin chaining para evitar cualquier ambigüedad de
  // tipos entre setHeader (Node ServerResponse) y res.send (Express). El
  // Content-Length lo calcula Express automáticamente desde el buffer.
  res.set({
    "Content-Type":
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "Content-Disposition": `attachment; filename="${filename}"`,
  });
  res.status(200).send(buffer);
}
