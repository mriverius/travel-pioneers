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
  CONTRACT_BRIEF_INSTRUCTION,
  EXTRAER_DATOS_CONTRATO_TOOL,
  EXTRAER_DATOS_CONTRATO_TOOL_NAME,
  REGISTRAR_BRIEF_CONTRATO_TOOL,
  REGISTRAR_BRIEF_CONTRATO_TOOL_NAME,
  renderContractBriefBlock,
  SUPPLIER_INTELLIGENCE_SYSTEM_PROMPT,
} from "./prompts/index.js";
import { validateExtraction } from "./validators.js";
import type {
  Confianza,
  ContractBrief,
  ContractBriefAdditionalPerson,
  ContractBriefBankAccount,
  ContractRow,
  ExtractedContract,
  PreparedDocument,
  SharedFields,
  SourcePage,
  TipoUnidad,
  ValidationResult,
} from "./types.js";

/**
 * Opus 4.7 es el modelo de extracción. Es más caro y más lento que Sonnet,
 * pero la tarea ahora requiere generar potencialmente decenas de filas con
 * razonamiento sobre múltiples temporadas/categorías — Opus paga el precio
 * en calidad de extracción.
 *
 * Notas de migración 4.6 → 4.7 (Anthropic, abr 2026):
 *   - Drop-in: mismo SDK, mismo tool-use, mismo schema, mismo pricing.
 *   - Context window: 500k → 1M tokens — perfecto para PDFs de 60+ páginas
 *     que antes nos tenían ajustados en input.
 *   - Tokenizer nuevo: el mismo input puede mapear a ~1.0-1.35x más tokens
 *     que con 4.6 (cost-aware, pero mucho menos que el riesgo de cortar
 *     contratos densos por context overflow).
 *   - SWE-bench Verified 84.1 → 87.6, 2x throughput agentic.
 */
export const SUPPLIER_INTELLIGENCE_MODEL = "claude-opus-4-7";

/**
 * Modelo de la pasada de BRIEF (Fase 1). Usamos Sonnet 4.6 (no Opus) a
 * propósito: el brief es una tarea acotada (reglas globales + inventario, sin
 * filas) que Sonnet resuelve con fidelidad de sobra, y es ~2x más rápido y
 * ~40% más barato que Opus. Eso recorta la latencia agregada del flujo
 * multi-pasada (que estaba haciendo timeout el front) sin sacrificar la
 * calidad de la extracción principal, que sigue en Opus.
 *
 * Trade-off consciente: al usar un modelo distinto en cada pasada, el cache de
 * prompt del documento NO se comparte entre ellas (el cache es por-modelo), así
 * que retiramos el cache_control — el ahorro de costo del cache no aplica acá y
 * la prioridad es latencia. ID verificado: NO existe `claude-sonnet-4-7`.
 */
export const SUPPLIER_INTELLIGENCE_BRIEF_MODEL = "claude-sonnet-4-6";

/**
 * Pricing oficial de Claude Opus 4.7 (USD por millón de tokens).
 *
 * Fuente: https://www.anthropic.com/news/claude-opus-4-7 (abr 2026).
 * Sin cambio respecto a 4.6 — same $5 / $25 por millón. Si Anthropic
 * cambia precios este es el único lugar donde editar — el cómputo de
 * `cost_usd` por extracción se hace abajo en `extractContract`.
 *
 * Pricing por modelo (USD por millón de tokens). El flujo usa DOS modelos
 * (Sonnet 4.6 para el brief, Opus 4.7 para la extracción), así que el costo se
 * calcula por-pasada con la tarifa del modelo correspondiente. Incluye los
 * buckets de cache por si Anthropic los reporta, aunque hoy no activamos
 * caching (ver `SUPPLIER_INTELLIGENCE_BRIEF_MODEL`).
 *
 * Fuente: platform.claude.com/docs/about-claude/pricing (jun 2026).
 */
interface ModelPrices {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

const MODEL_PRICES: Record<string, ModelPrices> = {
  "claude-opus-4-7": { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  "claude-sonnet-4-6": { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
};

// Fallback a Opus (el más caro) si llegara un modelo desconocido — preferimos
// sobre-estimar el costo que sub-reportarlo.
const FALLBACK_PRICES: ModelPrices = MODEL_PRICES["claude-opus-4-7"]!;

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
 *   - 128k: máximo soportado por Opus 4.7. Damos todo el headroom posible
 *           porque NO cobramos por el cap — solo por los tokens que
 *           efectivamente se emiten — así que el único costo es latencia
 *           si el modelo se acerca al cap. En la práctica un contrato
 *           normal se queda muy por debajo.
 *
 * El context window de Opus 4.7 es 1M, así que el cuello de botella
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
   * "extract" → Fase 2: pide todas las filas, inyectando el brief ya extraído.
   */
  mode: "brief" | "extract";
  /** Brief ya extraído — solo se usa (y se requiere) en mode "extract". */
  brief?: ContractBrief | null;
}

function buildUserMessage(
  docs: PreparedDocumentInput[],
  opts: BuildUserMessageOpts,
): MessageParam {
  const { context: ctx, mode, brief } = opts;
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

  if (mode === "brief") {
    content.push({ type: "text", text: CONTRACT_BRIEF_INSTRUCTION });
    return { role: "user", content };
  }

  // mode === "extract": inyectamos el brief (si lo tenemos) como contexto de
  // prioridad alta ANTES de la instrucción final.
  if (brief) {
    content.push({ type: "text", text: renderContractBriefBlock(brief) });
  }

  const closing =
    docs.length === 1
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

function coerceBrief(input: unknown): ContractBrief {
  const r =
    input && typeof input === "object"
      ? (input as Record<string, unknown>)
      : {};
  return {
    prices_include_tax: boolOrNull(r.prices_include_tax),
    tax_rate_pct: numberOrNull(r.tax_rate_pct),
    tax_note: stringOrNull(r.tax_note),
    commission_summary: stringOrNull(r.commission_summary),
    meal_plan_note: stringOrNull(r.meal_plan_note),
    bank_accounts: coerceBankAccounts(r.bank_accounts),
    additional_person: coerceAdditionalPerson(r.additional_person),
    special_periods_note: stringOrNull(r.special_periods_note),
    product_categories: stringArray(r.product_categories),
    seasons: stringArray(r.seasons),
    sections: stringArray(r.sections),
    expected_row_estimate: numberOrNull(r.expected_row_estimate),
    notes: stringOrNull(r.notes),
  };
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
 * Best-effort: si Anthropic falla o devuelve algo raro, NO abortamos la
 * extracción — devolvemos `null` y la pasada principal corre como antes (sin
 * inyección de brief). El brief mejora la fidelidad; no es un bloqueante.
 */
async function extractContractBrief(
  docs: PreparedDocumentInput[],
  requestId: string | undefined,
  context: ExtractionContext | undefined,
): Promise<BriefResult | null> {
  const client = getAnthropicClient();
  let response: Message;
  try {
    response = await client.messages
      .stream({
        model: SUPPLIER_INTELLIGENCE_BRIEF_MODEL,
        max_tokens: BRIEF_MAX_TOKENS,
        system: SUPPLIER_INTELLIGENCE_SYSTEM_PROMPT,
        // Solo el tool del brief: sin caching cross-modelo no hay razón para
        // arrastrar el schema (grande) del tool de extracción en esta pasada.
        tools: [REGISTRAR_BRIEF_CONTRATO_TOOL],
        tool_choice: {
          type: "tool",
          name: REGISTRAR_BRIEF_CONTRATO_TOOL_NAME,
        },
        messages: [buildUserMessage(docs, { context, mode: "brief" })],
      })
      .finalMessage();
  } catch (err) {
    logger.warn("Contract brief pass failed — continuing without brief", {
      requestId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  const usage = usageFromMessage(response, SUPPLIER_INTELLIGENCE_BRIEF_MODEL);
  logger.info("Contract brief completed", {
    requestId,
    model: SUPPLIER_INTELLIGENCE_BRIEF_MODEL,
    stopReason: response.stop_reason,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
  });

  const toolUse = response.content.find(
    (block): block is ToolUseBlock =>
      block.type === "tool_use" &&
      block.name === REGISTRAR_BRIEF_CONTRATO_TOOL_NAME,
  );
  if (!toolUse) {
    logger.warn("Contract brief returned no tool_use — continuing", {
      requestId,
      stopReason: response.stop_reason,
    });
    // Aun sin brief usable, devolvemos el usage para no perder el costo
    // (y el cache write ya quedó hecho, lo aprovechará la pasada principal).
    return { brief: coerceBrief({}), usage };
  }

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
}

const cleanStr = (s: string | null | undefined): string | null => {
  const t = (s ?? "").trim();
  return t === "" ? null : t;
};

const normalizeAccountNumber = (s: string | null | undefined): string =>
  (s ?? "").replace(/\s+/g, "").toLowerCase();

/**
 * Reconcilia las cuentas bancarias del brief con la cuenta primaria que trajo
 * la extracción principal. Devuelve:
 *   - `sharedPatch`: rellena numero_cuenta / banco / tipo_moneda primarios si
 *     la extracción principal los dejó vacíos (usa la 1ra cuenta del brief).
 *   - `manualPrefill`: cuentas 2 y 3 (las que NO son la primaria), listas para
 *     pre-llenar los campos manuales de la UI. `null` si no hay extra.
 */
export function reconcileBankAccounts(
  extraction: ExtractedContract,
  brief: ContractBrief | null,
): { sharedPatch: Partial<ExtractedContract["shared_fields"]>; manualPrefill: ManualBankPrefill | null } {
  const raw = (brief?.bank_accounts ?? [])
    .map((a) => ({
      bank: cleanStr(a.bank),
      num: cleanStr(a.account_number),
      cur: cleanStr(a.currency),
    }))
    .filter((a) => a.num !== null || a.bank !== null);

  if (raw.length === 0) return { sharedPatch: {}, manualPrefill: null };

  // Dedupe por número de cuenta normalizado (o por banco si no hay número).
  const seen = new Set<string>();
  const deduped: typeof raw = [];
  for (const a of raw) {
    const key = a.num ? `n:${normalizeAccountNumber(a.num)}` : `b:${(a.bank ?? "").toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(a);
  }

  const sf = extraction.shared_fields;
  const sharedPatch: Partial<ExtractedContract["shared_fields"]> = {};
  let primaryNum = cleanStr(sf.numero_cuenta);
  let pool = deduped;

  if (!primaryNum) {
    // La extracción principal no trajo cuenta primaria → promovemos la 1ra
    // del brief a shared_fields.
    const a0 = deduped[0]!;
    sharedPatch.numero_cuenta = a0.num;
    if (!cleanStr(sf.banco)) sharedPatch.banco = a0.bank;
    if (!cleanStr(sf.tipo_moneda) && a0.cur) sharedPatch.tipo_moneda = a0.cur;
    primaryNum = a0.num;
    pool = deduped.slice(1);
  } else {
    // Quitamos del pool la cuenta que coincide con la primaria ya extraída.
    const pn = normalizeAccountNumber(primaryNum);
    pool = deduped.filter((a) => normalizeAccountNumber(a.num) !== pn);
  }

  if (pool.length === 0) return { sharedPatch, manualPrefill: null };

  const a2 = pool[0];
  const a3 = pool[1];
  const manualPrefill: ManualBankPrefill = {
    cuenta_bancaria_2: a2?.num ?? null,
    banco_2: a2?.bank ?? null,
    moneda_2: a2?.cur ?? null,
    cuenta_bancaria_3: a3?.num ?? null,
    banco_3: a3?.bank ?? null,
    moneda_3: a3?.cur ?? null,
  };

  // Overflow: la plantilla solo tiene 3 slots (primaria + 2 manuales). Si el
  // contrato lista 4+ cuentas, las extra no caben — las anexamos a `notes`
  // (col BA) para no perderlas. El usuario decide qué hacer con ellas.
  const overflow = pool.slice(2);
  if (overflow.length > 0) {
    const lines = overflow.map((a) => {
      const parts = [a.bank, a.num, a.cur].filter((x): x is string => !!x);
      return `  - ${parts.join(" · ")}`;
    });
    const note =
      `Cuentas bancarias adicionales (no caben en la plantilla, ` +
      `máximo 3):\n${lines.join("\n")}`;
    const existing = cleanStr(extraction.shared_fields.notes);
    sharedPatch.notes = existing ? `${existing}\n\n${note}` : note;
  }

  return { sharedPatch, manualPrefill };
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

  // ── Fase 1: BRIEF ────────────────────────────────────────────────────────
  // Pasada focalizada que captura las reglas globales que la pasada principal
  // suele perder (impuestos, persona adicional, bancos) + un inventario. Es
  // best-effort: si falla, `briefResult` es null y seguimos sin inyección.
  const briefResult = await extractContractBrief(docs, requestId, context);
  const brief = briefResult?.brief ?? null;

  // ── Fase 2: EXTRACCIÓN PRINCIPAL ─────────────────────────────────────────
  // Streaming endpoint en lugar de `messages.create` no-stream: con
  // MAX_TOKENS alto (128k) y contratos densos, la generación puede tardar
  // 3-5 min y Anthropic recomienda streaming para evitar HTTP timeouts
  // upstream. La SDK helper `messages.stream().finalMessage()` colecta los
  // chunks y nos devuelve un `Message` con la misma forma que el endpoint
  // no-stream, así que el resto del flujo (búsqueda de tool_use, coerce,
  // validación) no cambia.
  let response: Message;
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
        messages: [buildUserMessage(docs, { context, mode: "extract", brief })],
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
  // error específico. Con MAX_TOKENS=128k (máximo soportado por Opus 4.7)
  // esto solo debería ocurrir en contratos extraordinariamente densos
  // (cientos de filas). Si se vuelve recurrente, el siguiente paso es
  // un flujo de chunking por temporada — no hay más cap arriba.
  if (response.stop_reason === "max_tokens") {
    logger.warn("Extraction hit max_tokens — output truncated", {
      requestId,
      maxTokens: MAX_TOKENS,
      outputTokens: response.usage?.output_tokens,
    });
    throw new ApiError(
      502,
      "El contrato es excepcionalmente denso y la extracción llegó al " +
        "límite máximo del modelo (128k tokens de salida). Si necesitás " +
        "procesarlo de igual forma, avisanos para evaluar un flujo de " +
        "extracción por secciones.",
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

  // Reconciliación de cuentas bancarias: la extracción principal suele traer
  // solo la cuenta primaria. El brief (Fase 1) captura todas — rellenamos la
  // primaria si faltó y exponemos las cuentas 2 y 3 como prefill manual.
  const { sharedPatch, manualPrefill } = reconcileBankAccounts(extraction, brief);
  const data =
    Object.keys(sharedPatch).length > 0
      ? { ...extraction, shared_fields: { ...extraction.shared_fields, ...sharedPatch } }
      : extraction;

  // Usage = brief (Fase 1, Sonnet) + extracción principal (Fase 2, Opus). Cada
  // pasada se cobra con la tarifa de su modelo; `sumUsage` agrega los totales.
  const mainUsage = usageFromMessage(response, SUPPLIER_INTELLIGENCE_MODEL);
  const usage = sumUsage(
    briefResult ? [briefResult.usage, mainUsage] : [mainUsage],
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
