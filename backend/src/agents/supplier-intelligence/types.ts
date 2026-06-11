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
   * Columna AK — "OTHERS IN PAYMENT OR CANCELLATION". Políticas de PERIODOS
   * ESPECIALES (Navidad / Semana Santa / fin de año / high season) que
   * cambian las reglas de prepago o cancelación para fechas puntuales —
   * ej. "Reservas que incluyan 15-dic al 15-ene deben prepagarse el 14-oct;
   * cancelación 30 días antes". Es contract-wide: la IA la extrae una vez y
   * el writer la replica en cada fila (columna AK). Antes era un campo
   * manual (lo llenaba el usuario en step 2); ahora la IA lo pre-llena y el
   * usuario puede ajustarlo.
   */
  others_payment_cancel: string | null;
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
   * Override por fila de `tipo_unidad`. Hospedaje por noche → "N"; tours,
   * transfers, comidas → "S". CASO ESPECIAL: una tarifa de hospedaje que es
   * un PAQUETE de varias noches a precio fijo por habitación (ej. "2N/3D" con
   * el neto total por las 2 noches) → "S", no "N". Mismo fallback que
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
  /**
   * Campo AUXILIAR (no tiene columna en el xlsx). Cuando el contrato define
   * una "tarifa por persona adicional" (ej. "Tarifa persona adicional $46 +
   * imp"), la IA pone aquí ese monto YA expresado como precio RACK con IVA
   * incluido (misma convención que `precio_rack_iva`). El servidor lo usa
   * para materializar deterministicamente filas de ocupación TPL (triple) y
   * QDP (cuádruple) a partir de la fila base — ver `expandOccupancy` en
   * validators.ts. Una vez expandida, el campo queda en null en todas las
   * filas resultantes. Si el contrato no menciona persona adicional → null.
   */
  tarifa_persona_adicional: string | null;
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
 * Columnas correspondientes: X, AA, AC, AD, AG, AP, AQ, AU, AV, AW, AX,
 * AY, AZ (13 columnas). NOTA: AK (others_payment_cancel) dejó de ser manual
 * — ahora la IA lo extrae como shared field (periodos especiales).
 */
export interface ManualFields {
  tipo_tarifa_neta: string | null;
  tipo_tarifa_mayorista: string | null;
  tipo_tarifa_fds: string | null;
  t_tar_neta_fds: string | null;
  tipo_tarifa_mayorista_fds: string | null;
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
  /**
   * TODAS las cuentas bancarias listadas en el contrato (campo AUXILIAR — no
   * tiene columna propia). La extracción principal (Opus) la llena leyendo
   * todo el documento, así que es la fuente confiable de cuentas aunque el
   * brief (Fase 1) falle. El servidor la reconcilia con la cuenta primaria de
   * `shared_fields` y materializa las cuentas 2 y 3 como prefill de los campos
   * manuales (ver `reconcileBankAccounts`). La plantilla soporta máximo 3.
   */
  bank_accounts?: ContractBriefBankAccount[];
  /**
   * Condición de crédito + plazo del contrato (campo AUXILIAR — alimenta los
   * campos manuales cond_credito (col AP) y plazo (col AQ)). La IA lo extrae de
   * la sección de forma de pago / términos comerciales.
   */
  payment_terms?: PaymentTerms | null;
}

/**
 * Términos de pago globales del contrato. Alimentan dos columnas manuales:
 *   - cond_credito (AP): "1"=CONTADO, "2"=CRÉDITO, "3"=PREPAGO.
 *   - plazo (AQ): días de crédito o descripción del prepago requerido.
 */
export interface PaymentTerms {
  /** "CONTADO" | "CREDITO" | "PREPAGO" — texto crudo, el server lo mapea a 1/2/3. */
  condition: string | null;
  /** Días de crédito si aplica (ej. 30). null si no es a crédito. */
  term_days: number | null;
  /** Detalle del plazo/prepago en texto (ej. "prepago 14-oct para Navidad"). */
  term_note: string | null;
}

export interface ValidationResult {
  valid: boolean;
  warnings: string[];
}

/* -------------------------------------------------------------------------- */
/*                        Contract Brief (Fase 1)                             */
/* -------------------------------------------------------------------------- */

/** Una cuenta bancaria capturada por el brief. */
export interface ContractBriefBankAccount {
  bank: string | null;
  account_number: string | null;
  currency: string | null;
  swift: string | null;
  note: string | null;
}

/** Una tarifa por persona adicional capturada por el brief. */
export interface ContractBriefAdditionalPerson {
  scope: string | null;
  applies_to: string | null;
  rack: string | null;
  net: string | null;
}

/**
 * Una temporada con sus fechas, capturada por el brief. Es la versión
 * estructurada de `ContractBrief.seasons` (que es solo string[] de nombres).
 * El usuario la confirma/edita en el step de Variables de Configuración y las
 * fechas confirmadas se inyectan en la pasada principal para que CADA fila
 * salga con `season_starts`/`season_ends` correctos — uno de los datos que más
 * se equivoca el modelo cuando un contrato lista temporadas con rangos
 * partidos (ej. "May 1 - Jun 19 · Aug 21 - Oct 31").
 */
export interface ContractBriefSeason {
  name: string | null;
  /** Fecha de inicio en YYYY-MM-DD (o texto crudo si no se pudo normalizar). */
  starts: string | null;
  /** Fecha de fin en YYYY-MM-DD. */
  ends: string | null;
  /**
   * Rango(s) crudos tal cual aparecen, para temporadas con tramos partidos
   * que no caben en un solo start/end (ej. "21 abr-30 jun y 16 ago-19 dic").
   */
  raw_range: string | null;
}

/**
 * Identidad / vigencia del proveedor capturada en la Fase 1 — los datos que
 * son IGUALES en todas las filas (no varían por habitación/temporada). El
 * usuario los confirma en el step de Variables de Configuración y, al
 * confirmar, sobreescriben lo que la extracción principal infiera. Es el
 * subconjunto "humano" de SharedFields (sin códigos de catálogo ni bancos,
 * que se manejan aparte).
 */
export interface ContractBriefSharedFields {
  proveedor: string | null;
  nombre_comercial: string | null;
  cedula: string | null;
  type_of_business: string | null;
  direccion: string | null;
  telefono: string | null;
  pais: string | null;
  state_province: string | null;
  reservations_email: string | null;
  fecha: string | null;
  contract_starts: string | null;
  contract_ends: string | null;
}

/**
 * Resultado de la pasada de BRIEF (Fase 1). Captura las reglas GLOBALES del
 * contrato + un inventario, en una llamada chica y focalizada — sin filas de
 * tarifas. Se inyecta como contexto de prioridad alta en la pasada principal
 * (ver `renderContractBriefBlock`) para que el modelo no pierda estas reglas
 * al generar las decenas de filas.
 */
export interface ContractBrief {
  /** Identidad / vigencia del proveedor (datos compartidos por todas las filas). */
  shared_fields: ContractBriefSharedFields;
  prices_include_tax: boolean | null;
  tax_rate_pct: number | null;
  tax_note: string | null;
  /**
   * Comisión por defecto del contrato en porcentaje (ej. 20, 25, 30). Es la
   * comisión que aplica a la mayoría de las filas; los desvíos por sección se
   * describen en `commission_summary`. Capturarla como número (no solo texto)
   * permite validar fila-por-fila que el modelo no se haya equivocado, y
   * pre-llenar la columna de comisión cuando una fila viene vacía.
   */
  commission_default_pct: number | null;
  commission_summary: string | null;
  meal_plan_note: string | null;
  /** Moneda principal del contrato (USD, CRC/LOC, EUR…), normalizada aparte. */
  currency: string | null;
  bank_accounts: ContractBriefBankAccount[];
  additional_person: ContractBriefAdditionalPerson[];
  special_periods_note: string | null;
  product_categories: string[];
  /** Nombres de temporada (compat). Ver `seasons_detail` para fechas. */
  seasons: string[];
  /** Temporadas con sus fechas — la fuente que el usuario confirma/edita. */
  seasons_detail: ContractBriefSeason[];
  sections: string[];
  expected_row_estimate: number | null;
  notes: string | null;
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
