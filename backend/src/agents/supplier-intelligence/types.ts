/**
 * Types shared across the Supplier Intelligence agent.
 *
 * Kept isolated from the rest of the codebase so this agent can be lifted out
 * (or cloned for another agent) without dragging in auth/user domain types.
 */

export type Confianza = "alta" | "media" | "baja";

/** The 9 target fields + metadata Claude is forced to return via tool_use. */
export interface ExtractedContract {
  fecha: string | null;
  proveedor: string | null;
  nombre_comercial: string | null;
  cedula: string | null;
  direccion: string | null;
  telefono: string | null;
  tipo_moneda: string | null;
  numero_cuenta: string | null;
  banco: string | null;
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
