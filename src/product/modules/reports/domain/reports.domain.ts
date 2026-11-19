// Pure aggregation helpers for reports. No database, no HTTP. Never returns NaN or Infinity.

/** Percentage with one decimal, 0 when the denominator is 0 or either side is not a finite number. */
export const pct = (part: number, whole: number): number => {
  if (!Number.isFinite(part) || !Number.isFinite(whole) || whole <= 0) return 0;
  return Math.round((part / whole) * 1000) / 10;
};

export const sumValues = (m: Record<string, number>): number => Object.values(m).reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);

/** Lead stages in the order a lead normally travels (lost is outside the happy path). */
export const FUNNEL_ORDER = ['new', 'contacted', 'qualified', 'counselling_done', 'application_started', 'admitted'] as const;

export interface FunnelStep {
  stage: string;
  count: number;
  /** Leads that reached this stage or any later one. */
  reached: number;
  /** reached / total leads, in percent. */
  ofTotalPct: number;
  /** reached / previous step reached, in percent (100 for the first step with leads). */
  ofPreviousPct: number;
}

export const buildFunnel = (byStage: Record<string, number>) => {
  const total = sumValues(byStage);
  const lost = byStage.lost ?? 0;
  const steps: FunnelStep[] = FUNNEL_ORDER.map((stage, i) => {
    // Every lead entered the funnel at "new" (including those lost later), so the first step is the total.
    const reached = i === 0 ? total : FUNNEL_ORDER.slice(i).reduce((a, s) => a + (byStage[s] ?? 0), 0);
    return { stage, count: byStage[stage] ?? 0, reached, ofTotalPct: pct(reached, total), ofPreviousPct: 0 };
  });
  steps.forEach((s, i) => {
    s.ofPreviousPct = i === 0 ? (s.reached > 0 ? 100 : 0) : pct(s.reached, steps[i - 1].reached);
  });
  const admitted = byStage.admitted ?? 0;
  return { total, lost, admitted, conversionPct: pct(admitted, total), steps };
};

export interface SourceRow {
  channel: string;
  leads: number;
  contacted: number;
  admitted: number;
  lost: number;
  conversionPct: number;
  contactedPct: number;
}

/** byChannel: channel -> stage -> count. Sorted by leads, biggest first. */
export const buildSources = (byChannel: Record<string, Record<string, number>>): SourceRow[] =>
  Object.entries(byChannel)
    .map(([channel, stages]) => {
      const leads = sumValues(stages);
      const contacted = leads - (stages.new ?? 0);
      const admitted = stages.admitted ?? 0;
      return { channel, leads, contacted, admitted, lost: stages.lost ?? 0, conversionPct: pct(admitted, leads), contactedPct: pct(contacted, leads) };
    })
    .sort((a, b) => b.leads - a.leads || a.channel.localeCompare(b.channel));

export interface CounsellorRow {
  counsellorId: string;
  name: string;
  applications: number;
  /** Share of all applications handled by this counsellor, in percent. */
  sharePct: number;
}

export const buildCounsellors = (counts: Record<string, number>, names: Record<string, string>): CounsellorRow[] => {
  const total = sumValues(counts);
  return Object.entries(counts)
    .map(([counsellorId, applications]) => ({ counsellorId, name: names[counsellorId] ?? (counsellorId === 'unassigned' ? 'Unassigned' : 'Former team member'), applications, sharePct: pct(applications, total) }))
    .sort((a, b) => b.applications - a.applications || a.name.localeCompare(b.name));
};

export interface NamedCount {
  id: string;
  name: string;
  applications: number;
  sharePct: number;
}

export const buildByCollege = (counts: Record<string, number>, names: Record<string, string>): NamedCount[] => {
  const total = sumValues(counts);
  return Object.entries(counts)
    .map(([id, applications]) => ({ id, name: names[id] ?? 'Other college', applications, sharePct: pct(applications, total) }))
    .sort((a, b) => b.applications - a.applications || a.name.localeCompare(b.name));
};

export const buildByStatus = (counts: Record<string, number>) => {
  const total = sumValues(counts);
  return {
    total,
    items: Object.entries(counts)
      .map(([status, count]) => ({ status, count, sharePct: pct(count, total) }))
      .sort((a, b) => b.count - a.count || a.status.localeCompare(b.status)),
  };
};

/** Parse an optional ISO date (YYYY-MM-DD or full ISO). `to` given as a plain date is inclusive of that whole day. */
export const parseRange = (from?: string, to?: string): { from?: Date; to?: Date } => {
  const out: { from?: Date; to?: Date } = {};
  if (from) out.from = new Date(from);
  if (to) {
    const d = new Date(to);
    out.to = /^\d{4}-\d{2}-\d{2}$/.test(to) ? new Date(d.getTime() + 24 * 3600 * 1000) : d;
  }
  return out;
};

export const collectionRate = (collectedPaise: number, accruedPaise: number): number => pct(collectedPaise, accruedPaise);
