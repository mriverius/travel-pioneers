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
import type { SharedFieldKey, RowFieldKey } from "./types.js";

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
  // tipo_unidad y tipo_servicio son shared en el modelo, también son shared
  // en el xlsx (cada fila tiene el mismo valor)
  tipo_unidad: "P",
  tipo_servicio: "Q",
  reservations_email: "AO",
  // Cuenta bancaria 1
  numero_cuenta: "AR",
  banco: "AS",
  tipo_moneda: "AT",
  // telefono: sin columna — se extrae para validación pero no se escribe.
};

/** Columnas para los campos por fila. */
export const ROW_COL: Record<RowFieldKey, string> = {
  product_name: "O",
  // P (tipo_unidad) y Q (tipo_servicio) son shared
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
