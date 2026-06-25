/**
 * Estimación de costo del pipeline completo (pre-análisis Paso 2 + extracción
 * Paso 3) con tarifa Opus 4.8 — la que usa el manager para presupuesto.
 */
export const OPUS_48_INPUT_USD_PER_M = 5;
export const OPUS_48_OUTPUT_USD_PER_M = 25;

export interface TokenUsageSlice {
  input_tokens?: number;
  output_tokens?: number;
  cost_usd?: number;
}

/** Suma tokens de todas las pasadas y recalcula costo con tarifa Opus 4.8. */
export function combinePipelineUsage(
  extractMeta: TokenUsageSlice,
  briefMetas: TokenUsageSlice[],
): { input_tokens: number; output_tokens: number; cost_usd: number } {
  const slices = [...briefMetas, extractMeta];
  const input_tokens = slices.reduce((s, m) => s + (m.input_tokens ?? 0), 0);
  const output_tokens = slices.reduce((s, m) => s + (m.output_tokens ?? 0), 0);
  const cost_usd =
    (input_tokens / 1_000_000) * OPUS_48_INPUT_USD_PER_M +
    (output_tokens / 1_000_000) * OPUS_48_OUTPUT_USD_PER_M;
  return {
    input_tokens,
    output_tokens,
    cost_usd: Number(cost_usd.toFixed(4)),
  };
}
