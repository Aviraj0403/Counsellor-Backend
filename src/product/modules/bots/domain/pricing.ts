/** Token prices in USD per million tokens. Update here when prices change (unknown model = the most expensive row, so we never under-meter). */
export const PRICE_USD_PER_MTOK: Record<string, { in: number; out: number }> = {
  'claude-opus-5-5': { in: 4, out: 20 },
  'claude-opus-5': { in: 5, out: 25 },
  'claude-sonnet-5-5': { in: 2, out: 10 },
  'claude-sonnet-5': { in: 2, out: 10 },
  'claude-haiku-5-5': { in: 0.1, out: 0.5 },
  'claude-fable-5-2': { in: 8, out: 40 },
};
const FALLBACK = { in: 10, out: 50 };

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

/** Cost in whole paise (rounded up so a call is never free). Zero tokens = zero cost. */
export const costPaise = (model: string, usage: TokenUsage, inrPerUsd: number): number => {
  const total = Math.max(0, usage.inputTokens) + Math.max(0, usage.outputTokens);
  if (total === 0) return 0;
  const p = PRICE_USD_PER_MTOK[model] ?? FALLBACK;
  const usd = (Math.max(0, usage.inputTokens) * p.in + Math.max(0, usage.outputTokens) * p.out) / 1_000_000;
  return Math.max(1, Math.ceil(usd * inrPerUsd * 100));
};
