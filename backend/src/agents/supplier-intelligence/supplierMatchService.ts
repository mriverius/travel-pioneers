import { APIError } from "@anthropic-ai/sdk";
import type { Tool, ToolUseBlock } from "@anthropic-ai/sdk/resources/messages.js";
import ApiError from "../../utils/ApiError.js";
import logger from "../../config/logger.js";
import { getAnthropicClient } from "./anthropicClient.js";

/**
 * Fuzzy match de nombres de proveedor contra el catálogo CrtLisProv usando
 * Claude. Esto corre como **fallback** del lookup local del frontend (exact /
 * prefix / includes) — solo se invoca cuando esos modos fallan, así que en la
 * práctica este endpoint se llama poco y mantiene el costo controlado.
 *
 * Por qué Haiku 4.5: la tarea es elegir 1 de N strings dada una query. Sonnet
 * es overkill; Haiku es ~10x más barato y 2x más rápido para esto.
 */

/** Modelo de matching. Pinned para evitar deriva silenciosa de calidad/costo. */
export const SUPPLIER_MATCH_MODEL = "claude-haiku-4-5-20251001";

/**
 * Cap de tokens de salida. La herramienta devuelve un objeto pequeño
 * (codigo + confidence + reasoning corto) — 400 es holgado.
 */
const MAX_TOKENS = 400;

/** Cap defensivo en cantidad de candidatos por request — protege costo. */
const MAX_CANDIDATES = 600;

/** Cap por largo de string — evita inflar tokens con descripciones gigantes. */
const MAX_NAME_CHARS = 200;
const MAX_QUERY_CHARS = 500;

export interface MatchCandidate {
  /** Código corto del proveedor en el maestro. Único, sirve de llave. */
  codigo: string;
  /** Nombre comercial visible. Es el campo principal contra el que se matchea. */
  nombre: string;
}

export type MatchConfidence = "alta" | "media" | "baja";

export interface SupplierMatchResult {
  /** Código del candidato elegido, o null si Claude considera que no hay match razonable. */
  codigo: string | null;
  confidence: MatchConfidence;
  /** Justificación corta del modelo (útil para debug/UI). */
  reasoning: string;
}

const TOOL_NAME = "elegir_proveedor";

/**
 * Tool definition. Forzamos `tool_use` en la llamada para que la respuesta
 * sea estructurada — sin parsing de prosa.
 *
 * `codigo` es nullable: si Claude no encuentra un match razonable, debe
 * devolver null en lugar de adivinar.
 */
const MATCH_TOOL: Tool = {
  name: TOOL_NAME,
  description:
    "Elige el código del proveedor del catálogo que mejor corresponde al nombre " +
    "extraído del contrato. Si ningún candidato es razonable, devuelve null.",
  input_schema: {
    type: "object",
    properties: {
      codigo: {
        type: ["string", "null"],
        description:
          "Código del proveedor elegido (debe ser EXACTAMENTE uno de los códigos " +
          "listados como candidatos). null si ningún candidato es plausible.",
      },
      confidence: {
        type: "string",
        enum: ["alta", "media", "baja"],
        description:
          "Qué tan seguro estás del match. 'alta' = los nombres son claramente la " +
          "misma entidad. 'media' = match probable con diferencias menores (sufijos " +
          "legales, prefijos como HOTEL/RESTAURANTE, ubicaciones agregadas). 'baja' = " +
          "incierto pero el más cercano disponible.",
      },
      reasoning: {
        type: "string",
        description:
          "Una frase corta (≤ 25 palabras) explicando por qué este candidato matchea " +
          "(o por qué se devolvió null).",
      },
    },
    required: ["codigo", "confidence", "reasoning"],
  },
};

const SYSTEM_PROMPT =
  "Eres un asistente que matchea nombres de proveedores turísticos extraídos " +
  "de contratos contra un catálogo maestro. Tu tarea es elegir EL ÚNICO código " +
  "del catálogo que mejor corresponde al nombre del query.\n\n" +
  "Reglas:\n" +
  "- Ignora prefijos genéricos del query: HOTEL, RESTAURANTE, RESORT, TOUR, " +
  "  EMPRESA, COMPAÑÍA, etc. cuando no estén en el nombre del catálogo.\n" +
  "- Ignora sufijos legales: S.A., S.R.L., LTDA, LIMITADA, INC, CORP, GROUP.\n" +
  "- Ignora ubicaciones agregadas: ej. 'PARADOR RESORT' del query puede matchear " +
  "  'PARADOR RESORT MANUEL ANTONIO' del catálogo (la ubicación es información " +
  "  extra del catálogo, no parte del nombre comercial).\n" +
  "- Tolera diferencias de acentos, mayúsculas, signos de puntuación y espacios.\n" +
  "- Si dos candidatos son igualmente plausibles, elige el primero por orden alfabético.\n" +
  "- Si ningún candidato comparte el núcleo del nombre, devuelve `codigo: null` con " +
  "  confidence 'baja'. NO inventes ni adivines.\n" +
  "- El campo `codigo` debe ser EXACTAMENTE uno de los códigos provistos. Cualquier " +
  "  otro valor es inválido.";

/**
 * Llama a Claude para resolver el match. La lista de candidatos se serializa
 * como pares "codigo  →  nombre" en el cuerpo del mensaje — formato denso
 * para minimizar tokens.
 */
export async function matchSupplierWithAI(
  query: string,
  candidates: MatchCandidate[],
  requestId?: string,
): Promise<SupplierMatchResult> {
  // Validación de entrada — el controller ya hizo lo básico, esto es defensa
  // en profundidad para que el servicio sea reutilizable.
  const trimmedQuery = query.trim().slice(0, MAX_QUERY_CHARS);
  if (!trimmedQuery) {
    throw ApiError.badRequest("El campo 'query' está vacío.");
  }
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw ApiError.badRequest("Lista de candidatos vacía.");
  }
  if (candidates.length > MAX_CANDIDATES) {
    throw ApiError.badRequest(
      `Demasiados candidatos (${candidates.length}). Máximo: ${MAX_CANDIDATES}.`,
    );
  }

  // Mapa de códigos válidos para verificar la respuesta de Claude.
  const validCodigos = new Set<string>();
  const lines: string[] = [];
  for (const c of candidates) {
    const codigo = c.codigo?.trim();
    const nombre = c.nombre?.trim().slice(0, MAX_NAME_CHARS);
    if (!codigo || !nombre) continue;
    validCodigos.add(codigo);
    lines.push(`${codigo}\t${nombre}`);
  }
  if (validCodigos.size === 0) {
    throw ApiError.badRequest("Lista de candidatos sin entradas válidas.");
  }

  const userMessage =
    `Query (nombre extraído del contrato):\n"${trimmedQuery}"\n\n` +
    `Candidatos del catálogo (formato: codigo\\tnombre, uno por línea):\n` +
    `-----BEGIN CANDIDATES-----\n${lines.join("\n")}\n-----END CANDIDATES-----\n\n` +
    `Usa la herramienta "${TOOL_NAME}" para devolver tu elección. ` +
    `Recuerda: el campo \`codigo\` debe ser exactamente uno de los códigos listados, o null.`;

  const client = getAnthropicClient();
  let response;
  try {
    response = await client.messages.create({
      model: SUPPLIER_MATCH_MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      tools: [MATCH_TOOL],
      tool_choice: { type: "tool", name: TOOL_NAME },
      messages: [{ role: "user", content: userMessage }],
    });
  } catch (err) {
    if (err instanceof APIError) {
      logger.error("Anthropic API error during supplier match", {
        requestId,
        status: err.status,
        message: err.message,
      });
      throw new ApiError(
        502,
        "El servicio de match no está disponible en este momento. Intenta de nuevo.",
      );
    }
    logger.error("Unexpected error calling Anthropic for match", {
      requestId,
      error: err instanceof Error ? err.message : String(err),
    });
    throw new ApiError(502, "Error al invocar al matcher.");
  }

  const toolUse = response.content.find(
    (block): block is ToolUseBlock =>
      block.type === "tool_use" && block.name === TOOL_NAME,
  );
  if (!toolUse) {
    logger.error("Match response missing tool_use block", {
      requestId,
      stopReason: response.stop_reason,
    });
    throw new ApiError(502, "El matcher no devolvió datos estructurados.");
  }

  // Coerce + valida la respuesta. Si Claude devuelve un código que no está en
  // la lista (bug del modelo), lo tratamos como "no match" en lugar de
  // confiar ciegamente — fail-safe.
  const input = toolUse.input as {
    codigo: unknown;
    confidence: unknown;
    reasoning: unknown;
  };
  let codigo: string | null = null;
  if (typeof input.codigo === "string" && validCodigos.has(input.codigo.trim())) {
    codigo = input.codigo.trim();
  } else if (input.codigo !== null && input.codigo !== undefined) {
    logger.warn("AI matcher returned unknown codigo — treating as no-match", {
      requestId,
      returnedCodigo: input.codigo,
    });
  }

  const confidence: MatchConfidence =
    input.confidence === "alta" || input.confidence === "media" || input.confidence === "baja"
      ? input.confidence
      : "baja";

  const reasoning =
    typeof input.reasoning === "string" ? input.reasoning.slice(0, 500) : "";

  return { codigo, confidence, reasoning };
}
