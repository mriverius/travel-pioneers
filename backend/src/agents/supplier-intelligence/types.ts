/**
 * Types shared across the Supplier Intelligence agent.
 *
 * Kept isolated from the rest of the codebase so this agent can be lifted out
 * (or cloned for another agent) without dragging in auth/user domain types.
 */

export type Confianza = "alta" | "media" | "baja";

/**
 * Campos que Claude devuelve vía tool_use. Calibrado contra contrato real
 * (Travel Pioneers / Parador 2026) y fila ground-truth del xlsx maestro
 * (Monteverde Lodge & Gardens). Cubre los ~30 campos que aparecen en
 * contratos típicos costarricenses; los demás campos del UI (tipos de tarifa,
 * cuentas 2/3, condiciones de crédito) se llenan manualmente porque
 * raramente aparecen en contratos.
 *
 * Sección 1 (identidad/contacto/legal):  fecha → reservations_email
 * Sección 2 (servicio):                  product_name, ocupacion
 * Sección 3 (clasificación catálogo):    tipo_unidad, tipo_servicio, categoria
 * Sección 4 (temporada):                 season_*, meals_included
 * Sección 5 (tarifas estándar):          precios_neto_iva, precio_rack_iva, porcentaje_comision
 * Sección 6 (tarifas FdS):               *_fds
 * Sección 7 (políticas):                 cancellation_policy, range_payment_policy, kids_policy, other_included, feeds_adicionales
 * Sección 8 (cuenta bancaria 1):         numero_cuenta, banco
 * Sección 9 (metadatos):                 confianza, campos_faltantes, paginas_origen
 */
export interface ExtractedContract {
  // --- Identidad / contacto / legal ---
  fecha: string | null;
  proveedor: string | null;
  nombre_comercial: string | null;
  cedula: string | null;
  direccion: string | null;
  telefono: string | null;
  /** País del proveedor. Inferible desde dirección/teléfono. */
  pais: string | null;
  /** Provincia/estado. Inferible desde la geografía costarricense. */
  state_province: string | null;
  /**
   * Type of Business — clasificación del rubro principal (Hotel, Tour
   * Operator, Transfer Service, Restaurant, etc.). Inferible del título o
   * propósito del contrato.
   */
  type_of_business: string | null;
  /** Vigencia del contrato — fecha de inicio (YYYY-MM-DD). */
  contract_starts: string | null;
  /** Vigencia del contrato — fecha de fin (YYYY-MM-DD). */
  contract_ends: string | null;
  /**
   * Email de reservaciones del proveedor. Distinguir del email genérico de
   * contacto: priorizar el dirigido a reservas si hay varios.
   */
  reservations_email: string | null;

  // --- Servicio (1 representativo si el contrato cubre múltiples) ---
  /**
   * Nombre del producto/servicio principal (ej: "COTINGA", "Garden",
   * "Vista Suites", "Canopy Tour").
   */
  product_name: string | null;
  /**
   * Ocupación típica (ej: "DBL" para doble, "SGL" para single, "TPL"). En
   * códigos cortos de hospedería.
   */
  ocupacion: string | null;

  // --- Clasificación catálogo Utopía ---
  tipo_unidad: "N" | "S" | null;
  tipo_servicio: string | null;
  categoria: string | null;

  // --- Temporada (1 representativa si el contrato cubre múltiples) ---
  /** Nombre de la temporada (ej: "GREEN SEASON", "ALTA", "PEAK"). */
  season_name: string | null;
  season_starts: string | null;
  season_ends: string | null;
  /**
   * Comidas incluidas (ej: "BREAKFAST", "MAP", "ALL INCLUSIVE", "NONE"). En
   * códigos cortos / mayúsculas como aparece en el maestro Utopía.
   */
  meals_included: string | null;

  // --- Tarifas estándar (entre semana o tarifa base) ---
  /** Precio neto con IVA — número (string para preservar formato). */
  precios_neto_iva: string | null;
  /** Precio rack/público con IVA. */
  precio_rack_iva: string | null;
  /**
   * Porcentaje de comisión. Si el contrato dice "NETAS, NO COMISIONABLES",
   * devolver "0". Mantener formato del documento (puede venir como "25",
   * "0.25", "25%", etc.).
   */
  porcentaje_comision: string | null;

  // --- Tarifas fin de semana (si el contrato distingue) ---
  precios_neto_iva_fds: string | null;
  precio_rack_iva_fds: string | null;
  porcentaje_comision_fds: string | null;

  // --- Políticas (texto libre) ---
  cancellation_policy: string | null;
  range_payment_policy: string | null;
  kids_policy: string | null;
  other_included: string | null;
  feeds_adicionales: string | null;

  // --- Datos bancarios (cuenta 1 — la mayoría de contratos solo tienen una) ---
  tipo_moneda: string | null;
  numero_cuenta: string | null;
  banco: string | null;

  // --- Metadatos ---
  confianza: Confianza;
  campos_faltantes: string[];
  /** Map of field name -> page number OR "inferido" / "multiple". */
  paginas_origen: Record<string, string | number>;
}

export interface ValidationResult {
  valid: boolean;
  warnings: string[];
}

/** The kinds of documents the agent accepts. */
export type SupportedDocKind = "pdf" | "docx" | "xlsx";

/**
 * Output of the extractors — either a PDF that Claude reads natively (as a
 * base64 document block) or a pre-converted plain-text representation for
 * Word / Excel.
 */
export type PreparedDocument =
  | { kind: "pdf"; base64: string; mediaType: "application/pdf" }
  | { kind: "text"; text: string; sourceFormat: "docx" | "xlsx" };
