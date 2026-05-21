import { APIError } from "@anthropic-ai/sdk";
import type {
  ContentBlockParam,
  MessageParam,
  ToolUseBlock,
} from "@anthropic-ai/sdk/resources/messages.js";
import ApiError from "../../utils/ApiError.js";
import logger from "../../config/logger.js";
import { getAnthropicClient } from "./anthropicClient.js";
import {
  EXTRAER_DATOS_CONTRATO_TOOL,
  EXTRAER_DATOS_CONTRATO_TOOL_NAME,
  SUPPLIER_INTELLIGENCE_SYSTEM_PROMPT,
} from "./prompts/index.js";
import { validateExtraction } from "./validators.js";
import type {
  Confianza,
  ContractRow,
  ExtractedContract,
  PreparedDocument,
  SharedFields,
  SourcePage,
  TipoUnidad,
  ValidationResult,
} from "./types.js";

/**
 * Opus 4.6 es el modelo de extracción. Es más caro y más lento que Sonnet,
 * pero la tarea ahora requiere generar potencialmente decenas de filas con
 * razonamiento sobre múltiples temporadas/categorías — Opus paga el precio
 * en calidad de extracción.
 */
export const SUPPLIER_INTELLIGENCE_MODEL = "claude-opus-4-6";

/**
 * Pricing oficial de Claude Opus 4.6 (USD por millón de tokens).
 *
 * Fuente: https://platform.claude.com/docs/en/about-claude/pricing (feb 2026).
 * Si Anthropic cambia precios, este es el único lugar donde editar — el
 * cómputo de `cost_usd` por extracción se hace abajo en `extractContract`.
 *
 * Nota: NO contemplamos prompt caching todavía. Cuando lo activemos, habrá
 * que distinguir entre cache_write / cache_hit (tarifas distintas) — por
 * ahora todo el input cuenta a precio plano.
 */
const PRICE_INPUT_PER_MTOK_USD = 5;
const PRICE_OUTPUT_PER_MTOK_USD = 25;

function computeCostUsd(inputTokens: number, outputTokens: number): number {
  const inputCost = (inputTokens / 1_000_000) * PRICE_INPUT_PER_MTOK_USD;
  const outputCost = (outputTokens / 1_000_000) * PRICE_OUTPUT_PER_MTOK_USD;
  // 6 decimales de precisión es overkill para mostrar pero útil para
  // reportes agregados (sumar muchas extracciones baratas sin redondeo).
  return Number((inputCost + outputCost).toFixed(6));
}

/**
 * Cap de output tokens. Historia:
 *   - 1500: una fila plana (~150 tokens). Histórico.
 *   - 16k:  Parador (~21 filas ≈ 5-8k tokens). OK pero ajustado.
 *   - 32k:  intento de cubrir BTPV (~130 filas), insuficiente.
 *   - 64k:  límite actual. Cubre BTPV (~40k output) con margen cómodo y
 *           aguanta hasta ~200 filas si aparecieran.
 *
 * Opus 4.6 admite hasta 128k. NO cobramos por el cap — solo por los tokens
 * que efectivamente se emiten — así que un cap alto solo cuesta latencia.
 * Subir a 96k/128k es viable si en el futuro vemos contratos más grandes.
 *
 * NOTA: a partir de ~16k Anthropic recomienda streaming para evitar HTTP
 * timeouts upstream — ver `extractContract`.
 *
 * NOTA sobre extended thinking: NO podemos enviar `thinking` config en
 * esta llamada — la API responde 400 con
 *   "Thinking may not be enabled when tool_choice forces tool use."
 * y como nosotros forzamos tool_choice (es la base del schema-driven
 * extract), thinking queda automáticamente deshabilitado del lado del
 * servidor. Eso significa que los 64k completos van a la salida, no se
 * comparten con un budget de thinking — mejor para nosotros.
 */
const MAX_TOKENS = 64_000;

/**
 * Optional context the caller can attach to an extraction. The `comments`
 * field is the user-typed email-body excerpt from the UI — it gets injected
 * into the user message as supplementary context Claude can lean on when the
 * document itself is missing details.
 */
export interface ExtractionContext {
  comments?: string;
  isExistingSupplier?: boolean;
}

/**
 * Render the optional user-provided context as a text block that gets
 * prepended to the document content.
 *
 * Las INSTRUCCIONES DEL USUARIO van en lo más alto de la pila de contexto
 * con prioridad ALTA — son indicaciones operacionales (no datos), y le
 * dicen a Claude CÓMO interpretar el documento, no qué extraer. Casos
 * reales que motivan esta prioridad:
 *   - "los precios del PDF no incluyen IVA, sumá 13%"
 *   - "ignorar las tarifas en colones, usar solo USD"
 *   - "el contrato vence en mayo 2027 aunque diga 2026"
 *   - "usar la ocupación doble como base"
 *
 * Si solo las tratáramos como "contexto complementario" (versión anterior),
 * el modelo las ignora cuando entran en conflicto con el texto del
 * documento — exactamente al revés de lo que el usuario quiere.
 */
function buildContextBlock(ctx: ExtractionContext | undefined): string | null {
  if (!ctx) return null;
  const parts: string[] = [];

  if (ctx.comments && ctx.comments.trim() !== "") {
    parts.push(
      "═══════════════════════════════════════════════════════════════════\n" +
        "INSTRUCCIONES DEL USUARIO — PRIORIDAD ALTA\n" +
        "═══════════════════════════════════════════════════════════════════\n\n" +
        "Las siguientes notas vienen directamente del usuario que cargó este " +
        "contrato. Son INSTRUCCIONES OPERACIONALES, no datos. Tienen " +
        "prioridad SOBRE el documento cuando dicen algo distinto a lo que " +
        "el documento muestra literalmente.\n\n" +
        "Ejemplos típicos: \"sumá IVA del 13% a los precios\", \"usá la " +
        "ocupación doble\", \"ignorá las tarifas en colones\", \"el contrato " +
        "vence en mayo 2027\". Si una instrucción contradice el documento, " +
        "seguí la instrucción del usuario y registralo en " +
        "paginas_origen_shared del campo afectado como \"user-override\".\n\n" +
        "Si la instrucción es un dato puntual (ej: el email de reservas), " +
        "tratala como autoritativa para ese campo y marcala como " +
        "\"user-provided\" en paginas_origen_shared.\n\n" +
        `-----BEGIN USER INSTRUCTIONS-----\n${ctx.comments.trim()}\n-----END USER INSTRUCTIONS-----`,
    );
  }

  if (ctx.isExistingSupplier !== undefined) {
    parts.push(
      ctx.isExistingSupplier
        ? "Este proveedor YA EXISTE en el sistema (es un proveedor recurrente)."
        : "Este proveedor es NUEVO (primera vez que se registra).",
    );
  }

  if (parts.length === 0) return null;
  return parts.join("\n\n");
}

/**
 * Service-level input for a single document that includes the user-visible
 * filename. We keep this separate from `PreparedDocument` (which is the raw
 * extractor output) because the extractors operate on buffers and don't know
 * the original filename — only the controller has that.
 */
export type PreparedDocumentInput = PreparedDocument & {
  originalName: string;
};

/**
 * Build the user message that gets sent alongside the system prompt. Tres
 * tipos de bloque según el documento:
 *   - PDF      → `document` block nativo (Claude lee layout + páginas).
 *   - Image    → `image` block nativo (Claude lee con vision).
 *   - DOCX/XLSX → texto convertido (mammoth / SheetJS).
 *
 * Cuando el caller manda contexto adicional (comments / supplier flag),
 * se prepende como bloque de texto separado para no mezclarse con los
 * documentos.
 *
 * Cuando se cargan varios documentos juntos, cada uno tiene su par
 * (header de texto, bloque de contenido). El header le indica al modelo
 * qué archivo está viendo para que las referencias cruzadas queden
 * legibles, y una instrucción final le pide tratar el bundle como UN
 * solo contrato lógico (caso típico: contrato principal + anexo + lista
 * de precios).
 */
function buildUserMessage(
  docs: PreparedDocumentInput[],
  ctx?: ExtractionContext,
): MessageParam {
  const content: ContentBlockParam[] = [];

  const contextBlock = buildContextBlock(ctx);
  if (contextBlock) {
    content.push({ type: "text", text: contextBlock });
  }

  if (docs.length > 1) {
    content.push({
      type: "text",
      text:
        `A continuación encontrarás ${docs.length} documentos relacionados ` +
        "que componen un mismo contrato (por ejemplo: contrato principal, " +
        "anexos, listas de precios). Trátalos como una sola fuente de " +
        "información y consolida los datos extraídos. Si un dato aparece en " +
        "más de un documento, prefiere el más reciente o el más específico; " +
        "registra la página de origen incluyendo el archivo cuando sea " +
        "ambiguo (ej: \"anexo.pdf p.3\").",
    });
  }

  docs.forEach((doc, idx) => {
    const label = `Documento ${idx + 1} de ${docs.length}: ${doc.originalName}`;
    if (doc.kind === "pdf") {
      content.push({ type: "text", text: label });
      content.push({
        type: "document",
        source: {
          type: "base64",
          media_type: doc.mediaType,
          data: doc.base64,
        },
      });
    } else if (doc.kind === "image") {
      // Imágenes (JPEG / PNG / GIF / WebP) van como bloque `image` nativo.
      // El header explícita "(imagen)" para que el modelo entienda que no
      // hay numeración de páginas — el campo `paginas_origen_*` debería
      // anotar simplemente el nombre del archivo (no un número) cuando el
      // origen sea una imagen.
      content.push({
        type: "text",
        text:
          `${label} (imagen — sin paginación; usá el nombre del archivo en ` +
          `paginas_origen_* en lugar de un número de página).`,
      });
      content.push({
        type: "image",
        source: {
          type: "base64",
          media_type: doc.mediaType,
          data: doc.base64,
        },
      });
    } else {
      const format =
        doc.sourceFormat === "docx" ? "Word" : "Excel";
      content.push({
        type: "text",
        text:
          `${label} (${format}, convertido a texto)\n\n` +
          `-----BEGIN DOCUMENT-----\n${doc.text}\n-----END DOCUMENT-----`,
      });
    }
  });

  const closing =
    docs.length === 1
      ? "Extrae los datos del contrato adjunto usando el tool " +
        `"${EXTRAER_DATOS_CONTRATO_TOOL_NAME}". Genera TODAS las ` +
        "combinaciones product × season en `rows` — no resumas a una sola " +
        "fila. Respeta las reglas del system prompt."
      : "Extrae los datos consolidados del conjunto de documentos usando el " +
        `tool "${EXTRAER_DATOS_CONTRATO_TOOL_NAME}". Genera TODAS las ` +
        "combinaciones product × season en `rows` — no resumas a una sola " +
        "fila. Respeta las reglas del system prompt.";
  content.push({ type: "text", text: closing });

  return { role: "user", content };
}

const stringOrNull = (v: unknown): string | null =>
  v === null || typeof v === "string" ? v : null;

/**
 * stringOrNumberAsString — algunos campos pueden venir como número (ej:
 * precios) y los queremos como string para preservar formato.
 */
const numericAsString = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") return v;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
};

function coerceTipoUnidad(v: unknown): TipoUnidad | null {
  if (v === "N" || v === "S") return v;
  return null;
}

function coerceSharedFields(input: unknown): SharedFields {
  if (!input || typeof input !== "object") {
    throw new Error("shared_fields no es un objeto");
  }
  const r = input as Record<string, unknown>;
  return {
    fecha: stringOrNull(r.fecha),
    proveedor: stringOrNull(r.proveedor),
    nombre_comercial: stringOrNull(r.nombre_comercial),
    cedula: stringOrNull(r.cedula),
    direccion: stringOrNull(r.direccion),
    telefono: stringOrNull(r.telefono),
    pais: stringOrNull(r.pais),
    state_province: stringOrNull(r.state_province),
    type_of_business: stringOrNull(r.type_of_business),
    contract_starts: stringOrNull(r.contract_starts),
    contract_ends: stringOrNull(r.contract_ends),
    reservations_email: stringOrNull(r.reservations_email),
    tipo_unidad: coerceTipoUnidad(r.tipo_unidad),
    tipo_servicio: stringOrNull(r.tipo_servicio),
    tipo_moneda: stringOrNull(r.tipo_moneda),
    numero_cuenta: stringOrNull(r.numero_cuenta),
    banco: stringOrNull(r.banco),
  };
}

function coerceRow(input: unknown): ContractRow {
  if (!input || typeof input !== "object") {
    throw new Error("rows[i] no es un objeto");
  }
  const r = input as Record<string, unknown>;
  return {
    product_name: stringOrNull(r.product_name),
    categoria: stringOrNull(r.categoria),
    ocupacion: stringOrNull(r.ocupacion),
    season_name: stringOrNull(r.season_name),
    season_starts: stringOrNull(r.season_starts),
    season_ends: stringOrNull(r.season_ends),
    meals_included: stringOrNull(r.meals_included),
    precios_neto_iva: numericAsString(r.precios_neto_iva),
    precio_rack_iva: numericAsString(r.precio_rack_iva),
    porcentaje_comision: numericAsString(r.porcentaje_comision),
    precios_neto_iva_fds: numericAsString(r.precios_neto_iva_fds),
    precio_rack_iva_fds: numericAsString(r.precio_rack_iva_fds),
    porcentaje_comision_fds: numericAsString(r.porcentaje_comision_fds),
    cancellation_policy: stringOrNull(r.cancellation_policy),
    range_payment_policy: stringOrNull(r.range_payment_policy),
    kids_policy: stringOrNull(r.kids_policy),
    other_included: stringOrNull(r.other_included),
    feeds_adicionales: stringOrNull(r.feeds_adicionales),
  };
}

function coercePaginasOrigen(
  input: unknown,
): Record<string, SourcePage> {
  if (!input || typeof input !== "object") return {};
  const r = input as Record<string, unknown>;
  const out: Record<string, SourcePage> = {};
  for (const [k, v] of Object.entries(r)) {
    if (typeof v === "string" || typeof v === "number") {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Runtime shape check on Claude's tool_use input before we hand it to the
 * validators. Claude is constrained by the schema, but a cosmic-ray bad
 * response (missing key, wrong type) shouldn't crash the server.
 */
function coerceExtraction(input: unknown): ExtractedContract {
  if (!input || typeof input !== "object") {
    throw new Error("tool_use.input no es un objeto");
  }
  const r = input as Record<string, unknown>;

  const shared_fields = coerceSharedFields(r.shared_fields);

  const rawRows = Array.isArray(r.rows) ? r.rows : [];
  if (rawRows.length === 0) {
    throw new Error("rows está vacío — el contrato debe tener al menos una combinación");
  }
  const rows = rawRows.map(coerceRow);

  const confianza = ((): Confianza => {
    const c = r.confianza;
    if (c === "alta" || c === "media" || c === "baja") return c;
    return "baja";
  })();

  const campos_faltantes = Array.isArray(r.campos_faltantes)
    ? r.campos_faltantes.filter((x): x is string => typeof x === "string")
    : [];

  const paginas_origen_shared = coercePaginasOrigen(r.paginas_origen_shared);

  // paginas_origen_rows debe ser un array paralelo a rows.
  const rawRowPages = Array.isArray(r.paginas_origen_rows)
    ? r.paginas_origen_rows
    : [];
  const paginas_origen_rows: Record<string, SourcePage>[] = rows.map((_, i) =>
    coercePaginasOrigen(rawRowPages[i]),
  );

  return {
    shared_fields,
    rows,
    confianza,
    campos_faltantes,
    paginas_origen_shared,
    paginas_origen_rows,
  };
}

export interface ExtractionResult {
  data: ExtractedContract;
  validation: ValidationResult;
  model: string;
  /**
   * Uso real reportado por Anthropic + costo estimado en USD según los
   * precios actuales del modelo (ver `PRICE_*_PER_MTOK_USD`). Se persiste
   * con el run para el historial / dashboards.
   */
  usage: {
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
  };
}

/**
 * Run the extraction against Anthropic with `tool_choice` forced to the
 * extraction tool. Accepts one or more prepared documents; Claude treats the
 * bundle as a single logical contract (see `buildUserMessage`). Maps SDK
 * errors to `ApiError` with spec-aligned status codes (502 for upstream
 * failures, 422 for a missing tool_use block).
 */
export async function extractContract(
  docs: PreparedDocumentInput[],
  requestId?: string,
  context?: ExtractionContext,
): Promise<ExtractionResult> {
  if (docs.length === 0) {
    // Defensive — the controller already rejects empty arrays with 400.
    throw ApiError.badRequest("Se requiere al menos un documento para extraer.");
  }

  const client = getAnthropicClient();

  // Streaming endpoint en lugar de `messages.create` no-stream: con
  // MAX_TOKENS alto (64k) y contratos densos, la generación puede tardar
  // 3-5 min y Anthropic recomienda streaming para evitar HTTP timeouts
  // upstream. La SDK helper `messages.stream().finalMessage()` colecta los
  // chunks y nos devuelve un `Message` con la misma forma que el endpoint
  // no-stream, así que el resto del flujo (búsqueda de tool_use, coerce,
  // validación) no cambia.
  let response;
  try {
    response = await client.messages
      .stream({
        model: SUPPLIER_INTELLIGENCE_MODEL,
        max_tokens: MAX_TOKENS,
        // No mandar `thinking`: la API rechaza con 400 cuando tool_choice
        // fuerza un tool, y como además forzamos el tool el modelo no hace
        // thinking del lado del servidor — todo el max_tokens va al output.
        system: SUPPLIER_INTELLIGENCE_SYSTEM_PROMPT,
        tools: [EXTRAER_DATOS_CONTRATO_TOOL],
        tool_choice: {
          type: "tool",
          name: EXTRAER_DATOS_CONTRATO_TOOL_NAME,
        },
        messages: [buildUserMessage(docs, context)],
      })
      .finalMessage();
  } catch (err) {
    // Map all Anthropic-side failures (timeouts, 429, 5xx, auth) to 502.
    // We never surface the upstream status code directly because the client
    // only cares that "the extractor is down".
    if (err instanceof APIError) {
      logger.error("Anthropic API error during extraction", {
        requestId,
        status: err.status,
        message: err.message,
      });
      throw new ApiError(
        502,
        "El servicio de extracción no está disponible en este momento. Intenta de nuevo en unos minutos.",
      );
    }
    logger.error("Unexpected error calling Anthropic", {
      requestId,
      error: err instanceof Error ? err.message : String(err),
    });
    throw new ApiError(502, "Error al invocar al agente de extracción.");
  }

  // Visibilidad: stop_reason + uso de tokens en TODA extracción. output_tokens
  // nos da una señal directa de cuánto cerca del cap está cada contrato —
  // útil para detectar la tendencia antes de pegar en MAX_TOKENS.
  logger.info("Anthropic extraction completed", {
    requestId,
    stopReason: response.stop_reason,
    outputTokens: response.usage?.output_tokens,
    inputTokens: response.usage?.input_tokens,
  });

  // Truncamiento por max_tokens: el JSON del tool_use queda partido a la
  // mitad y solo llega `shared_fields` (o ni eso). En lugar de fallar con
  // "formato inesperado" — que no le dice nada al usuario — devolvemos un
  // error específico. Con MAX_TOKENS=64k esto solo debería pasar en
  // contratos extraordinarios (>200 filas); si se vuelve recurrente, subir
  // MAX_TOKENS a 96k/128k es seguro — cobramos por tokens emitidos, no por
  // el cap.
  if (response.stop_reason === "max_tokens") {
    logger.warn("Extraction hit max_tokens — output truncated", {
      requestId,
      maxTokens: MAX_TOKENS,
      outputTokens: response.usage?.output_tokens,
    });
    throw new ApiError(
      502,
      "El contrato es excepcionalmente denso y la extracción excedió el " +
        "límite máximo de salida del agente. Avisanos para subir el " +
        "límite — el modelo soporta hasta el doble de la capacidad actual.",
    );
  }

  // Find the tool_use block. Even with `tool_choice` forced the API spec
  // leaves room for stop_reason === "max_tokens" or other edge cases.
  const toolUse = response.content.find(
    (block): block is ToolUseBlock =>
      block.type === "tool_use" &&
      block.name === EXTRAER_DATOS_CONTRATO_TOOL_NAME,
  );

  if (!toolUse) {
    logger.error("Anthropic response missing tool_use block", {
      requestId,
      stopReason: response.stop_reason,
      contentTypes: response.content.map((b) => b.type),
    });
    throw new ApiError(
      502,
      "El agente no devolvió datos estructurados. Intenta de nuevo.",
    );
  }

  let raw: ExtractedContract;
  try {
    raw = coerceExtraction(toolUse.input);
  } catch (err) {
    logger.error("Failed to coerce Claude tool_use input", {
      requestId,
      error: err instanceof Error ? err.message : String(err),
      stopReason: response.stop_reason,
      outputTokens: response.usage?.output_tokens,
      input: toolUse.input,
    });
    throw new ApiError(
      502,
      "El agente devolvió una respuesta con formato inesperado.",
    );
  }

  const { extraction, validation } = validateExtraction(raw);

  const inputTokens = response.usage?.input_tokens ?? 0;
  const outputTokens = response.usage?.output_tokens ?? 0;
  const costUsd = computeCostUsd(inputTokens, outputTokens);

  return {
    data: extraction,
    validation,
    model: SUPPLIER_INTELLIGENCE_MODEL,
    usage: { inputTokens, outputTokens, costUsd },
  };
}
