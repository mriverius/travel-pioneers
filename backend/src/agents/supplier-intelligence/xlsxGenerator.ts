import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as XLSX from "xlsx";
import type { WorkBook, WorkSheet } from "xlsx";
import type { ContractRow, ManualFields, SharedFields, TipoUnidad } from "./types.js";
import {
  CATALOG_PREFILL_COL,
  DATE_ROW_FIELDS,
  DATE_SHARED_FIELDS,
  MANUAL_COL,
  ROW_CLASSIFICATION_COL,
  ROW_COL,
  SHARED_COL,
  TEMPLATE_DATA_SHEET_NAME,
  TEMPLATE_DATA_START_ROW,
  TIPO_TARIFA_FDS_COLS,
  TIPO_TARIFA_REGULAR_COLS,
} from "./xlsxColumnMap.js";

/**
 * Generador del xlsx final con los datos extraídos. Toma la plantilla
 * `frontend/data/plantilla-agente-utopia.xlsx` como base, clona la hoja de
 * datos, escribe N filas (una por combinación product × season) con los
 * valores compartidos replicados, y renombra la hoja a
 * `${PROVEEDOR}_${YEAR}` (sanitized).
 *
 * Preserva las hojas auxiliares "Tipos de Servicio" y "Categorias" intactas
 * para que el archivo descargado siga teniendo el catálogo embebido.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Ruta a la plantilla. Ahora vive en `backend/data/` para que el contenedor
 * de producción pueda encontrarla sin depender del directorio frontend.
 */
const TEMPLATE_PATH = resolve(
  __dirname,
  "..",
  "..",
  "..",
  "data",
  "plantilla-agente-utopia.xlsx",
);

/**
 * Datos del prefill del catálogo lista-proveedores que el frontend manda al
 * generar el xlsx (cuando el supplier existe). Si null, las columnas A, B,
 * C y N quedan vacías para que el equipo de operaciones las llene a mano.
 */
export interface CatalogPrefillInput {
  tipo_actividad: string | null;
  zona_turismo: string | null;
  /** Código corto del proveedor en el maestro (columna C). */
  proveedor_codigo: string | null;
  codigo_servicio: string | null;
}

export interface GenerateXlsxInput {
  shared_fields: SharedFields;
  rows: ContractRow[];
  catalog_prefill?: CatalogPrefillInput | null;
  /**
   * Campos "manuales" que el usuario llenó en step 2 — son shared (se
   * replican en cada fila) pero no salen del contrato ni del catálogo.
   * Cuando viene null/undefined, las columnas X, AA, AC, AD, AG, AK, AP,
   * AQ, AU..AZ quedan vacías en el xlsx. Las notas globales del
   * contrato viven ahora en `shared_fields.notes` (columna BA), no acá.
   */
  manual_fields?: ManualFields | null;
}

/** Resultado de la generación: buffer + filename sugerido. */
export interface GenerateXlsxResult {
  buffer: Buffer;
  filename: string;
}

/**
 * Cargar la plantilla en memoria. Cacheamos el contenido raw porque la
 * plantilla no cambia entre requests; pero parseamos a workbook por request
 * para no compartir state mutable entre invocaciones.
 */
let templateBufferCache: Buffer | null = null;

function loadTemplate(): Buffer {
  if (templateBufferCache) return templateBufferCache;
  if (!existsSync(TEMPLATE_PATH)) {
    throw new Error(
      `No se encontró la plantilla en ${TEMPLATE_PATH}. ` +
        `Verifica que frontend/data/plantilla-agente-utopia.xlsx exista.`,
    );
  }
  templateBufferCache = readFileSync(TEMPLATE_PATH);
  return templateBufferCache;
}

/**
 * Limpia un string para usarlo como nombre de hoja de Excel:
 *   - max 31 caracteres
 *   - sin caracteres prohibidos: : \ / ? * [ ]
 *   - sin paréntesis ni símbolos exóticos (los reemplazamos por _)
 *   - colapsa espacios múltiples
 */
function sanitizeSheetName(raw: string): string {
  const cleaned = raw
    .replace(/[:\\/?*[\]]/g, "_")
    .replace(/[^\w\s-]/g, "_")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .toUpperCase();
  return cleaned.slice(0, 31) || "CONTRATO";
}

/**
 * Limpia un string para usarlo como filename de descarga:
 *   - solo caracteres URL-safe (alfanumérico, guiones, underscores)
 *   - sin path separators
 */
function sanitizeFilename(raw: string): string {
  return raw
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
}

/**
 * Construir el nombre de hoja `${PROVEEDOR}_${YEAR}` a partir del nombre
 * comercial o razón social, y la fecha del contrato (o contract_starts).
 */
/**
 * Año "operativo" del contrato — prioriza contract_ends sobre contract_starts
 * porque un contrato que empieza el 20-dic-2025 y termina el 14-nov-2026 es
 * un contrato de la "temporada 2026", no 2025. Fallback: fecha de firma, y
 * último recurso el año actual.
 */
function extractYear(shared: SharedFields): string {
  const sources = [shared.contract_ends, shared.contract_starts, shared.fecha];
  for (const src of sources) {
    const m = src?.match(/^(\d{4})/);
    if (m) return m[1] as string;
  }
  return new Date().getUTCFullYear().toString();
}

function buildSheetName(shared: SharedFields): string {
  const name = shared.nombre_comercial?.trim() || shared.proveedor?.trim() || "CONTRATO";
  const year = extractYear(shared);
  const baseName = sanitizeSheetName(name);
  // Reservamos los últimos 5 chars para "_YYYY" (1 underscore + 4 dígitos)
  const trimmedBase = baseName.slice(0, 31 - 5);
  return `${trimmedBase}_${year}`;
}

function buildFilename(shared: SharedFields): string {
  const name = shared.nombre_comercial?.trim() || shared.proveedor?.trim() || "contrato";
  const year = extractYear(shared);
  return `${sanitizeFilename(name)}-${year}.xlsx`;
}

/**
 * Escribe un valor en una celda de la hoja preservando el formato como
 * string. Convertimos números a string en upstream — aquí asumimos string.
 *
 * Si el valor es null/empty, NO escribimos nada (deja la celda vacía,
 * preservando el estilo de la plantilla).
 */
function writeCell(
  sheet: WorkSheet,
  colLetter: string,
  rowIndex1Based: number,
  value: string | null | undefined,
): void {
  if (value === null || value === undefined || value === "") return;
  const ref = `${colLetter}${rowIndex1Based}`;
  sheet[ref] = { t: "s", v: value };
}

/* -------------------------------------------------------------------------- */
/*                       Bug-fix helpers                                      */
/* -------------------------------------------------------------------------- */

/**
 * Bug #3 — Date normalization. Acepta cualquiera de los formatos que la IA
 * o el usuario puedan haber dejado pasar (ISO, datetime, M/D/YYYY,
 * D-M-YYYY, "January 6, 2026", etc.) y devuelve siempre YYYY-MM-DD.
 *
 * Reglas:
 *   - null / "" / undefined  → "NOT AVAILABLE"
 *   - "NOT AVAILABLE" (case-insensitive) → "NOT AVAILABLE"
 *   - YYYY-MM-DD ya está OK
 *   - M/D/YYYY o MM/DD/YYYY → asumir convención US (es lo que la mayoría
 *     de contratos en EN escriben). Es ambiguo, pero el system prompt
 *     siempre exige YYYY-MM-DD del modelo, así que esta rama es solo un
 *     safety net para datos legacy / manuales.
 *   - Cualquier otra cosa que `Date.parse` interprete → la pasamos por ahí
 *   - Imposible de parsear → "NOT AVAILABLE" (Bug #3 spec: NUNCA dejar la
 *     celda en blanco para columnas de fecha).
 */
function normalizeDate(input: unknown): string {
  if (input === null || input === undefined) return "NOT AVAILABLE";
  const raw = typeof input === "string" ? input.trim() : String(input).trim();
  if (raw === "") return "NOT AVAILABLE";
  if (raw.toUpperCase() === "NOT AVAILABLE") return "NOT AVAILABLE";

  // Already YYYY-MM-DD — fast path.
  const iso = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (iso) {
    const [, y, m, d] = iso;
    return `${y}-${m!.padStart(2, "0")}-${d!.padStart(2, "0")}`;
  }

  // ISO datetime (e.g. "2026-01-06T00:00:00Z") — keep the date part only.
  const isoDt = raw.match(/^(\d{4})-(\d{2})-(\d{2})T/);
  if (isoDt) {
    return `${isoDt[1]}-${isoDt[2]}-${isoDt[3]}`;
  }

  // M/D/YYYY or MM/DD/YYYY (US convention, dash variants too).
  const slashy = raw.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (slashy) {
    const [, m, d, y] = slashy;
    return `${y}-${m!.padStart(2, "0")}-${d!.padStart(2, "0")}`;
  }

  // Last resort: Date.parse — handles "January 6, 2026", "Jan 6 2026", etc.
  // Use UTC components to avoid local-tz drift around midnight.
  const parsed = new Date(raw);
  if (!Number.isNaN(parsed.getTime())) {
    const y = parsed.getUTCFullYear();
    const m = String(parsed.getUTCMonth() + 1).padStart(2, "0");
    const d = String(parsed.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }

  return "NOT AVAILABLE";
}

/**
 * Tipo de tarifa por columna: las columnas "neta" siempre van "1" y las
 * "mayorista" siempre "2" (regla de negocio, incluye sus variantes de fin
 * de semana). Un override manual explícito 1/2 desde step 2 gana.
 */
const TIPO_TARIFA_FIXED: Record<string, "1" | "2"> = {
  X: "1", // Tipo Tarifa Neta
  AA: "2", // Tipo Tarifa Mayorista
  AC: "1", // Tipo Tarifa Fin Semana (neta)
  AD: "1", // T.Tar Neta Fin Semana
  AG: "2", // Tipo Tarifa Mayorista Fin de Semana
};

/** Convierte "1,644.15", "$70", "25%" → 70 / 25 etc. null si no es numérico. */
function parseAmount(raw: string | null | undefined): number | null {
  if (raw == null) return null;
  const cleaned = String(raw).replace(/[^\d.-]/g, "");
  if (cleaned === "" || cleaned === "-" || cleaned === ".") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** Quita el símbolo "%" y deja solo el número. */
function stripPercent(raw: string | null): string | null {
  if (raw == null) return null;
  const v = raw.replace(/%/g, "").trim();
  return v === "" ? null : v;
}

/**
 * La tarifa neta (precio a la agencia) siempre es ≤ que la rack (precio
 * público). Si vienen invertidas, las intercambia.
 */
function orderNetRack(
  neto: string | null,
  rack: string | null,
): [string | null, string | null] {
  const n = parseAmount(neto);
  const r = parseAmount(rack);
  if (n !== null && r !== null && n > r) return [rack, neto];
  return [neto, rack];
}

/** Corrige precios neto/rack invertidos y limpia el "%" de las comisiones. */
function normalizeRowFinancials(row: ContractRow): ContractRow {
  const [neto, rack] = orderNetRack(row.precios_neto_iva, row.precio_rack_iva);
  const [netoFds, rackFds] = orderNetRack(
    row.precios_neto_iva_fds,
    row.precio_rack_iva_fds,
  );
  return {
    ...row,
    precios_neto_iva: neto,
    precio_rack_iva: rack,
    precios_neto_iva_fds: netoFds,
    precio_rack_iva_fds: rackFds,
    porcentaje_comision: stripPercent(row.porcentaje_comision),
    porcentaje_comision_fds: stripPercent(row.porcentaje_comision_fds),
  };
}

/**
 * Bug #2 — derivar el código corto a partir del nombre del producto.
 * Solo se usa como FALLBACK cuando ni la fila ni el catalog_prefill traen
 * un valor. La IA es la fuente primaria; este mapping garantiza que la
 * columna N nunca quede vacía.
 *
 * Reglas alineadas con el system prompt y la categoría del catálogo Utopía
 * para HO. Evaluación en orden de especificidad (master antes que suite,
 * suite antes que premium, etc.) — así "Vista Master Suite" mapea a MAS
 * y no a SUI.
 */
function deriveCodigoServicioFromProduct(product: string | null): string {
  if (!product) return "STD";
  const p = product.toLowerCase();

  if (p.includes("master suite")) return "MAS";
  if (p.includes("penthouse")) return "PNT";
  if (p.includes("family suite") || p.includes("family room")) return "FAM";
  if (p.includes("deluxe suite") || p.includes("deluxe")) return "DLX";
  if (p.includes("junior suite")) return "JUN";
  // Cualquier otra "... Suite" cae en SUI (Infinity, Vista, etc.)
  if (p.includes("suite")) return "SUI";
  if (p.includes("premium")) return "PRM";
  if (p.includes("standard") || p.includes("garden") || p.includes("tropical")) return "STD";
  if (p.includes("superior")) return "SUP";
  if (p.includes("villa")) return "VIL";
  if (p.includes("bungalow") || p.includes("boungalow")) return "BUN";
  if (p.includes("ocean view")) return "OCV";
  // Tour / actividad / transfer / comida — heurística por keywords típicas.
  if (
    p.includes("tour") ||
    p.includes("hike") ||
    p.includes("watching") ||
    p.includes("transfer") ||
    p.includes("breakfast") ||
    p.includes("dinner") ||
    p.includes("lunch") ||
    p.includes("almuerzo") ||
    p.includes("cena") ||
    p.includes("desayuno") ||
    p.includes("comida") ||
    p.includes("picnic") ||
    p.includes("canopy") ||
    p.includes("kayak") ||
    p.includes("zip") ||
    p.includes("safari")
  ) {
    return "UNI";
  }
  return "STD";
}

/**
 * Bug #5 — fallback de tipo_servicio cuando ni la fila ni shared traen
 * valor. Heurística defensiva: tour si el nombre del producto sugiere
 * tour, transfer si dice transfer, comida si dice meal/breakfast/dinner;
 * todo lo demás cae a "OT" (OTHER) que es válido en el catálogo.
 */
function inferTipoServicioFromProduct(product: string | null): string {
  if (!product) return "OT";
  const p = product.toLowerCase();
  if (p.includes("transfer") || p.includes("shuttle")) return "TR";
  if (
    p.includes("tour") ||
    p.includes("hike") ||
    p.includes("watching") ||
    p.includes("canopy") ||
    p.includes("safari") ||
    p.includes("kayak") ||
    p.includes("zip")
  ) {
    return "TO";
  }
  if (
    p.includes("breakfast") ||
    p.includes("dinner") ||
    p.includes("lunch") ||
    p.includes("meal") ||
    p.includes("almuerzo") ||
    p.includes("cena") ||
    p.includes("desayuno") ||
    p.includes("comida") ||
    p.includes("picnic")
  ) {
    return "AL";
  }
  if (p.includes("rent a car") || p.includes("car rental")) return "RE";
  return "OT";
}

/**
 * Resolución por fila de los tres campos de clasificación (Bug #1, #2, #5).
 * Orden de precedencia:
 *   1. valor por fila (override de la IA)
 *   2. valor shared del contrato
 *   3. heurística sobre product_name
 *   4. fallback duro ("STD" / "UNI" / "N" / "OT")
 *
 * NUNCA devuelve string vacío — si todas las fuentes fallan, usa el
 * fallback duro para garantizar que las columnas P, Q, R, N siempre
 * lleven algo.
 */
function resolveRowClassification(
  row: ContractRow,
  shared: SharedFields,
  catalogPrefill: CatalogPrefillInput | null | undefined,
): {
  tipoServicio: string;
  tipoUnidad: TipoUnidad;
  codigoServicio: string;
  categoria: string;
} {
  const tipoServicio =
    row.tipo_servicio?.trim() ||
    shared.tipo_servicio?.trim() ||
    inferTipoServicioFromProduct(row.product_name);

  const rowUnidad = row.tipo_unidad === "N" || row.tipo_unidad === "S" ? row.tipo_unidad : null;
  const sharedUnidad =
    shared.tipo_unidad === "N" || shared.tipo_unidad === "S" ? shared.tipo_unidad : null;
  const tipoUnidad: TipoUnidad =
    rowUnidad ?? sharedUnidad ?? (tipoServicio === "HO" ? "N" : "S");

  const codigoServicio =
    row.codigo_servicio?.trim() ||
    catalogPrefill?.codigo_servicio?.trim() ||
    deriveCodigoServicioFromProduct(row.product_name);

  const categoria =
    row.categoria?.trim() ||
    (tipoServicio === "HO" ? deriveCodigoServicioFromProduct(row.product_name) : "UNI") ||
    (tipoServicio === "HO" ? "STD" : "UNI");

  return { tipoServicio, tipoUnidad, codigoServicio, categoria };
}

/**
 * Expandir el `!ref` de la hoja para incluir todas las filas escritas. La
 * plantilla viene con `A1:AZ60` pero solo si las filas físicas existen las
 * fórmulas/celdas se ven en Excel — recalculamos para que el rango cubra
 * exactamente lo que escribimos.
 */
function expandSheetRef(sheet: WorkSheet, lastRow1Based: number): void {
  const decoded = XLSX.utils.decode_range(sheet["!ref"] ?? "A1:AZ60");
  // last row in xlsx range is 0-indexed
  const targetLastRow0 = lastRow1Based - 1;
  if (targetLastRow0 > decoded.e.r) {
    decoded.e.r = targetLastRow0;
    sheet["!ref"] = XLSX.utils.encode_range(decoded);
  }
}

/**
 * Generar el xlsx final.
 *
 * Pasos:
 *  1. Leer la plantilla.
 *  2. Tomar la hoja de datos (TEMPLATE_DATA_SHEET_NAME).
 *  3. Para cada fila i (0..rows.length-1):
 *     - Escribir los valores SHARED en las columnas correspondientes
 *     - Escribir los valores de la fila ROW en las columnas correspondientes
 *     - Escribir el catalog_prefill (si vino) en A, B, C, N
 *  4. Renombrar la hoja a `${PROVEEDOR}_${YEAR}`.
 *  5. Devolver el buffer.
 */
export function generateContractXlsx(
  input: GenerateXlsxInput,
): GenerateXlsxResult {
  if (input.rows.length === 0) {
    throw new Error("rows está vacío — no hay datos que escribir.");
  }

  const templateBuf = loadTemplate();
  const workbook: WorkBook = XLSX.read(templateBuf, {
    type: "buffer",
    cellStyles: true,
  });

  const dataSheet = workbook.Sheets[TEMPLATE_DATA_SHEET_NAME];
  if (!dataSheet) {
    throw new Error(
      `La plantilla no contiene la hoja "${TEMPLATE_DATA_SHEET_NAME}". Hojas: ${workbook.SheetNames.join(", ")}`,
    );
  }

  // Escribimos cada fila con shared + row data.
  for (let i = 0; i < input.rows.length; i++) {
    const xlsxRow = TEMPLATE_DATA_START_ROW + i;
    const rawRow = input.rows[i];
    if (!rawRow) continue; // unreachable per length check, but TS noUncheckedIndexedAccess requires it
    const row = normalizeRowFinancials(rawRow);

    // Catalog prefill (A, B, C) — opcional. NOTA: la columna N
    // (codigo_servicio) ya NO se escribe acá — se resuelve más abajo
    // por fila (Bug #2).
    if (input.catalog_prefill) {
      writeCell(dataSheet, CATALOG_PREFILL_COL.tipo_actividad, xlsxRow, input.catalog_prefill.tipo_actividad);
      writeCell(dataSheet, CATALOG_PREFILL_COL.zona_turismo, xlsxRow, input.catalog_prefill.zona_turismo);
      writeCell(dataSheet, CATALOG_PREFILL_COL.proveedor_codigo, xlsxRow, input.catalog_prefill.proveedor_codigo);
    }

    // Shared fields — replicados en cada fila. tipo_unidad y tipo_servicio
    // ya no están en SHARED_COL: se manejan por fila más abajo (Bug #1, #5).
    for (const [key, col] of Object.entries(SHARED_COL)) {
      if (!col) continue;
      const value = input.shared_fields[key as keyof SharedFields];
      // Bug #3 — fechas siempre normalizadas a YYYY-MM-DD.
      if (DATE_SHARED_FIELDS.includes(key as (typeof DATE_SHARED_FIELDS)[number])) {
        writeCell(dataSheet, col, xlsxRow, normalizeDate(value));
        continue;
      }
      writeCell(dataSheet, col, xlsxRow, value == null ? null : String(value));
    }

    // Manual fields — replicados en cada fila (igual que shared, pero el
    // usuario los llena directamente en la UI ya que no salen del contrato).
    // Las columnas X/AA/AC/AD/AG (tipos de tarifa) las maneja Bug #4 abajo.
    // NOTA: others_payment_cancel (AK) dejó de ser manual — ahora la IA lo
    // extrae como shared field y se escribe por el loop de SHARED_COL arriba.
    if (input.manual_fields) {
      const tipoTarifaCols = new Set<string>([
        ...TIPO_TARIFA_REGULAR_COLS,
        ...TIPO_TARIFA_FDS_COLS,
      ]);
      for (const [key, col] of Object.entries(MANUAL_COL)) {
        if (tipoTarifaCols.has(col)) continue;
        const value = input.manual_fields[key as keyof ManualFields];
        writeCell(dataSheet, col, xlsxRow, value == null ? null : String(value));
      }
    }

    // Row-specific fields
    for (const [key, col] of Object.entries(ROW_COL)) {
      if (!col) continue;
      const value = row[key as keyof ContractRow];
      // Bug #3 — fechas de temporada siempre YYYY-MM-DD.
      if (DATE_ROW_FIELDS.includes(key as (typeof DATE_ROW_FIELDS)[number])) {
        writeCell(dataSheet, col, xlsxRow, normalizeDate(value));
        continue;
      }
      writeCell(dataSheet, col, xlsxRow, value == null ? null : String(value));
    }

    // Bug #1, #2, #5 — clasificación por fila garantizada (P, Q, N, R).
    const cls = resolveRowClassification(row, input.shared_fields, input.catalog_prefill);
    writeCell(dataSheet, ROW_CLASSIFICATION_COL.tipo_unidad, xlsxRow, cls.tipoUnidad);
    writeCell(dataSheet, ROW_CLASSIFICATION_COL.tipo_servicio, xlsxRow, cls.tipoServicio);
    writeCell(dataSheet, ROW_CLASSIFICATION_COL.codigo_servicio, xlsxRow, cls.codigoServicio);
    // Categoría (R) ya viene en ROW_COL, pero el writer la reescribe acá
    // si quedó vacía después de la pasada anterior (fallback duro).
    const categoriaCol = ROW_COL.categoria;
    if (categoriaCol && (!row.categoria || row.categoria.trim() === "")) {
      writeCell(dataSheet, categoriaCol, xlsxRow, cls.categoria);
    }

    // Comidas (tipo_servicio AL): el campo es la comida en sí, no un plan
    // incluido — meals_included SIEMPRE "NONE". Se fuerza acá (autoridad
    // final) sobre lo que haya escrito el loop genérico de ROW_COL.
    if (cls.tipoServicio === "AL") {
      const mealsCol = ROW_COL.meals_included;
      if (mealsCol) writeCell(dataSheet, mealsCol, xlsxRow, "NONE");
    }

    // Tipo Tarifa: neta → "1", mayorista → "2" (fijo). Un override manual
    // explícito 1/2 desde step 2 gana sobre el valor por defecto.
    const tarifaManual: Record<string, string | null | undefined> = {
      X: input.manual_fields?.tipo_tarifa_neta,
      AA: input.manual_fields?.tipo_tarifa_mayorista,
      AC: input.manual_fields?.tipo_tarifa_fds,
      AD: input.manual_fields?.t_tar_neta_fds,
      AG: input.manual_fields?.tipo_tarifa_mayorista_fds,
    };
    for (const [col, fixed] of Object.entries(TIPO_TARIFA_FIXED)) {
      const m = tarifaManual[col]?.trim();
      writeCell(dataSheet, col, xlsxRow, m === "1" || m === "2" ? m : fixed);
    }

    // Las notas (`shared_fields.notes`) se escriben a la columna BA por
    // el loop genérico de SHARED_COL más arriba — ya no requiere
    // resolución especial.
  }

  const lastRow = TEMPLATE_DATA_START_ROW + input.rows.length - 1;
  expandSheetRef(dataSheet, lastRow);

  // Renombrar la hoja de datos a ${PROVEEDOR}_${YEAR}
  const newSheetName = buildSheetName(input.shared_fields);
  const sheetIdx = workbook.SheetNames.indexOf(TEMPLATE_DATA_SHEET_NAME);
  if (sheetIdx !== -1 && newSheetName !== TEMPLATE_DATA_SHEET_NAME) {
    // xlsx no tiene un rename helper; lo hacemos a mano preservando el orden.
    // dataSheet ya está validado arriba (early return si no existe), así que
    // aquí simplemente lo movemos al nuevo nombre.
    workbook.SheetNames[sheetIdx] = newSheetName;
    workbook.Sheets[newSheetName] = dataSheet;
    delete workbook.Sheets[TEMPLATE_DATA_SHEET_NAME];
  }

  const buffer: Buffer = XLSX.write(workbook, {
    type: "buffer",
    bookType: "xlsx",
  });

  return {
    buffer,
    filename: buildFilename(input.shared_fields),
  };
}
