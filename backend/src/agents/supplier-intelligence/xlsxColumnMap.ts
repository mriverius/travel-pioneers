/**
 * Mapeo de cada campo (compartido / por fila) a su letra de columna en la
 * plantilla xlsx. Fuente: encabezado en la fila 6 de
 * `frontend/data/plantilla-agente-utopia.xlsx` (52 columnas, A..AZ).
 *
 * Este archivo es la **fuente de verdad** que el writer del backend usa para
 * saber dónde escribir cada valor. El frontend tiene un mapa equivalente para
 * mostrar la letra de columna junto a cada campo en la UI — si en el futuro
 * la plantilla cambia, actualizar AMBOS lados.
 *
 * Campos sin entry aquí (telefono, tipo_actividad, zona_turismo, codigo_servicio,
 * cond_credito, plazo, cuentas/bancos 2-3, tipos_tarifa_*) NO se escriben desde
 * la extracción IA: o son campos de catálogo (vienen del prefill de
 * lista-proveedores), o son manuales/template y se dejan en blanco.
 */
import type { ManualFieldKey, RowFieldKey, SharedFieldKey } from "./types.js";

/** Fila 1-indexed donde empiezan los datos en la plantilla. */
export const TEMPLATE_DATA_START_ROW = 7;

/** Nombre original de la hoja de datos en la plantilla. */
export const TEMPLATE_DATA_SHEET_NAME = "MONTEVERDE_LODGE_CONTRACT_2026_";

/** Columnas para campos que provienen del catálogo lista-proveedores (no AI). */
export const CATALOG_PREFILL_COL = {
  tipo_actividad: "A",
  zona_turismo: "B",
  proveedor_codigo: "C", // código corto del proveedor en el maestro
  codigo_servicio: "N",
} as const;

/** Columnas para los campos compartidos extraídos por IA. */
export const SHARED_COL: Partial<Record<SharedFieldKey, string>> = {
  // D=Razon social (legal name) ← extracted "proveedor"
  proveedor: "D",
  cedula: "E",
  fecha: "F",
  nombre_comercial: "G",
  pais: "H",
  state_province: "I",
  // J=Location ← extracted "direccion"
  direccion: "J",
  type_of_business: "K",
  contract_starts: "L",
  contract_ends: "M",
  // tipo_unidad (P) y tipo_servicio (Q) ya NO viven aquí — son per-row
  // (Bug #1, #5). El writer los resuelve combinando shared + override de
  // la fila + fallback heurístico, y los escribe directamente.
  reservations_email: "AO",
  // Cuenta bancaria 1
  numero_cuenta: "AR",
  banco: "AS",
  tipo_moneda: "AT",
  // telefono: sin columna — se extrae para validación pero no se escribe.
  // Columna 53 — NOTAS (Bug #6 → BA). Cláusulas globales del contrato
  // que no encajan en ninguna otra columna del schema. Antes se
  // shoehorneaba en AK (others_payment_cancel) como fallback; ahora
  // vive en su propia columna dedicada y se replica en cada fila igual
  // que el resto de los shared.
  notes: "BA",
};

/**
 * Columnas escritas por fila pero RESUELTAS combinando shared + override
 * por fila + fallback heurístico (Bug #1, #5). El writer las maneja a
 * mano, no por iteración sobre ROW_COL.
 */
export const ROW_CLASSIFICATION_COL = {
  tipo_unidad: "P",
  tipo_servicio: "Q",
  /** Cod.Servicio — Bug #2: per-row code derivado del product_name. */
  codigo_servicio: "N",
} as const;

/** Fechas que requieren normalización a YYYY-MM-DD (Bug #3). */
export const DATE_SHARED_FIELDS = ["fecha", "contract_starts", "contract_ends"] as const;
export const DATE_ROW_FIELDS = ["season_starts", "season_ends"] as const;

/** Columnas auto-llenadas por el writer en función de porcentaje_comision (Bug #4). */
export const TIPO_TARIFA_REGULAR_COLS = ["X", "AA"] as const; // tipo_tarifa_neta, tipo_tarifa_mayorista
export const TIPO_TARIFA_FDS_COLS = ["AC", "AD", "AG"] as const; // tipo_tarifa_fds, t_tar_neta_fds, tipo_tarifa_mayorista_fds

/**
 * Columnas para los campos "manual" que no extrae la IA pero existen en la
 * plantilla. Se replican en cada fila del xlsx — el usuario los llena en
 * step 2 una sola vez.
 */
export const MANUAL_COL: Record<ManualFieldKey, string> = {
  tipo_tarifa_neta: "X",
  tipo_tarifa_mayorista: "AA",
  tipo_tarifa_fds: "AC",
  t_tar_neta_fds: "AD",
  tipo_tarifa_mayorista_fds: "AG",
  others_payment_cancel: "AK",
  cond_credito: "AP",
  plazo: "AQ",
  cuenta_bancaria_2: "AU",
  banco_2: "AV",
  moneda_2: "AW",
  cuenta_bancaria_3: "AX",
  banco_3: "AY",
  moneda_3: "AZ",
};

/**
 * Columnas para los campos por fila. NOTA: tipo_unidad (P), tipo_servicio
 * (Q) y codigo_servicio (N) tienen entradas en `ContractRow` pero el
 * writer los maneja con resolución especial (override por fila + fallback
 * a shared / heurística) — ver `ROW_CLASSIFICATION_COL` arriba. Por eso
 * NO viven en este map: la iteración genérica los saltearía sin aplicar
 * los fallbacks.
 */
export const ROW_COL: Partial<Record<RowFieldKey, string>> = {
  product_name: "O",
  // P (tipo_unidad), Q (tipo_servicio) y N (codigo_servicio) → ROW_CLASSIFICATION_COL
  categoria: "R",
  ocupacion: "S",
  season_name: "T",
  season_starts: "U",
  season_ends: "V",
  meals_included: "W",
  // X (tipo_tarifa_neta) es manual/template
  precios_neto_iva: "Y",
  precio_rack_iva: "Z",
  // AA (tipo_tarifa_mayorista) es manual/template
  porcentaje_comision: "AB",
  // AC (tipo_tarifa_fds) y AD (t_tar_neta_fds) son manuales/template
  precios_neto_iva_fds: "AE",
  precio_rack_iva_fds: "AF",
  // AG (tipo_tarifa_mayorista_fds) es manual/template
  porcentaje_comision_fds: "AH",
  cancellation_policy: "AI",
  range_payment_policy: "AJ",
  // AK (others_payment_cancel) es manual
  kids_policy: "AL",
  other_included: "AM",
  feeds_adicionales: "AN",
};
