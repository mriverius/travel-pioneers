import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as XLSX from "xlsx";
import type { WorkBook, WorkSheet } from "xlsx";
import type { ContractRow, SharedFields } from "./types.js";
import {
  CATALOG_PREFILL_COL,
  ROW_COL,
  SHARED_COL,
  TEMPLATE_DATA_SHEET_NAME,
  TEMPLATE_DATA_START_ROW,
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
 * Ruta a la plantilla. El backend vive en `backend/src/...` y la plantilla
 * en `frontend/data/...` — subimos 4 niveles desde este archivo. Si en el
 * futuro la plantilla se mueve a un paquete compartido, actualizar aquí.
 */
const TEMPLATE_PATH = resolve(
  __dirname,
  "..",
  "..",
  "..",
  "..",
  "frontend",
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
    const row = input.rows[i];
    if (!row) continue; // unreachable per length check, but TS noUncheckedIndexedAccess requires it

    // Catalog prefill (A, B, C, N) — opcional
    if (input.catalog_prefill) {
      writeCell(dataSheet, CATALOG_PREFILL_COL.tipo_actividad, xlsxRow, input.catalog_prefill.tipo_actividad);
      writeCell(dataSheet, CATALOG_PREFILL_COL.zona_turismo, xlsxRow, input.catalog_prefill.zona_turismo);
      writeCell(dataSheet, CATALOG_PREFILL_COL.proveedor_codigo, xlsxRow, input.catalog_prefill.proveedor_codigo);
      writeCell(dataSheet, CATALOG_PREFILL_COL.codigo_servicio, xlsxRow, input.catalog_prefill.codigo_servicio);
    }

    // Shared fields — replicados en cada fila
    for (const [key, col] of Object.entries(SHARED_COL)) {
      if (!col) continue;
      const value = input.shared_fields[key as keyof SharedFields];
      writeCell(dataSheet, col, xlsxRow, value == null ? null : String(value));
    }

    // Row-specific fields
    for (const [key, col] of Object.entries(ROW_COL)) {
      const value = row[key as keyof ContractRow];
      writeCell(dataSheet, col, xlsxRow, value == null ? null : String(value));
    }
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
