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
  ExtractedContract,
  PreparedDocument,
  ValidationResult,
} from "./types.js";

/**
 * The Sonnet generation is the chosen balance of price/accuracy per the
 * product spec. Pinned here rather than read from env because a downgrade
 * would silently degrade extraction quality.
 */
export const SUPPLIER_INTELLIGENCE_MODEL = "claude-sonnet-4-5";

/** Cap on output tokens — the full schema is ~150 tokens, 1500 is generous. */
const MAX_TOKENS = 1500;

/**
 * Build the user message that gets sent alongside the system prompt. PDFs go
 * as a native `document` block (Claude reads layout + page numbers); Word /
 * Excel arrive as plain text in a single text block.
 */
function buildUserMessage(doc: PreparedDocument): MessageParam {
  const content: ContentBlockParam[] = [];

  if (doc.kind === "pdf") {
    content.push({
      type: "document",
      source: {
        type: "base64",
        media_type: doc.mediaType,
        data: doc.base64,
      },
    });
    content.push({
      type: "text",
      text:
        "Extrae los 9 campos del contrato adjunto usando el tool " +
        `"${EXTRAER_DATOS_CONTRATO_TOOL_NAME}". Respeta las reglas del system prompt.`,
    });
  } else {
    const label =
      doc.sourceFormat === "docx" ? "contrato (Word)" : "contrato (Excel)";
    content.push({
      type: "text",
      text:
        `A continuación el contenido del ${label} ya convertido a texto.\n\n` +
        `-----BEGIN DOCUMENT-----\n${doc.text}\n-----END DOCUMENT-----\n\n` +
        `Extrae los 9 campos usando el tool "${EXTRAER_DATOS_CONTRATO_TOOL_NAME}". ` +
        `Respeta las reglas del system prompt.`,
    });
  }

  return { role: "user", content };
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

  const stringOrNull = (v: unknown): string | null =>
    v === null || typeof v === "string" ? v : null;

  const confianza = (() => {
    const c = r.confianza;
    if (c === "alta" || c === "media" || c === "baja") return c;
    // Default to "baja" if the model ever returns something unexpected — we'd
    // rather mark it for human review than silently accept it.
    return "baja" as Confianza;
  })();

  const camposFaltantes = Array.isArray(r.campos_faltantes)
    ? r.campos_faltantes.filter((x): x is string => typeof x === "string")
    : [];

  const paginasOrigen =
    r.paginas_origen && typeof r.paginas_origen === "object"
      ? (r.paginas_origen as Record<string, string | number>)
      : {};

  return {
    fecha: stringOrNull(r.fecha),
    proveedor: stringOrNull(r.proveedor),
    nombre_comercial: stringOrNull(r.nombre_comercial),
    cedula: stringOrNull(r.cedula),
    direccion: stringOrNull(r.direccion),
    telefono: stringOrNull(r.telefono),
    tipo_moneda: stringOrNull(r.tipo_moneda),
    numero_cuenta: stringOrNull(r.numero_cuenta),
    banco: stringOrNull(r.banco),
    confianza,
    campos_faltantes: camposFaltantes,
    paginas_origen: paginasOrigen,
  };
}

export interface ExtractionResult {
  data: ExtractedContract;
  validation: ValidationResult;
  model: string;
}

/**
 * Run the extraction against Anthropic with `tool_choice` forced to the
 * extraction tool. Maps SDK errors to `ApiError` with spec-aligned status
 * codes (502 for upstream failures, 422 for a missing tool_use block).
 */
export async function extractContract(
  doc: PreparedDocument,
  requestId?: string,
): Promise<ExtractionResult> {
  const client = getAnthropicClient();

  let response;
  try {
    response = await client.messages.create({
      model: SUPPLIER_INTELLIGENCE_MODEL,
      max_tokens: MAX_TOKENS,
      system: SUPPLIER_INTELLIGENCE_SYSTEM_PROMPT,
      tools: [EXTRAER_DATOS_CONTRATO_TOOL],
      tool_choice: {
        type: "tool",
        name: EXTRAER_DATOS_CONTRATO_TOOL_NAME,
      },
      messages: [buildUserMessage(doc)],
    });
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
      input: toolUse.input,
    });
    throw new ApiError(
      502,
      "El agente devolvió una respuesta con formato inesperado.",
    );
  }

  const { extraction, validation } = validateExtraction(raw);

  return {
    data: extraction,
    validation,
    model: SUPPLIER_INTELLIGENCE_MODEL,
  };
}
