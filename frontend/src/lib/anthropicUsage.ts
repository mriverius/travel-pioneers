/**
 * Costo del pipeline completo (pre-análisis Paso 2 + extracción Paso 3).
 *
 * El backend calcula `cost_usd` por pasada con la tarifa del modelo que la
 * ejecutó (Sonnet 5.5 para el brief, Opus 5.5 para la extracción), así que
 * aquí SUMAMOS esos costos. La tarifa plana sólo se usa como fallback para
 * respuestas de backends viejos que no traigan `cost_usd` (Opus 5.5, oct
 * 2026: $4 / $20 por millón).
 */
export const FALLBACK_INPUT_USD_PER_M = 4;
export const FALLBACK_OUTPUT_USD_PER_M = 20;

export interface TokenUsageSlice {
  input_tokens?: number;
  output_tokens?: number;
  cost_usd?: number;
}

/** Suma tokens y costos de todas las pasadas (cada una a la tarifa de su modelo). */
export function combinePipelineUsage(
  extractMeta: TokenUsageSlice,
  briefMetas: TokenUsageSlice[],
): { input_tokens: number; output_tokens: number; cost_usd: number } {
  const slices = [...briefMetas, extractMeta];
  const input_tokens = slices.reduce((s, m) => s + (m.input_tokens ?? 0), 0);
  const output_tokens = slices.reduce((s, m) => s + (m.output_tokens ?? 0), 0);
  const cost_usd = slices.reduce((s, m) => {
    if (typeof m.cost_usd === "number" && Number.isFinite(m.cost_usd)) return s + m.cost_usd;
    return (
      s +
      ((m.input_tokens ?? 0) / 1_000_000) * FALLBACK_INPUT_USD_PER_M +
      ((m.output_tokens ?? 0) / 1_000_000) * FALLBACK_OUTPUT_USD_PER_M
    );
  }, 0);
  return {
    input_tokens,
    output_tokens,
    cost_usd: Number(cost_usd.toFixed(4)),
  };
}
