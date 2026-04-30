#!/usr/bin/env node
// @ts-check
/**
 * Build script — convierte las hojas "Tipos de Servicio" y "Categorias" del
 * archivo `data/CORREGIDA PLANTILLA-AGENTE-UTOPIA 28 ABRIL.xlsx` en un módulo
 * TypeScript con tres listas:
 *
 *   - TIPO_UNIDAD_OPTIONS:   {N, S} — convención fija (no viene del xlsx).
 *   - TIPOS_SERVICIO:        25 entradas {codigo, descripcion} (HO/HOTEL, TO/TOURS, …)
 *   - CATEGORIAS_BY_TIPO_SERVICIO: Record<codigoTipoServicio, Categoria[]>
 *                            agrupado para que el dropdown de Categoría se
 *                            filtre por el Tipo de Servicio seleccionado.
 *
 * El xlsx original tiene una tercera hoja con un contrato de muestra; la
 * ignoramos.
 *
 * Cómo correrlo: `npm run build:service-types` desde frontend/.
 */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { writeFileSync, existsSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FRONTEND_ROOT = resolve(__dirname, "..");
const REPO_ROOT = resolve(FRONTEND_ROOT, "..");
const XLSX_PATH = resolve(
  FRONTEND_ROOT,
  "data",
  "CORREGIDA PLANTILLA-AGENTE-UTOPIA 28 ABRIL.xlsx",
);
const OUT_PATH = resolve(FRONTEND_ROOT, "src", "lib", "serviceTypesCatalog.ts");
/**
 * Backend mirror — el agente de extracción IA necesita los mismos códigos
 * para incluirlos como enums en el tool schema y como referencia en el system
 * prompt. Generamos un módulo paralelo en backend/ para que ambos lados estén
 * en sync con una sola fuente de verdad (este script).
 */
const BACKEND_OUT_PATH = resolve(
  REPO_ROOT,
  "backend",
  "src",
  "agents",
  "supplier-intelligence",
  "generated",
  "serviceTypesData.ts",
);

// Resolver `xlsx` desde el backend para no inflar las deps del frontend.
const backendRequire = createRequire(resolve(REPO_ROOT, "backend", "package.json"));
let XLSX;
try {
  XLSX = backendRequire("xlsx");
} catch (err) {
  console.error("[build-service-types] No pude cargar 'xlsx' desde backend/node_modules.");
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}

if (!existsSync(XLSX_PATH)) {
  console.error(`[build-service-types] Falta el archivo: ${XLSX_PATH}`);
  process.exit(1);
}

console.log(`[build-service-types] Leyendo ${XLSX_PATH}…`);
const workbook = XLSX.readFile(XLSX_PATH);

const tiposSheet = workbook.Sheets["Tipos de Servicio"];
const catSheet = workbook.Sheets["Categorias"];
if (!tiposSheet) {
  console.error("[build-service-types] Falta la hoja 'Tipos de Servicio'.");
  process.exit(1);
}
if (!catSheet) {
  console.error("[build-service-types] Falta la hoja 'Categorias'.");
  process.exit(1);
}

/** Trim + null-coerce. */
const clean = (v) => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim().replace(/\s+/g, " ");
  return s === "" ? null : s;
};

// --- Tipos de Servicio ---
// Hoja sin headers — cada fila es [codigo, descripcion].
/** @type {Array<{ codigo: string, descripcion: string }>} */
const tiposServicio = [];
{
  const rows = XLSX.utils.sheet_to_json(tiposSheet, { header: 1, defval: null });
  for (const row of rows) {
    const codigo = clean(row[0]);
    const descripcion = clean(row[1]);
    if (codigo && descripcion) {
      tiposServicio.push({ codigo, descripcion });
    }
  }
}
tiposServicio.sort((a, b) => a.codigo.localeCompare(b.codigo));

// --- Categorias ---
// Hoja con header en row 0: [Tipo de Servicio, Categoría, Descripción].
/** @type {Record<string, Array<{ codigo: string, descripcion: string }>>} */
const categoriasByTipo = {};
let categoriasTotal = 0;
{
  const rows = XLSX.utils.sheet_to_json(catSheet, { defval: null });
  for (const row of rows) {
    const tipoCodigo = clean(row["Tipo de Servicio"]);
    const catCodigo = clean(row["Categoría"]);
    const catDesc = clean(row["Descripción"]);
    if (!tipoCodigo || !catCodigo) continue;
    if (!categoriasByTipo[tipoCodigo]) categoriasByTipo[tipoCodigo] = [];
    categoriasByTipo[tipoCodigo].push({
      codigo: catCodigo,
      descripcion: catDesc ?? catCodigo,
    });
    categoriasTotal++;
  }
}
// Orden alfabético dentro de cada tipo, pero "UNI" (UNIDADES) al final — es la
// opción genérica/fallback y conviene que no aparezca arriba ocupando atención.
for (const tipo of Object.keys(categoriasByTipo)) {
  categoriasByTipo[tipo].sort((a, b) => {
    if (a.codigo === "UNI" && b.codigo !== "UNI") return 1;
    if (b.codigo === "UNI" && a.codigo !== "UNI") return -1;
    return a.codigo.localeCompare(b.codigo);
  });
}

// Stats útiles (para que la cabecera del archivo generado sea útil para diagnóstico).
const tiposConCategorias = Object.keys(categoriasByTipo).length;
const tiposSinCategoria = tiposServicio
  .map((t) => t.codigo)
  .filter((c) => !categoriasByTipo[c]).length;

// --- Salida ---
const banner =
  `// AUTO-GENERATED — no editar a mano.\n` +
  `// Fuente: frontend/data/CORREGIDA PLANTILLA-AGENTE-UTOPIA 28 ABRIL.xlsx\n` +
  `// Regenerar: \`npm run build:service-types\` (desde frontend/).\n` +
  `// Stats: ${tiposServicio.length} tipos · ${categoriasTotal} categorías · ` +
  `${tiposConCategorias} tipos con categorías · ${tiposSinCategoria} tipos del catálogo sin categorías.\n`;

const tsBody =
  `export interface ServiceTypeOption {\n` +
  `  /** Código del tipo de servicio (ej: "HO", "TO", "TR"). */\n` +
  `  codigo: string;\n` +
  `  /** Descripción libre del tipo (ej: "HOTEL", "TOURS", "TRANSFER"). */\n` +
  `  descripcion: string;\n` +
  `}\n\n` +
  `export interface CategoryOption {\n` +
  `  /** Código de la categoría (ej: "OCV", "STD", "DLX"). */\n` +
  `  codigo: string;\n` +
  `  /** Descripción humana (ej: "OCEAN VIEW", "STANDARD"). */\n` +
  `  descripcion: string;\n` +
  `}\n\n` +
  `/**\n` +
  ` * Opciones para columna P (Tipo de Unidad). Convención fija del agente —\n` +
  ` * no viene del xlsx, se hardcodea según las reglas del producto.\n` +
  ` */\n` +
  `export const TIPO_UNIDAD_OPTIONS: ReadonlyArray<{ codigo: "N" | "S"; descripcion: string }> = [\n` +
  `  { codigo: "N", descripcion: "Por noche (hospedajes)" },\n` +
  `  { codigo: "S", descripcion: "Por servicio (tours, transfers, etc.)" },\n` +
  `];\n\n` +
  `/** Tipos de Servicio (columna Q). Ordenado alfabéticamente por código. */\n` +
  `export const TIPOS_SERVICIO: ReadonlyArray<ServiceTypeOption> = ${JSON.stringify(
    tiposServicio,
  )};\n\n` +
  `/**\n` +
  ` * Categorías (columna R) agrupadas por código de Tipo de Servicio.\n` +
  ` * Para mostrar las categorías de un tipo, indexar por su \`codigo\`. La\n` +
  ` * categoría "UNI" (UNIDADES) aparece al final del array de cada tipo —\n` +
  ` * es el fallback genérico.\n` +
  ` */\n` +
  `export const CATEGORIAS_BY_TIPO_SERVICIO: Readonly<Record<string, ReadonlyArray<CategoryOption>>> = ${JSON.stringify(
    categoriasByTipo,
  )};\n`;

writeFileSync(OUT_PATH, banner + "\n" + tsBody, "utf8");

// --- Salida backend: mismas estructuras + un fragmento de prompt listo para
// inyectar en el system prompt del agente de extracción.
const tipoServicioCodes = tiposServicio.map((t) => t.codigo);
const tipoServicioPromptLines = tiposServicio
  .map((t) => `  - ${t.codigo}: ${t.descripcion}`)
  .join("\n");

const categoriasPromptLines = Object.entries(categoriasByTipo)
  .map(([tipo, cats]) => {
    const cs = cats.map((c) => `${c.codigo}=${c.descripcion}`).join(", ");
    return `  - ${tipo}: ${cs}`;
  })
  .join("\n");

const backendBody =
  `// AUTO-GENERATED — no editar a mano. Mirror del catálogo del frontend.\n` +
  `// Fuente: frontend/data/CORREGIDA PLANTILLA-AGENTE-UTOPIA 28 ABRIL.xlsx\n` +
  `// Regenerar: \`npm run build:service-types\` desde frontend/.\n` +
  `// Stats: ${tiposServicio.length} tipos · ${categoriasTotal} categorías.\n\n` +
  `export interface ServiceTypeOption {\n` +
  `  codigo: string;\n` +
  `  descripcion: string;\n` +
  `}\n\n` +
  `export interface CategoryOption {\n` +
  `  codigo: string;\n` +
  `  descripcion: string;\n` +
  `}\n\n` +
  `export const TIPO_UNIDAD_CODES = ["N", "S"] as const;\n` +
  `export type TipoUnidadCode = (typeof TIPO_UNIDAD_CODES)[number];\n\n` +
  `export const TIPO_SERVICIO_CODES: ReadonlyArray<string> = ${JSON.stringify(
    tipoServicioCodes,
  )};\n\n` +
  `export const TIPOS_SERVICIO: ReadonlyArray<ServiceTypeOption> = ${JSON.stringify(
    tiposServicio,
  )};\n\n` +
  `export const CATEGORIAS_BY_TIPO_SERVICIO: Readonly<Record<string, ReadonlyArray<CategoryOption>>> = ${JSON.stringify(
    categoriasByTipo,
  )};\n\n` +
  `/**\n` +
  ` * Fragmento listo para inyectar en el system prompt del agente. Lista\n` +
  ` * todos los códigos válidos con sus descripciones para que Claude sepa\n` +
  ` * exactamente de qué picklist elegir.\n` +
  ` */\n` +
  `export const SERVICE_TYPES_PROMPT_FRAGMENT = ${JSON.stringify(
    "TIPOS DE SERVICIO VÁLIDOS (columna Q):\n" +
      tipoServicioPromptLines +
      "\n\nCATEGORÍAS VÁLIDAS POR TIPO DE SERVICIO (columna R, depende de Q):\n" +
      categoriasPromptLines,
  )};\n`;

writeFileSync(BACKEND_OUT_PATH, backendBody, "utf8");

console.log(
  `[build-service-types] OK · ${tiposServicio.length} tipos · ${categoriasTotal} categorías`,
);
console.log(`  → ${OUT_PATH}`);
console.log(`  → ${BACKEND_OUT_PATH}`);
