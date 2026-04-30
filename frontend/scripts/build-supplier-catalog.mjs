#!/usr/bin/env node
// @ts-check
/**
 * Build script — convierte data/CrtLisProv.xlsx en src/lib/supplierCatalog.ts.
 *
 * Por qué un script: el archivo tiene ~14k filas (~2 MB sin compactar). Generar
 * un módulo TS al build evita parsear xlsx en el browser, mantiene tipos
 * estrictos y permite que Next.js code-splittee el JSON vía dynamic import.
 *
 * Cómo correrlo:
 *   - desde frontend/:  `npm run build:catalog`
 *   - es idempotente: si el xlsx no cambió, sobreescribe con contenido idéntico
 *
 * Cuándo correrlo:
 *   - cada vez que reemplaces frontend/data/CrtLisProv.xlsx con una versión
 *     más reciente del maestro de proveedores
 *
 * Importante: usamos la lib `xlsx` instalada en el backend (no agregamos una
 * devDep al frontend) — el script resuelve la lib desde ../backend/node_modules.
 */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { writeFileSync, existsSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FRONTEND_ROOT = resolve(__dirname, "..");
const REPO_ROOT = resolve(FRONTEND_ROOT, "..");
const XLSX_PATH = resolve(FRONTEND_ROOT, "data", "CrtLisProv.xlsx");
const OUT_PATH = resolve(FRONTEND_ROOT, "src", "lib", "supplierCatalog.ts");

// Resolver `xlsx` desde el backend para no inflar las deps del frontend con
// algo que solo se necesita en build-time.
const backendRequire = createRequire(resolve(REPO_ROOT, "backend", "package.json"));
let XLSX;
try {
  XLSX = backendRequire("xlsx");
} catch (err) {
  console.error(
    "[build-supplier-catalog] No pude cargar 'xlsx' desde backend/node_modules.\n" +
      "Asegúrate de haber corrido `npm install` en backend/ primero.",
  );
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}

if (!existsSync(XLSX_PATH)) {
  console.error(`[build-supplier-catalog] Falta el archivo: ${XLSX_PATH}`);
  console.error(
    "Coloca CrtLisProv.xlsx en frontend/data/ y vuelve a correr el script.",
  );
  process.exit(1);
}

console.log(`[build-supplier-catalog] Leyendo ${XLSX_PATH}…`);
const workbook = XLSX.readFile(XLSX_PATH);
const sheetName = workbook.SheetNames[0];
if (!sheetName) {
  console.error("[build-supplier-catalog] El xlsx no tiene hojas.");
  process.exit(1);
}
const sheet = workbook.Sheets[sheetName];

/**
 * @typedef {{ Actividad: string|null, Zona: string|null, proveedor: string|null, Nombre: string|null, Servicio: string|null, "Descripción": string|null }} RawRow
 */
/** @type {RawRow[]} */
const rows = XLSX.utils.sheet_to_json(sheet, { defval: null });

// --- Normalización ---

/** Trim + colapsa espacios. Devuelve null si queda vacío. */
const clean = (v) => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim().replace(/\s+/g, " ");
  return s === "" ? null : s;
};

/** Quita acentos + lowercase + colapsa espacios. Llave de búsqueda. */
const normalizeKey = (s) => {
  if (!s) return "";
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
};

// --- Agrupación por proveedor ---
/**
 * @typedef {{ codigo: string, nombre: string|null, actividad: string|null, zona: string|null, servicios: Array<[string, string|null]> }} SupplierRecord
 */
/** @type {Map<string, SupplierRecord & { _actividadCounts: Map<string, number>, _zonaCounts: Map<string, number>, _nombreCounts: Map<string, number> }>} */
const byCode = new Map();

/** Helper: incrementa un contador en un Map. */
const bump = (m, key) => {
  if (!key) return;
  m.set(key, (m.get(key) ?? 0) + 1);
};

/** Helper: devuelve el valor con mayor frecuencia, o null. */
const topOf = (m) => {
  let best = null;
  let bestCount = -1;
  for (const [k, c] of m) {
    if (c > bestCount) {
      best = k;
      bestCount = c;
    }
  }
  return best;
};

let skipped = 0;
for (const row of rows) {
  const codigo = clean(row.proveedor);
  if (!codigo) {
    skipped++;
    continue;
  }
  const actividad = clean(row.Actividad);
  const zona = clean(row.Zona);
  const nombre = clean(row.Nombre);
  const servicio = clean(row.Servicio);
  const descripcion = clean(row["Descripción"]);

  let rec = byCode.get(codigo);
  if (!rec) {
    rec = {
      codigo,
      nombre: null,
      actividad: null,
      zona: null,
      servicios: [],
      _actividadCounts: new Map(),
      _zonaCounts: new Map(),
      _nombreCounts: new Map(),
    };
    byCode.set(codigo, rec);
  }

  bump(rec._actividadCounts, actividad);
  bump(rec._zonaCounts, zona);
  bump(rec._nombreCounts, nombre);

  if (servicio) {
    rec.servicios.push([servicio, descripcion]);
  }
}

// Resolver moda + limpiar contadores internos (no se serializan).
/** @type {SupplierRecord[]} */
const suppliers = [];
for (const rec of byCode.values()) {
  rec.actividad = topOf(rec._actividadCounts);
  rec.zona = topOf(rec._zonaCounts);
  rec.nombre = topOf(rec._nombreCounts);
  delete rec._actividadCounts;
  delete rec._zonaCounts;
  delete rec._nombreCounts;
  suppliers.push(rec);
}

// Orden estable para diffs predecibles en git.
suppliers.sort((a, b) => a.codigo.localeCompare(b.codigo));
for (const s of suppliers) {
  s.servicios.sort((a, b) => a[0].localeCompare(b[0]));
}

// --- Índice de búsqueda ---
// Mapa normalizedKey -> codigo. Indexamos tanto por `nombre` (típico match
// contra el dato extraído por la IA, que suele ser el nombre comercial) como
// por `codigo` (por si el contrato trae el código del maestro).
/** @type {Record<string, string>} */
const indexByName = {};
for (const s of suppliers) {
  if (s.nombre) {
    const k = normalizeKey(s.nombre);
    if (k && !indexByName[k]) indexByName[k] = s.codigo;
  }
  if (s.codigo) {
    const k = normalizeKey(s.codigo);
    if (k && !indexByName[k]) indexByName[k] = s.codigo;
  }
}

// --- Salida ---
const SOURCE_FILE = "data/CrtLisProv.xlsx";
const totalServicios = suppliers.reduce((sum, s) => sum + s.servicios.length, 0);

const banner =
  `// AUTO-GENERATED — no editar a mano.\n` +
  `// Fuente: frontend/${SOURCE_FILE}\n` +
  `// Regenerar: \`npm run build:catalog\` (desde frontend/).\n` +
  `// Stats: ${suppliers.length} proveedores · ${totalServicios} servicios · ${rows.length} filas crudas.\n`;

const tsBody =
  `export interface CatalogService {\n` +
  `  /** Código de servicio del maestro (columna "Servicio"). */\n` +
  `  codigo: string;\n` +
  `  /** Descripción libre del servicio (columna "Descripción"). */\n` +
  `  descripcion: string | null;\n` +
  `}\n\n` +
  `export interface CatalogSupplier {\n` +
  `  /** Código corto del proveedor en el maestro (columna "proveedor"). */\n` +
  `  codigo: string;\n` +
  `  /** Nombre comercial visible (columna "Nombre"). */\n` +
  `  nombre: string | null;\n` +
  `  /** Tipo de actividad (columna "Actividad"). */\n` +
  `  actividad: string | null;\n` +
  `  /** Zona/destino turístico (columna "Zona"). */\n` +
  `  zona: string | null;\n` +
  `  /** Servicios del proveedor — un proveedor tiene N servicios. */\n` +
  `  servicios: CatalogService[];\n` +
  `}\n\n` +
  `/** Total de proveedores en el catálogo. */\n` +
  `export const SUPPLIER_COUNT = ${suppliers.length};\n\n` +
  `/** Catálogo completo, ordenado por \`codigo\`. */\n` +
  `export const SUPPLIERS: CatalogSupplier[] = ${JSON.stringify(
    suppliers.map((s) => ({
      codigo: s.codigo,
      nombre: s.nombre,
      actividad: s.actividad,
      zona: s.zona,
      servicios: s.servicios.map(([codigo, descripcion]) => ({ codigo, descripcion })),
    })),
  )};\n\n` +
  `/**\n` +
  ` * Índice precomputado: \`normalizedKey -> codigo\`.\n` +
  ` * - Llaves: nombre comercial y código, ambos pasados por \`normalizeKey\`\n` +
  ` *   (sin acentos, lowercase, sin signos, espacios colapsados).\n` +
  ` * - Empate: gana el primero (orden alfabético por código).\n` +
  ` */\n` +
  `export const SUPPLIER_INDEX_BY_NAME: Record<string, string> = ${JSON.stringify(
    indexByName,
  )};\n`;

writeFileSync(OUT_PATH, banner + "\n" + tsBody, "utf8");

console.log(
  `[build-supplier-catalog] OK · ${suppliers.length} proveedores · ${totalServicios} servicios · ${skipped} filas sin código (descartadas).`,
);
console.log(`[build-supplier-catalog] Generado: ${OUT_PATH}`);
