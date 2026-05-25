/**
 * Types shared across the Supplier Intelligence agent.
 *
 * Kept isolated from the rest of the codebase so this agent can be lifted out
 * (or cloned for another agent) without dragging in auth/user domain types.
 *
 * Modelo de datos: { shared_fields, rows, metadata }. Un contrato típico tiene
 * N categorías × M temporadas combinaciones (ej. Parador: 7 × 3 = 21). En el
 * xlsx maestro esas combinaciones son N filas separadas que comparten los
 * datos del proveedor / contrato / bancos. El AI agent extrae los campos
 * compartidos una sola vez y emite N filas con los datos variables.
 */

export type Confianza = "alta" | "media" | "baja";

export type TipoUnidad = "N" | "S";

/** Source page metadata. Either page number, "inferido", or "multiple". */
export type SourcePage = string | number;

/**
 * Campos que aparecen UNA sola vez en el contrato y se replican en cada fila
 * del xlsx. Cubren identidad del proveedor, contrato, clasificación de
 * catálogo (tipo_unidad/tipo_servicio normalmente no cambian dentro de UN
 * contrato), crédito y datos bancarios.
 *
 * Nota: telefono se extrae para validación E.164 pero NO tiene columna en la
 * plantilla xlsx — solo se muestra en la UI para revisión humana.
 */
export interface SharedFields {
  // Identidad / contacto / legal
  fecha: string | null;
  proveedor: string | null;
  nombre_comercial: string | null;
  cedula: string | null;
  direccion: string | null;
  telefono: string | null;
  pais: string | null;
  state_province: string | null;
  type_of_business: string | null;
  contract_starts: string | null;
  contract_ends: string | null;
  reservations_email: string | null;
  // Clasificación catálogo Utopía (típicamente shared dentro de un contrato)
  tipo_unidad: TipoUnidad | null;
  tipo_servicio: string | null;
  // Datos bancarios (cuenta 1 — la mayoría de contratos solo tiene una)
  tipo_moneda: string | null;
  numero_cuenta: string | null;
  banco: string | null;
  /**
   * Columna BA — "NOTAS". Cláusulas significativas del contrato que no
   * encajan en ninguna otra columna (restricciones de edad mínima,
   * requisitos de booking, condiciones especiales, alérgenos, etc.).
   *
   * Antes (Bug #6 legacy) se shoehorneaba en la columna AK
   * (others_payment_cancel) cuando esa celda estaba vacía; ahora vive
   * en su propia columna dedicada BA y es contract-wide (se replica en
   * cada fila del xlsx igual que `proveedor` o `nombre_comercial`).
   */
  notes: string | null;
}

/**
 * Una fila del xlsx — una combinación product × season del contrato.
 *
 * Las políticas viven aquí (no en shared) porque pueden variar por temporada
 * — ej. en Parador el plazo de pago es 60d en Peak, 30d en Alta, 15d en Baja.
 * Si el contrato NO distingue políticas por fila, la IA copia el mismo valor
 * en todas las filas y la UI las colapsa visualmente en "Igual en todas las
 * filas".
 */
export interface ContractRow {
  product_name: string | null;
  categoria: string | null;
  /**
   * Override por fila de `tipo_servicio` (Bug #1 / #5). Cuando el contrato
   * mezcla servicios (ej: hotel + tours en un Experiences Book), cada fila
   * puede declarar su propio código (HO, TO, TR, AL...). Si null, el writer
   * cae en `shared_fields.tipo_servicio` y luego en una heurística por
   * tipo de producto.
   */
  tipo_servicio: string | null;
  /**
   * Override por fila de `tipo_unidad`. Hoteles → "N" (por noche); tours,
   * transfers y comidas → "S" (por servicio). Mismo fallback que
   * `tipo_servicio`.
   */
  tipo_unidad: TipoUnidad | null;
  /**
   * Código corto por fila ("Cod.Servicio", columna N). Bug #2: antes se
   * tomaba un único código del catálogo (típicamente "MASTER") y se
   * replicaba a todas las filas; ahora cada fila lleva su propio código
   * derivado del nombre del producto.
   */
  codigo_servicio: string | null;
  ocupacion: string | null;
  // Temporada
  season_name: string | null;
  season_starts: string | null;
  season_ends: string | null;
  meals_included: string | null;
  // Tarifas estándar (lunes-jueves o tarifa base)
  precios_neto_iva: string | null;
  precio_rack_iva: string | null;
  porcentaje_comision: string | null;
  // Tarifas fin de semana (si el contrato distingue; si no, copia de la estándar)
  precios_neto_iva_fds: string | null;
  precio_rack_iva_fds: string | null;
  porcentaje_comision_fds: string | null;
  // Políticas (pueden variar por temporada)
  cancellation_policy: string | null;
  range_payment_policy: string | null;
  kids_policy: string | null;
  other_included: string | null;
  feeds_adicionales: string | null;
}

/**
 * Campos que NO extrae la IA (no salen del contrato) y NO vienen del catálogo
 * lista-proveedores, pero existen como columnas en la plantilla xlsx y el
 * usuario puede llenarlos en step 2. Se replican en cada fila del xlsx igual
 * que los shared_fields.
 *
 * Columnas correspondientes: X, AA, AC, AD, AG, AK, AP, AQ, AU, AV, AW, AX,
 * AY, AZ (14 columnas).
 */
export interface ManualFields {
  tipo_tarifa_neta: string | null;
  tipo_tarifa_mayorista: string | null;
  tipo_tarifa_fds: string | null;
  t_tar_neta_fds: string | null;
  tipo_tarifa_mayorista_fds: string | null;
  others_payment_cancel: string | null;
  cond_credito: string | null;
  plazo: string | null;
  cuenta_bancaria_2: string | null;
  banco_2: string | null;
  moneda_2: string | null;
  cuenta_bancaria_3: string | null;
  banco_3: string | null;
  moneda_3: string | null;
}

export type SharedFieldKey = keyof SharedFields;
export type RowFieldKey = keyof ContractRow;
export type ManualFieldKey = keyof ManualFields;

/**
 * Resultado final de la extracción — lo que devuelve la API.
 *
 * `paginas_origen_shared`: map de SharedFieldKey -> página de origen.
 * `paginas_origen_rows[i]`: map de RowFieldKey -> página, paralelo a rows[i].
 */
export interface ExtractedContract {
  shared_fields: SharedFields;
  rows: ContractRow[];
  confianza: Confianza;
  campos_faltantes: string[];
  paginas_origen_shared: Record<string, SourcePage>;
  paginas_origen_rows: Record<string, SourcePage>[];
}

export interface ValidationResult {
  valid: boolean;
  warnings: string[];
}

/** The kinds of documents the agent accepts. */
export type SupportedDocKind = "pdf" | "docx" | "xlsx" | "image";

/**
 * Subset of `image/*` MIME types soportados por la Messages API de
 * Anthropic. Cualquier otra extensión / MIME (heic, tiff, svg, etc.) se
 * rechaza en el extractor de imágenes con 415.
 */
export type ImageMediaType =
  | "image/jpeg"
  | "image/png"
  | "image/gif"
  | "image/webp";

/**
 * Output of the extractors — three branches:
 *   - PDF: leído nativamente por Claude (`document` block, base64).
 *   - Image: leída nativamente por Claude (`image` block, base64).
 *   - Text: pre-convertido a UTF-8 para Word / Excel.
 */
export type PreparedDocument =
  | { kind: "pdf"; base64: string; mediaType: "application/pdf" }
  | { kind: "image"; base64: string; mediaType: ImageMediaType }
  | { kind: "text"; text: string; sourceFormat: "docx" | "xlsx" };
