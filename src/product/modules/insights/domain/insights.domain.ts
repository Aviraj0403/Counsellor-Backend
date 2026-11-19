/** Pure maths for the research screens. No database, no student data: only counts. */

export interface StageCounts {
  [stage: string]: number;
}

export const sumCounts = (a: StageCounts, b: StageCounts): StageCounts => {
  const out: StageCounts = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = (out[k] ?? 0) + v;
  return out;
};

/** admitted / total as a percentage with one decimal; 0 when there are no leads (never NaN). */
export const conversionPct = (admitted: number, total: number): number => (total > 0 ? Math.round((admitted / total) * 1000) / 10 : 0);

export interface FunnelRow {
  total: number;
  admitted: number;
  lost: number;
  conversionPct: number;
}

export const funnelRow = (byStage: StageCounts): FunnelRow => {
  const total = Object.values(byStage).reduce((s, n) => s + n, 0);
  const admitted = byStage.admitted ?? 0;
  return { total, admitted, lost: byStage.lost ?? 0, conversionPct: conversionPct(admitted, total) };
};
