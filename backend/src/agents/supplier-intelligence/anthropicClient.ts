import Anthropic from "@anthropic-ai/sdk";
import { Agent } from "undici";
import ApiError from "../../utils/ApiError.js";
import logger from "../../config/logger.js";

let cached: Anthropic | null = null;

/**
 * Dispatcher de undici (el cliente HTTP detrás del `fetch` global de Node) con
 * los timeouts a nivel de socket DESACTIVADOS para las extracciones largas.
 *
 * Por qué: la pasada principal (Opus, contratos densos) puede streamear 4-10
 * min. Los defaults de undici (`headersTimeout`/`bodyTimeout` = 300s) matan el
 * socket a mitad del stream y la SDK lo reporta como un error crudo
 * `"terminated"` (no un APIError), abortando la extracción mucho antes de que
 * termine. Poniéndolos en 0 dejamos que el ÚNICO techo sea el `timeout` de la
 * SDK (14 min, abajo), que usa un AbortSignal limpio. `connectTimeout` se
 * mantiene corto: si no podemos ni abrir la conexión, queremos fallar rápido.
 */
const anthropicDispatcher = new Agent({
  headersTimeout: 0,
  bodyTimeout: 0,
  connectTimeout: 30_000,
  keepAliveTimeout: 60_000,
  keepAliveMaxTimeout: 10 * 60 * 1000,
});

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
  cached = new Anthropic({
    apiKey,
    timeout: 14 * 60 * 1000,
    // El dispatcher con timeouts de socket desactivados evita que undici
    // termine el stream largo de la pasada principal antes de tiempo.
    fetchOptions: { dispatcher: anthropicDispatcher },
  });
  return cached;
}
