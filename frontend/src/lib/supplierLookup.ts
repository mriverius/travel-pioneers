/**
 * Búsqueda en el catálogo de proveedores (CrtLisProv).
 *
 * Por qué un módulo separado del JSON generado: para que `supplierCatalog.ts`
 * (1.6 MB) se cargue por **dynamic import** únicamente cuando el usuario marca
 * "Sí, existente" en step 1. Si la página inicial lo importara estáticamente,
 * los 1.6 MB entrarían al chunk del agente sin necesidad.
 *
 * Estrategia de matching:
 *   1. Normalizamos la entrada (sin acentos, lowercase, sin signos).
 *   2. Match exacto contra el índice precomputado por nombre/código.
 *   3. Si no hay exacto: escaneamos todos los proveedores y nos quedamos con el
 *      primero cuyo `nombre` normalizado **comience con** el query (más
 *      restrictivo que `includes`, evita falsos positivos como "casa" → cualquier
 *      "casa de algo").
 *   4. Como último intento, `includes` con tokens de ≥ 4 chars (filtra ruido
 *      como "S.A." o artículos).
 *
 * Si ninguno hace match, devolvemos `null` y el flujo cae al comportamiento
 * anterior (campos vacíos en step 2).
 */

import type { CatalogSupplier, CatalogService } from "./supplierCatalog";
import { api, ApiError, type MatchSupplierConfidence } from "./api";

/**
 * Normaliza un string para comparación tolerante a acentos/casing/signos.
 * Igual a la usada por `build-supplier-catalog.mjs` al construir el índice —
 * mantenerlas en sync es crítico para que los lookups exactos funcionen.
 */
export function normalizeKey(s: string | null | undefined): string {
  if (!s) return "";
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export interface SupplierMatch {
  /** El registro completo del proveedor en el catálogo. */
  supplier: CatalogSupplier;
  /**
   * Cómo se hizo el match — útil para diagnóstico/UI:
   *   - "exact" / "prefix" / "includes" → matchers locales (gratis, instantáneos)
   *   - "ai" → fallback Claude vía POST /match-supplier (cuesta tokens)
   */
  matchedBy: "exact" | "prefix" | "includes" | "ai";
  /** El query original que se buscó (post-trim, sin normalizar). */
  query: string;
  /**
   * Confianza reportada por el backend cuando `matchedBy === "ai"`. Null para
   * los matchers locales (siempre son alta).
   */
  aiConfidence?: MatchSupplierConfidence;
  /** Razonamiento del modelo cuando `matchedBy === "ai"`. */
  aiReasoning?: string;
}

/**
 * Busca un proveedor por nombre. Devuelve `null` si no hay match razonable o
 * si el query está vacío.
 */
export async function findSupplierByName(
  rawName: string | null | undefined,
): Promise<SupplierMatch | null> {
  const query = (rawName ?? "").trim();
  if (!query) return null;

  // Dynamic import — el catálogo (~1.6 MB) se code-splittea en su propio chunk.
  const { SUPPLIERS, SUPPLIER_INDEX_BY_NAME } = await import("./supplierCatalog");

  const key = normalizeKey(query);
  if (!key) return null;

  // 1) match exacto vía índice precomputado
  const exactCode = SUPPLIER_INDEX_BY_NAME[key];
  if (exactCode) {
    const supplier = SUPPLIERS.find((s) => s.codigo === exactCode);
    if (supplier) {
      return { supplier, matchedBy: "exact", query };
    }
  }

  // 2) prefix — el nombre comercial del catálogo empieza con el query
  for (const s of SUPPLIERS) {
    const nk = s.nombre ? normalizeKey(s.nombre) : "";
    if (nk && nk.startsWith(key)) {
      return { supplier: s, matchedBy: "prefix", query };
    }
  }

  // 3) includes con tokens significativos (≥ 4 chars). Evita match basura por
  //    palabras cortas como "de", "la", "y", "sa".
  const tokens = key.split(" ").filter((t) => t.length >= 4);
  if (tokens.length > 0) {
    for (const s of SUPPLIERS) {
      const nk = s.nombre ? normalizeKey(s.nombre) : "";
      if (nk && tokens.every((t) => nk.includes(t))) {
        return { supplier: s, matchedBy: "includes", query };
      }
    }
  }

  return null;
}

/**
 * Variante que cae a IA cuando los matchers locales fallan.
 *
 * Orden de intentos:
 *   1. `findSupplierByName` (exact → prefix → includes). Gratis, instantáneo.
 *   2. Si nada matcheó y `enableAIFallback` es true: llama al backend
 *      (`POST /match-supplier`) con la lista completa de candidatos del
 *      catálogo y deja que Claude elija. Si Claude devuelve null o un código
 *      desconocido, devolvemos null (no inventamos).
 *
 * Errores de red o del backend en el fallback se loggean y devuelven null —
 * el lookup no debe romper el flujo de extracción.
 */
export async function findSupplierByNameWithAI(
  rawName: string | null | undefined,
  options: { enableAIFallback?: boolean } = { enableAIFallback: true },
): Promise<SupplierMatch | null> {
  const local = await findSupplierByName(rawName);
  if (local) return local;

  if (!options.enableAIFallback) return null;

  const query = (rawName ?? "").trim();
  if (!query) return null;

  // Reusamos el módulo ya cargado para `findSupplierByName` (mismo dynamic
  // import) — el catálogo está en cache después del primer intento local.
  const { SUPPLIERS } = await import("./supplierCatalog");

  const candidates = SUPPLIERS
    .filter((s): s is CatalogSupplier & { nombre: string } => !!s.nombre)
    .map((s) => ({ codigo: s.codigo, nombre: s.nombre as string }));

  if (candidates.length === 0) return null;

  let response;
  try {
    response = await api.supplierIntelligence.matchSupplier({
      query,
      candidates,
    });
  } catch (err) {
    // Si es 502/429/etc. caemos a "no match" en lugar de propagar — el banner
    // del step 2 le dirá al usuario que llene manual.
    if (err instanceof ApiError) {
      console.warn(
        `[supplierLookup] AI match falló (${err.status}): ${err.message}`,
      );
    } else {
      console.warn("[supplierLookup] AI match error inesperado", err);
    }
    return null;
  }

  const { codigo, confidence, reasoning } = response.data;
  if (!codigo) return null;

  const supplier = SUPPLIERS.find((s) => s.codigo === codigo);
  if (!supplier) {
    // Defensa: el backend ya valida que el código pertenezca a candidates,
    // pero si por algún motivo no lo encontramos en el catálogo local, no
    // confiamos.
    console.warn(
      `[supplierLookup] AI devolvió código desconocido: ${codigo}`,
    );
    return null;
  }

  return {
    supplier,
    matchedBy: "ai",
    query,
    aiConfidence: confidence,
    aiReasoning: reasoning,
  };
}

/**
 * Para un proveedor matcheado, intenta resolver un único `Código Servicio` a
 * partir de un texto del contrato (típicamente la descripción del servicio
 * comercializado, extraída por la IA o aportada en `comments`).
 *
 * Reglas:
 *   - Si el proveedor tiene exactamente 1 servicio → ese.
 *   - Si el `hint` matchea exactamente un código → ese.
 *   - Si el `hint` matchea exactamente una descripción (case/accent
 *     insensitive) → ese.
 *   - Si el `hint` está contenido en exactamente una descripción → ese.
 *   - En cualquier otro caso → `null` (que el usuario lo elija manualmente
 *     en step 2).
 */
export function findServiceForSupplier(
  supplier: CatalogSupplier,
  hint: string | null | undefined,
): CatalogService | null {
  if (supplier.servicios.length === 0) return null;
  if (supplier.servicios.length === 1) return supplier.servicios[0];

  const trimmed = (hint ?? "").trim();
  if (!trimmed) return null;
  const k = normalizeKey(trimmed);
  if (!k) return null;

  // Match por código exacto
  const codeHits = supplier.servicios.filter((s) => normalizeKey(s.codigo) === k);
  if (codeHits.length === 1) return codeHits[0];

  // Match exacto de descripción
  const descExact = supplier.servicios.filter(
    (s) => s.descripcion && normalizeKey(s.descripcion) === k,
  );
  if (descExact.length === 1) return descExact[0];

  // Match parcial de descripción
  const descPartial = supplier.servicios.filter(
    (s) => s.descripcion && normalizeKey(s.descripcion).includes(k),
  );
  if (descPartial.length === 1) return descPartial[0];

  return null;
}
