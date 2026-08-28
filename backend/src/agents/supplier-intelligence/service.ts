import { APIError } from "@anthropic-ai/sdk";
import type {
  ContentBlockParam,
  MessageParam,
  ToolUseBlock,
} from "@anthropic-ai/sdk/resources/messages.js";
import ApiError from "../../utils/ApiError.js";
import logger from "../../config/logger.js";
import type { Message } from "@anthropic-ai/sdk/resources/messages.js";
import { getAnthropicClient } from "./anthropicClient.js";
import {
  BRIEF_ANALYSIS_SYSTEM_PROMPT,
  CONTRACT_BRIEF_INSTRUCTION,
  CONTRACT_BRIEF_REFINE_INSTRUCTION,
  EXTRACT_WITH_CONFIRMED_BRIEF_CLOSING,
  EXTRAER_DATOS_CONTRATO_TOOL,
  EXTRAER_DATOS_CONTRATO_TOOL_NAME,
  REGISTRAR_BRIEF_CONTRATO_TOOL,
  REGISTRAR_BRIEF_CONTRATO_TOOL_NAME,
  renderContractBriefBlock,
  SUPPLIER_INTELLIGENCE_SYSTEM_PROMPT,
} from "./prompts/index.js";
import { validateExtraction, normalizeCurrency } from "./validators.js";
import { enrichBriefOccupancies } from "./catalogRules.js";
import type {
  BriefChatMessage,
  Confianza,
  ContractBrief,
  ContractBriefAdditionalPerson,
  ContractBriefBankAccount,
  ContractBriefRowPlan,
  ProductOccupancySpec,
  ContractBriefSeason,
  ContractBriefSharedFields,
  ContractRow,
  ExtractedContract,
  PaymentTerms,
  PreparedDocument,
  SharedFields,
  SourcePage,
  TipoUnidad,
  ValidationResult,
} from "./types.js";

/**
 * Opus 5 es el modelo de extracción. Es más caro y más lento que Sonnet,
 * pero la tarea requiere generar potencialmente decenas de filas con
 * razonamiento sobre múltiples temporadas/categorías — Opus paga el precio
 * en calidad de extracción.
 *
 * Notas de migración 4.7 → 5 (ago 2026):
 *   - Drop-in: mismo SDK, mismo tool-use, mismo schema, mismo pricing
 *     ($5 / $25 por millón, igual que 4.7/4.8).
 *   - Context window: 1M tokens (igual que 4.7). Max output: 128k (igual).
 */
export const SUPPLIER_INTELLIGENCE_MODEL = "claude-opus-5";

/**
 * Modelo de la pasada de BRIEF / Variables de Configuración (Fase 1).
 * Sonnet 5: rápido y barato para estructurar reglas globales; Opus se
 * reserva para la extracción de filas (pasada principal). Context window de
 * 1M tokens por defecto (los contratos densos >200k tokens reventaban el
 * límite de 200k de Sonnet 4.5 con "prompt is too long") y MÁS BARATO que
 * Sonnet 4.5/4.6: $2 / $10 por millón vs $3 / $15.
 */
export const SUPPLIER_INTELLIGENCE_BRIEF_MODEL = "claude-sonnet-5";

/**
 * Pricing por modelo (USD por millón de tokens). El flujo usa DOS modelos
 * (Sonnet 5 para el brief, Opus 5 para la extracción), así que el costo se
 * calcula por-pasada con la tarifa del modelo correspondiente. Incluye los
 * buckets de cache por si Anthropic los reporta, aunque hoy no activamos
 * caching (ver `SUPPLIER_INTELLIGENCE_BRIEF_MODEL`). Se conservan las
 * tarifas de modelos anteriores para poder recomputar costos de runs
 * históricos. Si Anthropic cambia precios este es el único lugar donde
 * editar — el cómputo de `cost_usd` por extracción se hace abajo en
 * `extractContract`.
 *
 * Fuente: platform.claude.com/docs/en/about-claude/pricing (ago 2026).
 */
interface ModelPrices {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

const MODEL_PRICES: Record<string, ModelPrices> = {
  "claude-opus-5": { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  "claude-sonnet-5": { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 },
  "claude-opus-4-7": { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  "claude-opus-4-8": { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  "claude-sonnet-4-5": { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  "claude-sonnet-4-6": { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
};

// Fallback a Opus (el más caro) si llegara un modelo desconocido — preferimos
// sobre-estimar el costo que sub-reportarlo.
const FALLBACK_PRICES: ModelPrices = MODEL_PRICES["claude-opus-5"]!;

/**
 * Telemetría de tokens normalizada a partir de un `Message` de Anthropic.
 * `inputTokens` agrega todos los buckets de input (plano + cache write +
 * cache read) para que el badge "Input" del historial muestre el total real
 * procesado; `costUsd` se calcula con la tarifa del modelo de esta pasada.
 */
interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  costUsd: number;
}

function usageFromMessage(msg: Message, model: string): TokenUsage {
  const prices = MODEL_PRICES[model] ?? FALLBACK_PRICES;
  const u = msg.usage;
  const plainInput = u?.input_tokens ?? 0;
  const cacheWrite = u?.cache_creation_input_tokens ?? 0;
  const cacheRead = u?.cache_read_input_tokens ?? 0;
  const output = u?.output_tokens ?? 0;
  const costUsd =
    (plainInput / 1_000_000) * prices.input +
    (cacheWrite / 1_000_000) * prices.cacheWrite +
    (cacheRead / 1_000_000) * prices.cacheRead +
    (output / 1_000_000) * prices.output;
  return {
    inputTokens: plainInput + cacheWrite + cacheRead,
    outputTokens: output,
    cacheWriteTokens: cacheWrite,
    cacheReadTokens: cacheRead,
    costUsd: Number(costUsd.toFixed(6)),
  };
}

/** Suma la telemetría de varias pasadas (brief + extracción principal). */
function sumUsage(parts: TokenUsage[]): TokenUsage {
  const acc = parts.reduce(
    (a, p) => ({
      inputTokens: a.inputTokens + p.inputTokens,
      outputTokens: a.outputTokens + p.outputTokens,
      cacheWriteTokens: a.cacheWriteTokens + p.cacheWriteTokens,
      cacheReadTokens: a.cacheReadTokens + p.cacheReadTokens,
      costUsd: a.costUsd + p.costUsd,
    }),
    {
      inputTokens: 0,
      outputTokens: 0,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
      costUsd: 0,
    },
  );
  acc.costUsd = Number(acc.costUsd.toFixed(6));
  return acc;
}

/**
 * Cap de output tokens. Historia:
 *   - 1500: una fila plana (~150 tokens). Histórico.
 *   - 16k:  Parador (~21 filas ≈ 5-8k tokens). OK pero ajustado.
 *   - 32k:  intento de cubrir BTPV (~130 filas), insuficiente.
 *   - 64k:  cubre BTPV (~40k output) con margen, pero PDFs muy densos
 *           empezaron a apretar.
 *   - 128k: máximo soportado por Opus 5 (igual que 4.7). Damos todo el headroom posible
 *           porque NO cobramos por el cap — solo por los tokens que
 *           efectivamente se emiten — así que el único costo es latencia
 *           si el modelo se acerca al cap. En la práctica un contrato
 *           normal se queda muy por debajo.
 *
 * El context window de Opus 5 es 1M, así que el cuello de botella
 * realista ahora es el output, no el input.
 *
 * NOTA: a partir de ~16k Anthropic recomienda streaming para evitar HTTP
 * timeouts upstream — ver `extractContract`.
 *
 * NOTA sobre extended thinking: NO podemos enviar `thinking` config en
 * esta llamada — la API responde 400 con
 *   "Thinking may not be enabled when tool_choice forces tool use."
 * y como nosotros forzamos tool_choice (es la base del schema-driven
 * extract), thinking queda automáticamente deshabilitado del lado del
 * servidor. Eso significa que los 128k completos van a la salida.
 */
const MAX_TOKENS = 128_000;

/**
 * Cuántas veces reintentar una pasada que cae por un error de TRANSPORTE
 * transitorio (socket terminado a mitad del stream, reset de conexión, etc.).
 * La extracción es idempotente (no tiene side-effects), así que reintentar es
 * seguro: lo peor que pasa es que pagamos input de nuevo. 2 reintentos cubren
 * los drops esporádicos sin colgar al usuario por minutos.
 */
const STREAM_RETRY_ATTEMPTS = 2;
const STREAM_RETRY_BASE_DELAY_MS = 1_500;

/**
 * Heurística para detectar fallas de transporte transitorias que NO son un
 * error semántico de Anthropic (esos vienen como `APIError` con status). El
 * caso clásico de contratos densos es undici reportando `"terminated"` cuando
 * el socket del stream largo se cae. También cubrimos resets / timeouts de
 * red comunes. Estos SÍ valen un reintento; un APIError 4xx (p. ej. request
 * inválido) NO — eso lo dejamos propagar.
 */
function isTransientTransportError(err: unknown): boolean {
  if (err instanceof APIError) {
    // Overload / errores 5xx de Anthropic: transitorios, valen reintento.
    const status = err.status ?? 0;
    return status === 429 || status === 529 || (status >= 500 && status < 600);
  }
  const msg = (
    err instanceof Error ? err.message : String(err ?? "")
  ).toLowerCase();
  const code =
    err && typeof err === "object" && "code" in err
      ? String((err as { code?: unknown }).code ?? "").toUpperCase()
      : "";
  return (
    msg.includes("terminated") ||
    msg.includes("socket hang up") ||
    msg.includes("econnreset") ||
    msg.includes(" econnreset") ||
    msg.includes("network") ||
    msg.includes("fetch failed") ||
    msg.includes("other side closed") ||
    msg.includes("premature close") ||
    code === "ECONNRESET" ||
    code === "ETIMEDOUT" ||
    code === "EPIPE" ||
    code === "UND_ERR_SOCKET" ||
    code === "UND_ERR_HEADERS_TIMEOUT" ||
    code === "UND_ERR_BODY_TIMEOUT"
  );
}

/**
 * Convierte errores de la API de Anthropic en `ApiError` con mensajes claros
 * para el operador. Antes todo se mapeaba a un 502 genérico — p. ej. créditos
 * agotados (400) parecía "servicio no disponible" y el Paso 2 llegaba vacío.
 */
function mapAnthropicApiError(err: APIError): ApiError {
  const lower = (err.message ?? "").toLowerCase();

  if (
    lower.includes("credit balance") ||
    lower.includes("purchase credits") ||
    lower.includes("billing")
  ) {
    return new ApiError(
      402,
      "Los créditos de Anthropic están agotados. Contactá al administrador para recargar la cuenta antes de continuar.",
    );
  }
  if (err.status === 429) {
    return new ApiError(
      429,
      "Demasiadas solicitudes al servicio de IA. Esperá un minuto e intentá de nuevo.",
    );
  }
  if (err.status === 529) {
    return new ApiError(
      503,
      "El servicio de IA está saturado. Intentá de nuevo en unos minutos.",
    );
  }
  if (
    err.status === 401 ||
    lower.includes("authentication") ||
    lower.includes("invalid api key") ||
    lower.includes("api key")
  ) {
    return new ApiError(
      502,
      "La clave de API de Anthropic no es válida. Contactá al administrador.",
    );
  }

  return new ApiError(
    502,
    "El servicio de extracción no está disponible en este momento. Intenta de nuevo en unos minutos.",
  );
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Corre una pasada de streaming reintentando ante fallas de transporte
 * transitorias (ver `isTransientTransportError`). Cada intento abre un stream
 * nuevo — el endpoint de Anthropic es stateless, así que un retry simplemente
 * re-emite la generación desde cero. Backoff lineal corto entre intentos.
 */
async function runStreamWithRetry(
  run: () => Promise<Message>,
  opts: { requestId?: string; label: string },
): Promise<Message> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= STREAM_RETRY_ATTEMPTS + 1; attempt += 1) {
    try {
      return await run();
    } catch (err) {
      lastErr = err;
      const transient = isTransientTransportError(err);
      const hasMoreAttempts = attempt <= STREAM_RETRY_ATTEMPTS;
      if (!transient || !hasMoreAttempts) throw err;
      const delay = STREAM_RETRY_BASE_DELAY_MS * attempt;
      logger.warn("Anthropic stream failed — retrying", {
        requestId: opts.requestId,
        label: opts.label,
        attempt,
        nextAttemptInMs: delay,
        error: err instanceof Error ? err.message : String(err),
      });
      await sleep(delay);
    }
  }
  // Inalcanzable (el loop o devuelve o tira), pero TS necesita el throw.
  throw lastErr;
}

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
interface BuildUserMessageOpts {
  context?: ExtractionContext;
  /**
   * "brief"   → Fase 1: pide solo el brief (reglas globales + inventario).
   * "refine"  → Re-análisis tras feedback humano sobre el brief anterior.
   * "extract" → Fase 2: pide todas las filas, inyectando el brief ya extraído.
   */
  mode: "brief" | "refine" | "extract";
  /** Brief ya extraído — solo se usa (y se requiere) en mode "extract". */
  brief?: ContractBrief | null;
  /**
   * Múltiples briefs confirmados (uno por documento). Cuando viene con >1
   * entrada, se renderiza un bloque por brief y se instruye al modelo a
   * consolidarlos en un único conjunto de filas. Tiene prioridad sobre `brief`.
   */
  briefs?: ContractBrief[] | null;
  /** True cuando el brief fue confirmado por el humano (flujo gated). */
  briefConfirmed?: boolean;
  /** Contexto de refinamiento — solo en mode "refine". */
  refine?: BriefRefineContext;
  /**
   * Pasada PARCIAL de extracción (contratos densos fragmentados por
   * temporada). `seasonNames` son las temporadas de ESTA pasada; la pasada
   * 0 además captura las filas sin temporada (transfers, tours, comidas).
   */
  shard?: ExtractionShard;
}

/** Una pasada parcial del plan de fragmentación por temporadas. */
export interface ExtractionShard {
  index: number;
  total: number;
  seasonNames: string[];
}

/**
 * Instrucción de ECONOMÍA DE SALIDA para la pasada de extracción. El cuello
 * de botella real en contratos densos es el output (128k máx.), no el input
 * (ventana de 1M) — así que le exigimos al modelo el formato compacto que el
 * schema ya permite: defaults una vez, overrides solo cuando difieren.
 */
const OUTPUT_ECONOMY_INSTRUCTION =
  "ECONOMÍA DE SALIDA (OBLIGATORIO): el límite duro de esta tarea es el " +
  "tamaño de la RESPUESTA, no tu capacidad de lectura. Para que un contrato " +
  "denso quepa completo:\n" +
  "  • Escribí las políticas (cancellation_policy, range_payment_policy, " +
  "kids_policy, other_included, feeds_adicionales) UNA SOLA VEZ en " +
  "`row_defaults`. En las filas OMITÍ esos campos salvo que esa fila " +
  "difiera del default.\n" +
  "  • OMITÍ los campos *_fds cuando el contrato no distingue " +
  "weekday/weekend — el servidor copia la tarifa estándar.\n" +
  "  • En paginas_origen_rows anotá solo los campos de precio; usá {} si " +
  "no hay nada que anotar.\n" +
  "  • NO omitas filas: la economía es por campo repetido, JAMÁS por " +
  "combinación product × season × ocupación.";

/** Instrucción de pasada parcial (fragmentación por temporadas). */
function renderShardInstruction(shard: ExtractionShard): string {
  const seasonList = shard.seasonNames.map((s) => `"${s}"`).join(", ");
  const seasonless =
    shard.index === 0
      ? "Incluí TAMBIÉN en esta pasada las filas que NO dependen de " +
        "temporada (transfers, tours, alimentación/desayunos opcionales, " +
        "servicios de tarifa única)."
      : "NO incluyas filas sin temporada (transfers, tours, comidas de " +
        "tarifa única) — esas se extraen en la pasada 1.";
  return (
    "═══════════════════════════════════════════════════════════════════\n" +
    `PASADA PARCIAL ${shard.index + 1} de ${shard.total} — EXTRACCIÓN POR TEMPORADAS\n` +
    "═══════════════════════════════════════════════════════════════════\n\n" +
    "Este contrato es demasiado denso para extraerlo en una sola respuesta, " +
    "así que se fragmentó por temporadas. En ESTA pasada generá ÚNICAMENTE " +
    `las filas cuyo season_name corresponda a: ${seasonList}. ` +
    "Las demás temporadas se extraen en otras pasadas — NO las incluyas.\n" +
    seasonless +
    "\nDentro de tus temporadas asignadas seguí generando TODAS las " +
    "combinaciones product × ocupación — la fragmentación es por temporada, " +
    "no un permiso para resumir. El estimado global de filas del brief " +
    "(row_plan.expected_rows) aplica al TOTAL de todas las pasadas juntas, " +
    "no a esta pasada.\n" +
    "shared_fields, row_defaults, bank_accounts, payment_terms y " +
    "paginas_origen_shared van COMPLETOS en cada pasada (el servidor " +
    "consolida)."
  );
}

/** Contexto acumulado para POST /refine-brief. */
export interface BriefRefineContext {
  previousBrief: ContractBrief;
  feedback: string;
  chatHistory?: BriefChatMessage[];
}

function buildUserMessage(
  docs: PreparedDocumentInput[],
  opts: BuildUserMessageOpts,
): MessageParam {
  const { context: ctx, mode, brief, briefs, refine, briefConfirmed, shard } =
    opts;
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
      const format = doc.sourceFormat === "docx" ? "Word" : "Excel";
      content.push({
        type: "text",
        text:
          `${label} (${format}, convertido a texto)\n\n` +
          `-----BEGIN DOCUMENT-----\n${doc.text}\n-----END DOCUMENT-----`,
      });
    }
  });

  // PROMPT CACHING: breakpoint tras el último bloque de documento. El prefijo
  // cacheado (system + tools + contexto + documentos) es idéntico entre:
  //   - brief → refine(s): cada turno del chat del Paso 2 re-manda los
  //     documentos; con el cache los relee al 10% del precio de input.
  //   - las pasadas parciales de extracción (fragmentación por temporadas):
  //     la pasada 1 escribe el cache y las demás lo leen.
  //   - los reintentos de transporte de `runStreamWithRetry`.
  // Si el prefijo no llega al mínimo cacheable del modelo, la API lo ignora
  // silenciosamente — no hay caso de error nuevo. El cómputo de costo ya
  // distingue los buckets cacheWrite/cacheRead (ver `usageFromMessage`).
  if (content.length > 0) {
    const lastDocBlock = content[content.length - 1] as ContentBlockParam & {
      cache_control?: { type: "ephemeral" };
    };
    lastDocBlock.cache_control = { type: "ephemeral" };
  }

  if (mode === "brief") {
    content.push({ type: "text", text: CONTRACT_BRIEF_INSTRUCTION });
    return { role: "user", content };
  }

  if (mode === "refine" && refine) {
    content.push({
      type: "text",
      text:
        "═══════════════════════════════════════════════════════════════════\n" +
        "BRIEF ANTERIOR (generado en el análisis previo)\n" +
        "═══════════════════════════════════════════════════════════════════\n\n" +
        JSON.stringify(refine.previousBrief, null, 2),
    });
    if (refine.chatHistory && refine.chatHistory.length > 0) {
      const historyLines = refine.chatHistory
        .map(
          (m) =>
            `${m.role === "user" ? "Operador" : "Asistente"}: ${m.content}`,
        )
        .join("\n\n");
      content.push({
        type: "text",
        text:
          "Historial de correcciones previas:\n\n" + historyLines,
      });
    }
    content.push({
      type: "text",
      text:
        "═══════════════════════════════════════════════════════════════════\n" +
        "FEEDBACK DEL OPERADOR (corregí el brief según esto)\n" +
        "═══════════════════════════════════════════════════════════════════\n\n" +
        refine.feedback,
    });
    content.push({ type: "text", text: CONTRACT_BRIEF_REFINE_INSTRUCTION });
    return { role: "user", content };
  }

  // mode === "extract": inyectamos el/los brief(s) (si los tenemos) como
  // contexto de prioridad alta ANTES de la instrucción final.
  const briefList =
    briefs && briefs.length > 0 ? briefs : brief ? [brief] : [];
  if (briefList.length === 1) {
    content.push({
      type: "text",
      text: renderContractBriefBlock(briefList[0]!),
    });
  } else if (briefList.length > 1) {
    content.push({
      type: "text",
      text:
        `Se te entregan ${briefList.length} BRIEFS, uno por documento. Cada ` +
        "brief fue validado por un operador humano. Tu trabajo es " +
        "CONSOLIDARLOS en UN SOLO conjunto de filas para el Excel: eliminá " +
        "duplicados, resolvé contradicciones según las '⚠️ Notas críticas' de " +
        "cada brief, y priorizá el brief con información más completa para cada " +
        "campo. Si un dato proviene de un documento específico, anotalo en las " +
        "notas de la fila.",
    });
    briefList.forEach((b, i) => {
      content.push({
        type: "text",
        text:
          `═══════════ BRIEF ${i + 1} de ${briefList.length} ═══════════\n` +
          renderContractBriefBlock(b),
      });
    });
  }

  const confirmedBrief = briefConfirmed === true;
  const closingBase = confirmedBrief
    ? EXTRACT_WITH_CONFIRMED_BRIEF_CLOSING
    : docs.length === 1
      ? "Extrae los datos del contrato adjunto usando el tool " +
        `"${EXTRAER_DATOS_CONTRATO_TOOL_NAME}". Genera TODAS las ` +
        "combinaciones product × season en `rows` — no resumas a una sola " +
        "fila. Respeta las reglas del system prompt y el CONTRACT BRIEF de " +
        "arriba (impuestos, persona adicional, bancos, inventario)."
      : "Extrae los datos consolidados del conjunto de documentos usando el " +
        `tool "${EXTRAER_DATOS_CONTRATO_TOOL_NAME}". Genera TODAS las ` +
        "combinaciones product × season en `rows` — no resumas a una sola " +
        "fila. Respeta las reglas del system prompt y el CONTRACT BRIEF de " +
        "arriba (impuestos, persona adicional, bancos, inventario).";
  content.push({ type: "text", text: closingBase });
  content.push({ type: "text", text: OUTPUT_ECONOMY_INSTRUCTION });
  if (shard && shard.total > 1) {
    content.push({ type: "text", text: renderShardInstruction(shard) });
  }

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
    others_payment_cancel: stringOrNull(r.others_payment_cancel),
    notes: stringOrNull(r.notes),
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
    tipo_servicio: stringOrNull(r.tipo_servicio),
    tipo_unidad: coerceTipoUnidad(r.tipo_unidad),
    codigo_servicio: stringOrNull(r.codigo_servicio),
    ocupacion: stringOrNull(r.ocupacion),
    tarifa_persona_adicional: numericAsString(r.tarifa_persona_adicional),
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

/**
 * Defaults a nivel contrato para los campos de texto largo de las filas
 * (ver `rowDefaultsSchema` en prompts/toolSchema.ts). El modelo los emite
 * UNA sola vez y acá hacemos el fan-out determinístico a cada fila, de modo
 * que TODO el pipeline downstream (validators, xlsx, UI, chat de tabla)
 * sigue viendo filas completas — el cambio de formato es invisible fuera
 * de este archivo.
 *
 * Motivación: con el formato anterior el modelo re-escribía las mismas
 * políticas (100-200 tokens cada una) en CADA fila. En contratos densos
 * (Four Seasons: ~400 filas) eso solo ya superaba el cap de 128k tokens de
 * salida y truncaba la extracción.
 */
interface RowTextDefaults {
  cancellation_policy: string | null;
  range_payment_policy: string | null;
  kids_policy: string | null;
  other_included: string | null;
  feeds_adicionales: string | null;
}

const EMPTY_ROW_DEFAULTS: RowTextDefaults = {
  cancellation_policy: null,
  range_payment_policy: null,
  kids_policy: null,
  other_included: null,
  feeds_adicionales: null,
};

function coerceRowDefaults(v: unknown): RowTextDefaults {
  if (!v || typeof v !== "object") return EMPTY_ROW_DEFAULTS;
  const r = v as Record<string, unknown>;
  return {
    cancellation_policy: stringOrNull(r.cancellation_policy),
    range_payment_policy: stringOrNull(r.range_payment_policy),
    kids_policy: stringOrNull(r.kids_policy),
    other_included: stringOrNull(r.other_included),
    feeds_adicionales: stringOrNull(r.feeds_adicionales),
  };
}

/**
 * Materializa en una fila (a) los defaults de políticas cuando la fila no
 * los sobreescribió, y (b) la convención `_fds` = tarifa estándar cuando el
 * contrato no distingue weekday/weekend (el modelo ahora OMITE esos campos
 * en vez de copiarlos — misma semántica del maestro Utopía, cero tokens).
 */
function applyRowDefaults(row: ContractRow, d: RowTextDefaults): ContractRow {
  return {
    ...row,
    precios_neto_iva_fds: row.precios_neto_iva_fds ?? row.precios_neto_iva,
    precio_rack_iva_fds: row.precio_rack_iva_fds ?? row.precio_rack_iva,
    porcentaje_comision_fds:
      row.porcentaje_comision_fds ?? row.porcentaje_comision,
    cancellation_policy: row.cancellation_policy ?? d.cancellation_policy,
    range_payment_policy: row.range_payment_policy ?? d.range_payment_policy,
    kids_policy: row.kids_policy ?? d.kids_policy,
    other_included: row.other_included ?? d.other_included,
    feeds_adicionales: row.feeds_adicionales ?? d.feeds_adicionales,
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
function coerceExtraction(
  input: unknown,
  opts?: {
    /**
     * Pasadas parciales (extracción por temporadas): una pasada puede
     * legítimamente no aportar filas nuevas (p. ej. si el modelo puso las
     * filas sin temporada en otra pasada). El merge valida el total.
     */
    allowEmptyRows?: boolean;
  },
): ExtractedContract {
  if (!input || typeof input !== "object") {
    throw new Error("tool_use.input no es un objeto");
  }
  const r = input as Record<string, unknown>;

  const shared_fields = coerceSharedFields(r.shared_fields);

  const rawRows = Array.isArray(r.rows) ? r.rows : [];
  if (rawRows.length === 0 && !opts?.allowEmptyRows) {
    throw new Error("rows está vacío — el contrato debe tener al menos una combinación");
  }
  const rowDefaults = coerceRowDefaults(r.row_defaults);
  const rows = rawRows
    .map(coerceRow)
    .map((row) => applyRowDefaults(row, rowDefaults));

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
    bank_accounts: coerceBankAccounts(r.bank_accounts),
    payment_terms: coercePaymentTerms(r.payment_terms),
  };
}

function coercePaymentTerms(v: unknown): PaymentTerms | null {
  if (!v || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  return {
    condition: stringOrNull(r.condition),
    term_days: numberOrNull(r.term_days),
    term_note: stringOrNull(r.term_note),
  };
}

/* -------------------------------------------------------------------------- */
/*                     Contract Brief (Fase 1) — coerce + call                */
/* -------------------------------------------------------------------------- */

const boolOrNull = (v: unknown): boolean | null =>
  typeof v === "boolean" ? v : null;

const numberOrNull = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v.replace(/[^0-9.,-]/g, "").replace(",", "."));
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

const stringArray = (v: unknown): string[] =>
  Array.isArray(v)
    ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "")
    : [];

function coerceBankAccounts(v: unknown): ContractBriefBankAccount[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
    .map((r) => ({
      bank: stringOrNull(r.bank),
      account_number: stringOrNull(r.account_number),
      currency: stringOrNull(r.currency),
      swift: stringOrNull(r.swift),
      note: stringOrNull(r.note),
    }));
}

function coerceAdditionalPerson(
  v: unknown,
): ContractBriefAdditionalPerson[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
    .map((r) => ({
      scope: stringOrNull(r.scope),
      applies_to: stringOrNull(r.applies_to),
      rack: numericAsString(r.rack),
      net: numericAsString(r.net),
    }));
}

function coerceSeasonsDetail(v: unknown): ContractBriefSeason[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
    .map((r) => ({
      name: stringOrNull(r.name),
      starts: stringOrNull(r.starts),
      ends: stringOrNull(r.ends),
      raw_range: stringOrNull(r.raw_range),
    }));
}

/**
 * Reconcilia las DOS representaciones de temporadas que puede emitir el modelo:
 *   - `seasons`        → solo nombres (campo requerido; el modelo casi siempre
 *                        lo llena).
 *   - `seasons_detail` → nombres + fechas (campo más rico; el modelo a veces lo
 *                        deja vacío porque las fechas dan más trabajo).
 *
 * Sin esto, un contrato con dos temporadas (ej. Grano de Oro "Alta"/"Baja")
 * podía traer `seasons: ["Alta","Baja"]` pero `seasons_detail: []`, y la
 * pantalla de Variables de Configuración (que muestra seasons_detail) quedaba
 * VACÍA — parecía que no se detectaron temporadas cuando sí estaban.
 *
 * Estrategia: garantizamos que AMBOS lados contengan las mismas temporadas.
 *   - Si hay detail pero falta algún nombre en `seasons`, lo agregamos.
 *   - Si hay nombres en `seasons` sin entrada en detail, creamos la entrada
 *     (con fechas en null para que el usuario las complete/confirme).
 * El match es por nombre normalizado (trim + lowercase).
 */
function reconcileSeasons(
  seasons: string[],
  detail: ContractBriefSeason[],
): { seasons: string[]; seasons_detail: ContractBriefSeason[] } {
  const norm = (s: string | null): string => (s ?? "").trim().toLowerCase();

  const detailByName = new Map<string, ContractBriefSeason>();
  for (const d of detail) {
    const key = norm(d.name);
    if (key !== "" && !detailByName.has(key)) detailByName.set(key, d);
  }

  // 1) Toda temporada nombrada en `seasons` debe existir en detail.
  for (const name of seasons) {
    const key = norm(name);
    if (key !== "" && !detailByName.has(key)) {
      const synthesized: ContractBriefSeason = {
        name,
        starts: null,
        ends: null,
        raw_range: null,
      };
      detailByName.set(key, synthesized);
      detail = [...detail, synthesized];
    }
  }

  // 2) Todo detail debe estar reflejado en la lista de nombres.
  const nameSet = new Set(seasons.map(norm));
  const mergedNames = [...seasons];
  for (const d of detail) {
    const key = norm(d.name);
    if (key !== "" && !nameSet.has(key)) {
      nameSet.add(key);
      mergedNames.push(d.name as string);
    }
  }

  return { seasons: mergedNames, seasons_detail: detail };
}

function coerceBriefSharedFields(v: unknown): ContractBriefSharedFields {
  const r = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  return {
    proveedor: stringOrNull(r.proveedor),
    nombre_comercial: stringOrNull(r.nombre_comercial),
    cedula: stringOrNull(r.cedula),
    type_of_business: stringOrNull(r.type_of_business),
    direccion: stringOrNull(r.direccion),
    telefono: stringOrNull(r.telefono),
    pais: stringOrNull(r.pais),
    state_province: stringOrNull(r.state_province),
    reservations_email: stringOrNull(r.reservations_email),
    fecha: stringOrNull(r.fecha),
    contract_starts: stringOrNull(r.contract_starts),
    contract_ends: stringOrNull(r.contract_ends),
  };
}

function coerceOccupanciesByProduct(v: unknown): ProductOccupancySpec[] {
  if (!Array.isArray(v)) return [];
  const out: ProductOccupancySpec[] = [];
  for (const item of v) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const product = stringOrNull(r.product);
    const occupancy_codes = stringArray(r.occupancy_codes).map((c) =>
      c.toUpperCase(),
    );
    if (product && occupancy_codes.length > 0) {
      out.push({ product, occupancy_codes });
    }
  }
  return out;
}

function coerceRowPlan(v: unknown): ContractBriefRowPlan | null {
  if (!v || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  const categories = stringArray(r.categories);
  if (categories.length === 0 && r.expected_rows == null) return null;
  return {
    categories:
      categories.length > 0 ? categories : stringArray(r.product_categories),
    occupancies_per_category: numberOrNull(r.occupancies_per_category),
    seasons_count: numberOrNull(r.seasons_count),
    expected_rows: numberOrNull(r.expected_rows),
  };
}

/** Fallback si el modelo no emitió logic_summary. */
function buildLogicSummaryFallback(brief: Omit<ContractBrief, "logic_summary" | "row_plan">): string {
  const parts: string[] = [];
  const name =
    brief.shared_fields.nombre_comercial ??
    brief.shared_fields.proveedor ??
    "este proveedor";
  parts.push(`Estás cargando las tarifas de ${name}.`);

  if (brief.shared_fields.pais || brief.shared_fields.direccion) {
    const loc = [brief.shared_fields.direccion, brief.shared_fields.pais]
      .filter(Boolean)
      .join(", ");
    if (loc) parts.push(`Ubicación: ${loc}.`);
  }

  if (brief.shared_fields.contract_starts || brief.shared_fields.contract_ends) {
    parts.push(
      `Vigencia del contrato: ${brief.shared_fields.contract_starts ?? "?"} al ${brief.shared_fields.contract_ends ?? "?"}.`,
    );
  }

  if (brief.seasons_detail.length > 0) {
    const seasonDesc = brief.seasons_detail
      .map((s) => {
        const range =
          s.raw_range ??
          [s.starts, s.ends].filter(Boolean).join(" – ") ??
          "";
        return `${s.name ?? "Temporada"}${range ? ` (${range})` : ""}`;
      })
      .join("; ");
    parts.push(`Temporadas detectadas: ${seasonDesc}.`);
  } else if (brief.seasons.length > 0) {
    parts.push(`Temporadas: ${brief.seasons.join(", ")}.`);
  }

  if (brief.currency) {
    parts.push(`Moneda: ${brief.currency}.`);
  }

  if (brief.prices_include_tax === false) {
    const rate = brief.tax_rate_pct ?? 13;
    parts.push(`Los precios NO incluyen el IVA del ${rate}%.`);
  } else if (brief.prices_include_tax === true) {
    parts.push("Los precios incluyen IVA.");
  }

  if (brief.commission_default_pct != null) {
    parts.push(`Comisión general: ${brief.commission_default_pct}%.`);
  }
  if (brief.commission_summary) {
    parts.push(brief.commission_summary);
  }

  if (brief.product_categories.length > 0) {
    parts.push(
      `Categorías: ${brief.product_categories.join(", ")}.`,
    );
  }

  const est = brief.expected_row_estimate;
  if (est != null && est > 0) {
    parts.push(`Se estiman aproximadamente ${est} filas en el Excel.`);
  }

  if (brief.meal_plan_note) {
    parts.push(brief.meal_plan_note);
  }
  if (brief.special_periods_note) {
    parts.push(brief.special_periods_note);
  }
  if (brief.notes) {
    parts.push(brief.notes);
  }

  return parts.join(" ");
}

export function coerceBrief(input: unknown): ContractBrief {
  const r =
    input && typeof input === "object"
      ? (input as Record<string, unknown>)
      : {};
  const reconciled = reconcileSeasons(
    stringArray(r.seasons),
    coerceSeasonsDetail(r.seasons_detail),
  );
  const productCategories = stringArray(r.product_categories);
  let rowPlan = coerceRowPlan(r.row_plan);
  if (!rowPlan && productCategories.length > 0) {
    rowPlan = {
      categories: productCategories,
      occupancies_per_category: null,
      seasons_count: reconciled.seasons_detail.length || reconciled.seasons.length || null,
      expected_rows: numberOrNull(r.expected_row_estimate),
    };
  }
  const base: Omit<ContractBrief, "logic_summary" | "row_plan"> = {
    shared_fields: coerceBriefSharedFields(r.shared_fields),
    prices_include_tax: boolOrNull(r.prices_include_tax),
    tax_rate_pct: numberOrNull(r.tax_rate_pct),
    tax_note: stringOrNull(r.tax_note),
    commission_default_pct: numberOrNull(r.commission_default_pct),
    commission_summary: stringOrNull(r.commission_summary),
    meal_plan_note: stringOrNull(r.meal_plan_note),
    currency: stringOrNull(r.currency),
    bank_accounts: coerceBankAccounts(r.bank_accounts),
    additional_person: coerceAdditionalPerson(r.additional_person),
    special_periods_note: stringOrNull(r.special_periods_note),
    product_categories: productCategories,
    seasons: reconciled.seasons,
    seasons_detail: reconciled.seasons_detail,
    sections: stringArray(r.sections),
    expected_row_estimate:
      numberOrNull(r.expected_row_estimate) ??
      rowPlan?.expected_rows ??
      null,
    notes: stringOrNull(r.notes),
    tipo_unidad:
      r.tipo_unidad === "N" || r.tipo_unidad === "S" ? r.tipo_unidad : null,
    occupancy_codes: stringArray(r.occupancy_codes).map((c) => c.toUpperCase()),
    occupancies_by_product: coerceOccupanciesByProduct(r.occupancies_by_product),
    max_adults_per_room: numberOrNull(r.max_adults_per_room),
    quadruple_allowed:
      r.quadruple_allowed === false
        ? false
        : r.quadruple_allowed === true
          ? true
          : null,
  };
  const logicSummary =
    stringOrNull(r.logic_summary) ?? buildLogicSummaryFallback(base);
  if (rowPlan && rowPlan.expected_rows == null && base.expected_row_estimate) {
    rowPlan = { ...rowPlan, expected_rows: base.expected_row_estimate };
  }
  if (rowPlan && rowPlan.seasons_count == null) {
    rowPlan = {
      ...rowPlan,
      seasons_count: reconciled.seasons_detail.length || reconciled.seasons.length || null,
    };
  }
  return enrichBriefOccupancies({
    ...base,
    logic_summary: logicSummary,
    row_plan: rowPlan,
  });
}

/**
 * Cap de output del brief. El brief es chico (reglas + inventario), pero los
 * arrays de bancos / persona adicional / inventario pueden sumar — 8k da
 * margen de sobra sin permitir que se desboque.
 */
const BRIEF_MAX_TOKENS = 8_000;

interface BriefResult {
  brief: ContractBrief;
  usage: TokenUsage;
}

/**
 * Fase 1: pasada de BRIEF. Llamada chica y focalizada que captura las reglas
 * globales + inventario del contrato. Comparte system + tools + documento con
 * la pasada principal (mismo prefijo) para reusar el cache del documento.
 *
 * Best-effort solo cuando se llama desde `extractContract` sin brief confirmado
 * (Fase 1 opcional). Desde `analyzeContractBrief` los errores se propagan.
 */
async function extractContractBrief(
  docs: PreparedDocumentInput[],
  requestId: string | undefined,
  context: ExtractionContext | undefined,
  refine?: BriefRefineContext,
): Promise<BriefResult> {
  const client = getAnthropicClient();
  const mode = refine ? "refine" : "brief";
  let response: Message;
  try {
    response = await runStreamWithRetry(
      () =>
        client.messages
          .stream({
            model: SUPPLIER_INTELLIGENCE_BRIEF_MODEL,
            max_tokens: BRIEF_MAX_TOKENS,
            system: BRIEF_ANALYSIS_SYSTEM_PROMPT,
            // Solo el tool del brief: sin caching cross-modelo no hay razón
            // para arrastrar el schema (grande) del tool de extracción acá.
            tools: [REGISTRAR_BRIEF_CONTRATO_TOOL],
            tool_choice: {
              type: "tool",
              name: REGISTRAR_BRIEF_CONTRATO_TOOL_NAME,
            },
            messages: [
              buildUserMessage(docs, { context, mode, refine }),
            ],
          })
          .finalMessage(),
      { requestId, label: refine ? "refine-brief" : "brief" },
    );
  } catch (err) {
    // Diagnóstico EXPLÍCITO: si el brief falla, el step de Variables de
    // Configuración no puede mostrar datos inventados — propagamos el error.
    logger.error("Contract brief pass FAILED", {
      requestId,
      model: SUPPLIER_INTELLIGENCE_BRIEF_MODEL,
      error: err instanceof Error ? err.message : String(err),
      status: err instanceof APIError ? err.status : undefined,
      stack: err instanceof Error ? err.stack : undefined,
    });
    if (err instanceof APIError) {
      throw mapAnthropicApiError(err);
    }
    throw ApiError.internal("Error al invocar al agente de análisis.");
  }

  const usage = usageFromMessage(response, SUPPLIER_INTELLIGENCE_BRIEF_MODEL);

  const toolUse = response.content.find(
    (block): block is ToolUseBlock =>
      block.type === "tool_use" &&
      block.name === REGISTRAR_BRIEF_CONTRATO_TOOL_NAME,
  );
  if (!toolUse) {
    logger.warn("Contract brief returned NO tool_use — config screen empty", {
      requestId,
      stopReason: response.stop_reason,
      contentTypes: response.content.map((b) => b.type),
    });
    // Aun sin brief usable, devolvemos el usage para no perder el costo.
    return { brief: coerceBrief({}), usage };
  }

  // Visibilidad del contenido real del brief para depurar "no trae datos":
  // qué claves llenó el modelo y cuántas temporadas/categorías detectó.
  const rawInput =
    toolUse.input && typeof toolUse.input === "object"
      ? (toolUse.input as Record<string, unknown>)
      : {};
  logger.info("Contract brief completed", {
    requestId,
    model: SUPPLIER_INTELLIGENCE_BRIEF_MODEL,
    stopReason: response.stop_reason,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    toolInputKeys: Object.keys(rawInput),
    seasonsRaw: Array.isArray(rawInput.seasons) ? rawInput.seasons.length : 0,
    seasonsDetailRaw: Array.isArray(rawInput.seasons_detail)
      ? rawInput.seasons_detail.length
      : 0,
    hasSharedFields:
      !!rawInput.shared_fields && typeof rawInput.shared_fields === "object",
  });

  return { brief: coerceBrief(toolUse.input), usage };
}

/**
 * Prefill de cuentas bancarias 2 y 3 derivado del brief (Fase 1). La
 * plantilla soporta 3 cuentas: la primaria vive en shared_fields
 * (numero_cuenta / banco / tipo_moneda) y la 2da/3ra son campos "manuales"
 * (cols AU-AZ). La extracción principal solía traer solo la primaria; el
 * brief captura TODAS, así que reconciliamos acá y mandamos las extra al
 * frontend para que pre-llene la tabla de Step 2.
 */
export interface ManualBankPrefill {
  cuenta_bancaria_2: string | null;
  banco_2: string | null;
  moneda_2: string | null;
  cuenta_bancaria_3: string | null;
  banco_3: string | null;
  moneda_3: string | null;
  /** cond_credito (col AP): "1"=CONTADO, "2"=CRÉDITO, "3"=PREPAGO. */
  cond_credito: string | null;
  /** plazo (col AQ): días de crédito o detalle del prepago. */
  plazo: string | null;
}

/**
 * Mapea los `payment_terms` extraídos a los campos manuales cond_credito /
 * plazo. cond_credito: "1"=CONTADO, "2"=CRÉDITO, "3"=PREPAGO.
 */
export function derivePaymentPrefill(
  extraction: ExtractedContract,
): { cond_credito: string | null; plazo: string | null } {
  const pt = extraction.payment_terms;
  if (!pt) return { cond_credito: null, plazo: null };

  const cond = (pt.condition ?? "").toUpperCase();
  let code: string | null = null;
  if (cond.includes("PREPAG") || cond.includes("PREPAID") || cond.includes("ADVANCE") || cond.includes("ANTICIP")) {
    code = "3";
  } else if (cond.includes("CRÉDIT") || cond.includes("CREDIT")) {
    code = "2";
  } else if (cond.includes("CONTADO") || cond.includes("CASH") || cond.includes("INMEDIAT") || cond.includes("IMMEDIAT")) {
    code = "1";
  }

  let plazo: string | null = null;
  if (pt.term_days !== null && Number.isFinite(pt.term_days)) {
    plazo = String(pt.term_days);
  } else {
    plazo = cleanStr(pt.term_note);
  }

  return { cond_credito: code, plazo };
}

const cleanStr = (s: string | null | undefined): string | null => {
  const t = (s ?? "").trim();
  return t === "" ? null : t;
};

const normalizeAccountNumber = (s: string | null | undefined): string =>
  (s ?? "").replace(/\s+/g, "").toLowerCase();

type BankAcct = { bank: string | null; num: string | null; cur: string | null };

/** Solo los 6 campos bancarios del prefill (cuentas 2 y 3). */
type BankPrefill = Pick<
  ManualBankPrefill,
  "cuenta_bancaria_2" | "banco_2" | "moneda_2" | "cuenta_bancaria_3" | "banco_3" | "moneda_3"
>;

/**
 * Reconcilia TODAS las cuentas bancarias del contrato. Fuentes (en orden de
 * confianza): la extracción principal (Opus, lee todo el documento) y, como
 * complemento, el brief (Fase 1). Devuelve:
 *   - `sharedPatch`: cuenta 1 → numero_cuenta / banco / tipo_moneda (MONEDA 1),
 *     siempre con la moneda normalizada a USD/LOC.
 *   - `bankPrefill`: cuentas 2 y 3 (cols AU-AZ) para pre-llenar Step 2.
 *
 * La plantilla soporta MÁXIMO 3 cuentas: si el contrato lista más, se toman
 * solo las 3 PRIMERAS en orden del documento (las extra se ignoran).
 */
export function reconcileBankAccounts(
  extraction: ExtractedContract,
  brief: ContractBrief | null,
): { sharedPatch: Partial<ExtractedContract["shared_fields"]>; bankPrefill: BankPrefill | null } {
  const sf = extraction.shared_fields;

  const toAcct = (a: { bank: string | null; account_number: string | null; currency: string | null }): BankAcct => ({
    bank: cleanStr(a.bank),
    num: cleanStr(a.account_number),
    cur: cleanStr(a.currency),
  });

  // Orden canónico: primero las de la extracción principal (orden del
  // documento), luego las del brief que no estén ya presentes.
  const candidates: BankAcct[] = [
    ...(extraction.bank_accounts ?? []).map(toAcct),
    ...(brief?.bank_accounts ?? []).map(toAcct),
  ].filter((a) => a.num !== null || a.bank !== null);

  // Dedupe por número de cuenta normalizado (o banco si no hay número),
  // conservando el primer avistamiento (orden del documento).
  const seen = new Set<string>();
  let ordered: BankAcct[] = [];
  for (const a of candidates) {
    const key = a.num ? `n:${normalizeAccountNumber(a.num)}` : `b:${(a.bank ?? "").toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    ordered.push(a);
  }

  const sharedPatch: Partial<ExtractedContract["shared_fields"]> = {};
  const primaryNum = cleanStr(sf.numero_cuenta);

  if (ordered.length === 0) {
    // No detectamos cuentas estructuradas — al menos normalizamos la moneda
    // de la cuenta 1 que ya traía la extracción principal.
    const normCur = normalizeCurrency(sf.tipo_moneda);
    if (normCur && normCur !== sf.tipo_moneda) sharedPatch.tipo_moneda = normCur;
    return { sharedPatch, bankPrefill: null };
  }

  // Anclamos la cuenta 1 a la que ya eligió la extracción principal (si
  // coincide con alguna detectada); si no, a la primera del orden del doc.
  if (primaryNum) {
    const idx = ordered.findIndex(
      (a) => normalizeAccountNumber(a.num) === normalizeAccountNumber(primaryNum),
    );
    if (idx > 0) {
      ordered = [ordered[idx]!, ...ordered.filter((_, i) => i !== idx)];
    } else if (idx < 0) {
      // La primaria no apareció en la lista estructurada → la anteponemos
      // sintetizándola desde shared_fields para no perderla.
      ordered = [{ bank: cleanStr(sf.banco), num: primaryNum, cur: cleanStr(sf.tipo_moneda) }, ...ordered];
    }
  }

  // Solo las 3 primeras caben en la plantilla.
  const top3 = ordered.slice(0, 3);
  const a1 = top3[0]!;
  const a2 = top3[1];
  const a3 = top3[2];

  // Cuenta 1 → shared. MONEDA 1 (tipo_moneda) normalizada a USD/LOC.
  sharedPatch.numero_cuenta = a1.num;
  if (a1.bank) sharedPatch.banco = a1.bank;
  const moneda1 = normalizeCurrency(a1.cur) ?? normalizeCurrency(sf.tipo_moneda);
  if (moneda1) sharedPatch.tipo_moneda = moneda1;

  if (!a2 && !a3) return { sharedPatch, bankPrefill: null };

  const bankPrefill: BankPrefill = {
    cuenta_bancaria_2: a2?.num ?? null,
    banco_2: a2?.bank ?? null,
    moneda_2: normalizeCurrency(a2?.cur),
    cuenta_bancaria_3: a3?.num ?? null,
    banco_3: a3?.bank ?? null,
    moneda_3: normalizeCurrency(a3?.cur),
  };

  return { sharedPatch, bankPrefill };
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
  /**
   * Brief del contrato (Fase 1) si la pasada de pre-análisis corrió bien.
   * `null` cuando no se pudo extraer (falla upstream) — la extracción sigue
   * siendo válida, solo sin el contexto de reglas globales.
   */
  brief: ContractBrief | null;
  /**
   * Cuentas bancarias 2 y 3 detectadas por el brief (la primaria ya va en
   * `data.shared_fields`). El frontend las usa para pre-llenar los campos
   * manuales de Step 2. `null` si el contrato tiene una sola cuenta.
   */
  manualPrefill: ManualBankPrefill | null;
}

/**
 * Run the extraction against Anthropic with `tool_choice` forced to the
 * extraction tool. Accepts one or more prepared documents; Claude treats the
 * bundle as a single logical contract (see `buildUserMessage`). Maps SDK
 * errors to `ApiError` with spec-aligned status codes (502 for upstream
 * failures, 422 for a missing tool_use block).
 *
 * Flujo multi-pasada (Fase 1):
 *   1. BRIEF — pasada chica que captura reglas globales + inventario. Escribe
 *      el cache del documento. Best-effort (no bloquea si falla).
 *   2. EXTRACCIÓN — pasada principal que genera todas las filas, inyectando el
 *      brief como contexto de prioridad alta y leyendo el cache del documento.
 */
/**
 * Resultado público de la pasada de BRIEF (Fase 1) — lo que devuelve el
 * endpoint `POST /analyze-brief`. El frontend lo muestra como "Variables de
 * configuración" para que el usuario lo confirme/corrija ANTES de la
 * extracción principal. La versión editada vuelve en `POST /extract` y se usa
 * como `briefOverride` (ver `extractContract`), saltándose la Fase 1.
 */
export interface BriefAnalysisResult {
  brief: ContractBrief;
  model: string;
  usage: { inputTokens: number; outputTokens: number; costUsd: number };
}

/**
 * Fase 1 standalone — corre SOLO el brief y lo devuelve para revisión humana.
 * A diferencia de `extractContractBrief` (interno, best-effort que puede
 * devolver null), acá garantizamos un brief coercido aunque el modelo no
 * emita tool_use (devolvemos uno vacío), porque el usuario igual necesita la
 * pantalla de configuración para llenarlo a mano.
 */
export async function analyzeContractBrief(
  docs: PreparedDocumentInput[],
  requestId?: string,
  context?: ExtractionContext,
): Promise<BriefAnalysisResult> {
  if (docs.length === 0) {
    throw ApiError.badRequest("Se requiere al menos un documento para analizar.");
  }
  const result = await extractContractBrief(docs, requestId, context);
  const usage = result.usage;
  return {
    brief: result.brief,
    model: SUPPLIER_INTELLIGENCE_BRIEF_MODEL,
    usage: {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      costUsd: usage.costUsd,
    },
  };
}

/**
 * Re-analiza el brief tras feedback del usuario (chat de correcciones).
 */
export async function refineContractBrief(
  docs: PreparedDocumentInput[],
  previousBrief: ContractBrief,
  feedback: string,
  requestId?: string,
  context?: ExtractionContext,
  chatHistory?: BriefChatMessage[],
): Promise<BriefAnalysisResult> {
  if (docs.length === 0) {
    throw ApiError.badRequest("Se requiere al menos un documento para refinar.");
  }
  const trimmed = feedback.trim();
  if (!trimmed) {
    throw ApiError.badRequest("El mensaje de corrección no puede estar vacío.");
  }
  const result = await extractContractBrief(docs, requestId, context, {
    previousBrief,
    feedback: trimmed,
    chatHistory,
  });
  const usage = result?.usage ?? {
    inputTokens: 0,
    outputTokens: 0,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    costUsd: 0,
  };
  return {
    brief: result?.brief ?? coerceBrief({}),
    model: SUPPLIER_INTELLIGENCE_BRIEF_MODEL,
    usage: {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      costUsd: usage.costUsd,
    },
  };
}

/** Primer string no vacío de la lista (útil al fusionar briefs). */
function firstNonEmpty(...vals: Array<string | null | undefined>): string | null {
  for (const v of vals) {
    if (typeof v === "string" && v.trim() !== "") return v;
  }
  return null;
}

/**
 * Une occupancy_codes / tipo_unidad / occupancies_by_product / bancos /
 * políticas especiales de TODOS los briefs (p.ej. rates + T&C Lapa Rios).
 */
function mergeBriefsForValidation(
  primary: ContractBrief,
  all: ContractBrief[] | null,
): ContractBrief {
  if (!all || all.length <= 1) return enrichBriefOccupancies(primary);
  const occupancy_codes = [
    ...new Set(
      all.flatMap((b) => (b.occupancy_codes ?? []).map((c) => c.toUpperCase())),
    ),
  ];
  const packageBrief = all.find((b) => b.tipo_unidad === "S");
  const specMap = new Map<string, { product: string; codes: Set<string> }>();
  for (const b of all) {
    for (const spec of enrichBriefOccupancies(b).occupancies_by_product) {
      const key = spec.product.toLowerCase();
      const existing = specMap.get(key);
      if (!existing) {
        specMap.set(key, {
          product: spec.product,
          codes: new Set(spec.occupancy_codes),
        });
      } else {
        for (const c of spec.occupancy_codes) existing.codes.add(c);
      }
    }
  }

  // Bancos: unión preservando orden (primario primero, luego secundarios).
  const bankSeen = new Set<string>();
  const bank_accounts: ContractBrief["bank_accounts"] = [];
  for (const b of all) {
    for (const acct of b.bank_accounts ?? []) {
      const key = `${(acct.account_number ?? "").replace(/\s+/g, "").toLowerCase()}|${(acct.bank ?? "").toLowerCase()}`;
      if (!key.replace("|", "") || bankSeen.has(key)) continue;
      bankSeen.add(key);
      bank_accounts.push(acct);
    }
  }

  const secondary = all.slice(1);
  const quadrupleFromAny = all.some((b) => b.quadruple_allowed === true);
  const quadrupleForbiddenEverywhere = all.every(
    (b) => b.quadruple_allowed === false,
  );

  return enrichBriefOccupancies({
    ...primary,
    occupancy_codes:
      occupancy_codes.length > 0 ? occupancy_codes : primary.occupancy_codes,
    tipo_unidad: packageBrief?.tipo_unidad ?? primary.tipo_unidad,
    occupancies_by_product: [...specMap.values()].map(({ product, codes }) => ({
      product,
      occupancy_codes: [...codes],
    })),
    bank_accounts:
      bank_accounts.length > 0 ? bank_accounts : primary.bank_accounts,
    special_periods_note: firstNonEmpty(
      primary.special_periods_note,
      ...secondary.map((b) => b.special_periods_note),
    ),
    notes: firstNonEmpty(primary.notes, ...secondary.map((b) => b.notes)),
    commission_summary: firstNonEmpty(
      primary.commission_summary,
      ...secondary.map((b) => b.commission_summary),
    ),
    meal_plan_note: firstNonEmpty(
      primary.meal_plan_note,
      ...secondary.map((b) => b.meal_plan_note),
    ),
    additional_person:
      primary.additional_person.length > 0
        ? primary.additional_person
        : (secondary.find((b) => b.additional_person.length > 0)
            ?.additional_person ?? primary.additional_person),
    // Si algún brief tiene QDP explícito, no dejar que "false" del rate sheet lo anule.
    quadruple_allowed: quadrupleForbiddenEverywhere
      ? false
      : quadrupleFromAny
        ? true
        : primary.quadruple_allowed,
  });
}

/* -------------------------------------------------------------------------- */
/*        Fase 2 — pasadas de extracción, fragmentación y truncamiento        */
/* -------------------------------------------------------------------------- */

/**
 * Umbral de filas estimadas a partir del cual la extracción se FRAGMENTA en
 * varias pasadas por temporada, y meta de filas por pasada. Con el formato
 * compacto (row_defaults + omisión de *_fds) una fila cuesta ~150-250 tokens
 * de salida, así que ~160 filas por pasada deja margen holgado contra el cap
 * de 128k. Solo se fragmenta en el flujo gated (brief confirmado por el
 * usuario): ahí las temporadas y el estimado de filas son confiables.
 */
const SHARD_ROW_THRESHOLD = 160;
const SHARD_TARGET_ROWS = 100;

/** Nombres únicos de temporada del brief (detail primero, luego lista plana). */
function uniqueSeasonNames(brief: ContractBrief): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  const push = (n: string | null) => {
    const t = (n ?? "").trim();
    const k = t.toLowerCase();
    if (t === "" || seen.has(k)) return;
    seen.add(k);
    names.push(t);
  };
  brief.seasons_detail.forEach((s) => push(s.name));
  brief.seasons.forEach(push);
  return names;
}

/**
 * Plan de fragmentación por temporadas para contratos densos. Devuelve []
 * cuando NO hace falta fragmentar (el caso normal): una sola pasada sigue
 * siendo lo más barato y lo más coherente. Se fragmenta solo cuando el
 * estimado de filas confirmado por el usuario proyecta una salida que se
 * acerca al cap del modelo.
 */
function planSeasonShards(brief: ContractBrief | null): ExtractionShard[] {
  if (!brief) return [];
  const names = uniqueSeasonNames(brief);
  if (names.length < 2) return [];
  const expected =
    brief.row_plan?.expected_rows ?? brief.expected_row_estimate ?? null;
  if (expected == null || expected <= SHARD_ROW_THRESHOLD) return [];
  const perSeason = expected / names.length;
  const seasonsPerShard = Math.max(
    1,
    Math.floor(SHARD_TARGET_ROWS / Math.max(perSeason, 1)),
  );
  const groups: string[][] = [];
  for (let i = 0; i < names.length; i += seasonsPerShard) {
    groups.push(names.slice(i, i + seasonsPerShard));
  }
  if (groups.length < 2) return [];
  return groups.map((seasonNames, index) => ({
    index,
    total: groups.length,
    seasonNames,
  }));
}

/**
 * Rescate de una respuesta truncada por max_tokens. La SDK acumula el JSON
 * del tool_use con un parser de JSON PARCIAL (`partialParse`), así que aunque
 * la respuesta se corte a mitad de una fila, `toolUse.input` llega como
 * objeto con todas las filas completas + posiblemente una última a medias.
 * Descartamos esa última fila (no sabemos qué campos le faltan) y seguimos
 * con el resto en lugar de tirar TODA la extracción (que ya se pagó).
 */
function salvageTruncatedInput(input: unknown): unknown | null {
  if (!input || typeof input !== "object") return null;
  const r = input as Record<string, unknown>;
  const rows = Array.isArray(r.rows) ? r.rows : [];
  if (rows.length <= 1) return null;
  return { ...r, rows: rows.slice(0, -1) };
}

const TRUNCATION_USER_ERROR = new ApiError(
  502,
  "El contrato es excepcionalmente denso y la extracción llegó al " +
    "límite máximo del modelo (128k tokens de salida) sin filas " +
    "recuperables. Ajustá el estimado de filas en Variables de " +
    "Configuración (activa la extracción por temporadas) o dividí el " +
    "documento.",
);

interface ExtractionPassResult {
  raw: ExtractedContract;
  usage: TokenUsage;
  /** Advertencias de esta pasada (hoy: truncamiento rescatado). */
  warnings: string[];
}

/**
 * Una pasada de extracción (Fase 2) contra Opus: llamada streaming con
 * tool_choice forzado, manejo de errores de API, truncamiento con rescate y
 * coerción del tool_use. Se usa tanto para la pasada única (caso normal)
 * como para cada pasada parcial del plan de fragmentación por temporadas.
 */
async function runExtractionPass(args: {
  client: ReturnType<typeof getAnthropicClient>;
  docs: PreparedDocumentInput[];
  requestId: string | undefined;
  context: ExtractionContext | undefined;
  brief: ContractBrief | null;
  confirmedBriefs: ContractBrief[] | null;
  briefConfirmed: boolean;
  shard?: ExtractionShard;
}): Promise<ExtractionPassResult> {
  const { client, docs, requestId, context, brief, confirmedBriefs, shard } =
    args;
  const label = shard
    ? `extract-${shard.index + 1}/${shard.total}`
    : "extract";

  let response: Message;
  try {
    response = await runStreamWithRetry(
      () =>
        client.messages
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
            messages: [
              buildUserMessage(docs, {
                context,
                mode: "extract",
                brief,
                briefs: confirmedBriefs,
                briefConfirmed: args.briefConfirmed,
                shard,
              }),
            ],
          })
          .finalMessage(),
      { requestId, label },
    );
  } catch (err) {
    // Map all Anthropic-side failures (timeouts, 429, 5xx, auth) to 502.
    // We never surface the upstream status code directly because the client
    // only cares that "the extractor is down".
    if (err instanceof APIError) {
      logger.error("Anthropic API error during extraction", {
        requestId,
        label,
        status: err.status,
        message: err.message,
      });
      throw mapAnthropicApiError(err);
    }
    logger.error("Unexpected error calling Anthropic", {
      requestId,
      label,
      error: err instanceof Error ? err.message : String(err),
    });
    throw new ApiError(502, "Error al invocar al agente de extracción.");
  }

  // Visibilidad: stop_reason + uso de tokens en TODA extracción. output_tokens
  // nos da una señal directa de cuán cerca del cap está cada contrato —
  // útil para detectar la tendencia antes de pegar en MAX_TOKENS.
  logger.info("Anthropic extraction completed", {
    requestId,
    label,
    stopReason: response.stop_reason,
    outputTokens: response.usage?.output_tokens,
    inputTokens: response.usage?.input_tokens,
    cacheReadTokens: response.usage?.cache_read_input_tokens,
    cacheWriteTokens: response.usage?.cache_creation_input_tokens,
  });

  const usage = usageFromMessage(response, SUPPLIER_INTELLIGENCE_MODEL);
  const truncated = response.stop_reason === "max_tokens";
  const warnings: string[] = [];

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
      label,
      stopReason: response.stop_reason,
      contentTypes: response.content.map((b) => b.type),
    });
    if (truncated) throw TRUNCATION_USER_ERROR;
    throw new ApiError(
      502,
      "El agente no devolvió datos estructurados. Intenta de nuevo.",
    );
  }

  // Truncamiento por max_tokens: en lugar de descartar TODA la respuesta
  // (que ya se pagó y suele traer cientos de filas completas), rescatamos
  // las filas íntegras y lo reportamos como advertencia bien visible. El
  // check determinístico de completitud (validateAgainstBrief) marcará
  // además las temporadas/estimado que quedaron cortos.
  let inputToCoerce: unknown = toolUse.input;
  if (truncated) {
    logger.warn("Extraction hit max_tokens — salvaging truncated output", {
      requestId,
      label,
      maxTokens: MAX_TOKENS,
      outputTokens: response.usage?.output_tokens,
    });
    inputToCoerce = salvageTruncatedInput(toolUse.input);
    if (inputToCoerce == null) throw TRUNCATION_USER_ERROR;
  }

  let raw: ExtractedContract;
  try {
    raw = coerceExtraction(inputToCoerce, { allowEmptyRows: !!shard });
  } catch (err) {
    logger.error("Failed to coerce Claude tool_use input", {
      requestId,
      label,
      error: err instanceof Error ? err.message : String(err),
      stopReason: response.stop_reason,
      outputTokens: response.usage?.output_tokens,
      input: toolUse.input,
    });
    if (truncated) throw TRUNCATION_USER_ERROR;
    throw new ApiError(
      502,
      "El agente devolvió una respuesta con formato inesperado.",
    );
  }

  if (truncated) {
    warnings.push(
      `⚠️ EXTRACCIÓN INCOMPLETA${shard ? ` (pasada ${shard.index + 1}/${shard.total})` : ""}: ` +
        "la respuesta alcanzó el límite de 128k tokens de salida y fue " +
        `truncada. Se recuperaron ${raw.rows.length} filas completas — ` +
        "verificá la cobertura de temporadas/categorías contra el plan de " +
        "filas y completá lo faltante a mano o reintentá la extracción.",
    );
  }

  return { raw, usage, warnings };
}

/** Orden de severidad para consolidar `confianza` entre pasadas parciales. */
const CONFIANZA_RANK: Record<Confianza, number> = {
  baja: 0,
  media: 1,
  alta: 2,
};

/**
 * Consolida las pasadas parciales de una extracción fragmentada en un único
 * `ExtractedContract`. shared_fields/paginas_origen_shared salen de la
 * primera pasada (todas leen el mismo documento); filas y páginas de origen
 * se concatenan deduplicando idénticas (una pasada puede repetir filas sin
 * temporada pese a la instrucción); bancos y campos_faltantes se unen;
 * confianza queda en la peor de las pasadas.
 */
function mergeExtractions(parts: ExtractedContract[]): ExtractedContract {
  const first = parts[0]!;
  if (parts.length === 1) return first;

  const norm = (s: string | null): string => (s ?? "").trim().toLowerCase();
  const rowKey = (r: ContractRow): string =>
    [
      r.product_name,
      r.tipo_servicio,
      r.ocupacion,
      r.season_name,
      r.season_starts,
      r.meals_included,
      r.precios_neto_iva,
      r.precio_rack_iva,
    ]
      .map(norm)
      .join("|");

  const rows: ContractRow[] = [];
  const paginas_origen_rows: Record<string, SourcePage>[] = [];
  const rowSeen = new Set<string>();
  for (const part of parts) {
    part.rows.forEach((row, i) => {
      const key = rowKey(row);
      if (rowSeen.has(key)) return;
      rowSeen.add(key);
      rows.push(row);
      paginas_origen_rows.push(part.paginas_origen_rows[i] ?? {});
    });
  }

  const bankSeen = new Set<string>();
  const bank_accounts: ExtractedContract["bank_accounts"] = [];
  for (const part of parts) {
    for (const acct of part.bank_accounts ?? []) {
      const key = `${normalizeAccountNumber(acct.account_number)}|${norm(acct.bank)}`;
      if (key === "|" || bankSeen.has(key)) continue;
      bankSeen.add(key);
      bank_accounts.push(acct);
    }
  }

  const campos_faltantes = [
    ...new Set(parts.flatMap((p) => p.campos_faltantes)),
  ];
  const confianza = parts.reduce<Confianza>(
    (worst, p) =>
      CONFIANZA_RANK[p.confianza] < CONFIANZA_RANK[worst]
        ? p.confianza
        : worst,
    first.confianza,
  );
  const payment_terms =
    parts.map((p) => p.payment_terms).find((pt) => pt !== null) ?? null;

  return {
    ...first,
    rows,
    paginas_origen_rows,
    bank_accounts,
    campos_faltantes,
    confianza,
    payment_terms,
  };
}

export async function extractContract(
  docs: PreparedDocumentInput[],
  requestId?: string,
  context?: ExtractionContext,
  /**
   * Brief(s) ya confirmado(s)/editado(s) por el usuario en el step de Variables
   * de Configuración — uno por documento. Cuando vienen, SALTAMOS la Fase 1 (no
   * re-analizamos los documentos) y usamos estos briefs como las reglas
   * globales de la pasada principal. Esa es la mejora clave del flujo gated: el
   * usuario corrige el "prices_include_tax", la comisión o las fechas de
   * temporada ANTES de que esas reglas se propaguen a las decenas de filas.
   */
  briefOverrides?: ContractBrief[] | null,
): Promise<ExtractionResult> {
  if (docs.length === 0) {
    // Defensive — the controller already rejects empty arrays with 400.
    throw ApiError.badRequest("Se requiere al menos un documento para extraer.");
  }

  const client = getAnthropicClient();

  // Brief PRIMARIO: cuando hay varios briefs (multi-documento), usamos el
  // primero como fuente de prefill/identidad/validación; los demás se pasan al
  // modelo para que consolide las filas. Cuando hay uno solo, es ese.
  const confirmedBriefs =
    briefOverrides && briefOverrides.length > 0 ? briefOverrides : null;
  const briefOverride = confirmedBriefs?.[0] ?? null;

  // ── Fase 1: BRIEF ────────────────────────────────────────────────────────
  // Si el usuario ya confirmó el brief (flujo gated), lo usamos directo y nos
  // ahorramos una pasada al modelo. Si no (compat con el flujo de una sola
  // llamada), corremos el pre-análisis focalizado como antes.
  let briefResult: BriefResult | null = null;
  let brief: ContractBrief | null;
  if (briefOverride) {
    brief = briefOverride;
    logger.info("Using user-confirmed brief(s) — skipping Fase 1", {
      requestId,
      briefCount: confirmedBriefs?.length ?? 1,
      pricesIncludeTax: brief.prices_include_tax,
      commissionDefaultPct: brief.commission_default_pct,
      seasons: brief.seasons_detail.length,
    });
  } else {
    try {
      briefResult = await extractContractBrief(docs, requestId, context);
      brief = briefResult.brief;
    } catch (err) {
      // Best-effort en extracción sin brief confirmado: si Fase 1 falla,
      // seguimos sin inyección de brief en lugar de abortar toda la extracción.
      logger.warn("Contract brief pass failed during extract — continuing without brief", {
        requestId,
        error: err instanceof Error ? err.message : String(err),
      });
      brief = null;
    }
  }

  // ── Fase 2: EXTRACCIÓN PRINCIPAL ─────────────────────────────────────────
  // Streaming (ver runExtractionPass) porque con MAX_TOKENS alto la
  // generación puede tardar minutos. Para contratos densos con brief
  // confirmado, la extracción se FRAGMENTA por temporadas en varias pasadas
  // (planSeasonShards): la primera escribe el prompt cache del documento y
  // las demás corren en PARALELO leyéndolo al 10% del costo de input; el
  // merge es determinístico (mergeExtractions). El caso normal sigue siendo
  // UNA pasada.
  const passArgsBase = {
    client,
    docs,
    requestId,
    context,
    brief,
    confirmedBriefs,
    briefConfirmed: !!briefOverride,
  };
  // Solo fragmentamos en el flujo gated con UN brief confirmado: con varios
  // briefs (multi-documento) el modelo además consolida entre documentos y
  // partir esa tarea por temporada agregaría ambigüedad.
  const shards =
    briefOverride && (confirmedBriefs?.length ?? 0) === 1
      ? planSeasonShards(brief)
      : [];

  let raw: ExtractedContract;
  const passUsages: TokenUsage[] = [];
  const extractionWarnings: string[] = [];

  if (shards.length > 1) {
    logger.info("Dense contract — sharding extraction by season", {
      requestId,
      shardCount: shards.length,
      expectedRows:
        brief?.row_plan?.expected_rows ?? brief?.expected_row_estimate ?? null,
      shardSeasons: shards.map((s) => s.seasonNames),
    });
    // Pasada 1 sola (escribe el cache del documento), resto en paralelo.
    const firstPass = await runExtractionPass({
      ...passArgsBase,
      shard: shards[0],
    });
    const restPasses = await Promise.all(
      shards.slice(1).map((shard) =>
        runExtractionPass({ ...passArgsBase, shard }),
      ),
    );
    const allPasses = [firstPass, ...restPasses];
    for (const pass of allPasses) {
      passUsages.push(pass.usage);
      extractionWarnings.push(...pass.warnings);
    }
    raw = mergeExtractions(allPasses.map((p) => p.raw));
    if (raw.rows.length === 0) {
      throw new ApiError(
        502,
        "La extracción fragmentada no devolvió filas. Intenta de nuevo.",
      );
    }
  } else {
    const single = await runExtractionPass(passArgsBase);
    passUsages.push(single.usage);
    extractionWarnings.push(...single.warnings);
    raw = single.raw;
  }

  const mergedBrief = brief
    ? enrichBriefOccupancies(mergeBriefsForValidation(brief, confirmedBriefs))
    : null;

  const { extraction, validation } = validateExtraction(raw, mergedBrief);

  // Advertencias de las pasadas (truncamiento rescatado) — van PRIMERO para
  // que el revisor las vea antes que los checks de detalle.
  if (extractionWarnings.length > 0) {
    validation.warnings.unshift(...extractionWarnings);
  }

  // Reconciliación de cuentas bancarias + términos de pago: usamos el brief
  // FUSIONADO (rates + T&C) para que bancos/políticas del documento secundario
  // no se pierdan (caso Lapa Rios).
  const { sharedPatch, bankPrefill } = reconcileBankAccounts(
    extraction,
    mergedBrief,
  );
  let data =
    Object.keys(sharedPatch).length > 0
      ? { ...extraction, shared_fields: { ...extraction.shared_fields, ...sharedPatch } }
      : extraction;

  // Identidad CONFIRMADA por el usuario en el step de Variables de
  // Configuración → es autoritativa. Solo cuando vino un briefOverride (flujo
  // gated): sobreescribimos los campos de identidad que el usuario confirmó
  // (no-null) sobre lo que infirió la extracción principal. Así "razón social",
  // cédula, vigencia, etc. salen exactamente como el humano los dejó.
  if (briefOverride?.shared_fields) {
    const sf = briefOverride.shared_fields;
    const identityPatch: Partial<ExtractedContract["shared_fields"]> = {};
    const assign = (
      key: keyof ContractBriefSharedFields &
        keyof ExtractedContract["shared_fields"],
    ) => {
      const v = sf[key];
      if (typeof v === "string" && v.trim() !== "") identityPatch[key] = v;
    };
    (
      [
        "proveedor",
        "nombre_comercial",
        "cedula",
        "type_of_business",
        "direccion",
        "telefono",
        "pais",
        "state_province",
        "reservations_email",
        "fecha",
        "contract_starts",
        "contract_ends",
      ] as const
    ).forEach(assign);
    if (Object.keys(identityPatch).length > 0) {
      data = {
        ...data,
        shared_fields: { ...data.shared_fields, ...identityPatch },
      };
    }
  }

  const payment = derivePaymentPrefill(extraction);
  const manualPrefillCandidate: ManualBankPrefill = {
    cuenta_bancaria_2: bankPrefill?.cuenta_bancaria_2 ?? null,
    banco_2: bankPrefill?.banco_2 ?? null,
    moneda_2: bankPrefill?.moneda_2 ?? null,
    cuenta_bancaria_3: bankPrefill?.cuenta_bancaria_3 ?? null,
    banco_3: bankPrefill?.banco_3 ?? null,
    moneda_3: bankPrefill?.moneda_3 ?? null,
    cond_credito: payment.cond_credito,
    plazo: payment.plazo,
  };
  const manualPrefill: ManualBankPrefill | null = Object.values(
    manualPrefillCandidate,
  ).some((v) => v !== null)
    ? manualPrefillCandidate
    : null;

  // Usage = brief (Fase 1, Sonnet) + pasada(s) de extracción (Fase 2, Opus).
  // Cada pasada se cobra con la tarifa de su modelo (incluyendo los buckets
  // de cache write/read de la fragmentación); `sumUsage` agrega los totales.
  const usage = sumUsage(
    briefResult ? [briefResult.usage, ...passUsages] : passUsages,
  );

  return {
    data,
    validation,
    model: SUPPLIER_INTELLIGENCE_MODEL,
    usage: {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      costUsd: usage.costUsd,
    },
    brief,
    manualPrefill,
  };
}
