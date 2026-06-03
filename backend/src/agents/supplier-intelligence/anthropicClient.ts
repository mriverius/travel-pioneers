import Anthropic from "@anthropic-ai/sdk";
import ApiError from "../../utils/ApiError.js";
import logger from "../../config/logger.js";

let cached: Anthropic | null = null;

/**
 * Lazily construct a single Anthropic client. Reading `ANTHROPIC_API_KEY`
 * here (rather than at module load) lets tests override the env var before
 * the first call and avoids crashing the whole app on boot if the key is
 * missing — only endpoints that actually hit Anthropic will fail.
 */
export function getAnthropicClient(): Anthropic {
  if (cached) return cached;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    logger.error("ANTHROPIC_API_KEY is not configured");
    throw ApiError.internal(
      "El agente de extracción no está configurado en el servidor.",
    );
  }

  // `timeout` explícito por request (cada pasada: brief y extracción
  // principal). El default del SDK es 10 min; una extracción densa (52k+
  // tokens de salida) puede acercarse a ese límite, y no queremos que el SDK
  // aborte el stream justo antes de terminar. 14 min por llamada da headroom
  // sin dejar que una llamada colgada corra para siempre. El ceiling del
  // frontend (15 min, ver `api.ts`) cubre las dos pasadas en conjunto.
  cached = new Anthropic({ apiKey, timeout: 14 * 60 * 1000 });
  return cached;
}
