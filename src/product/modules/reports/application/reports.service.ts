import { getPlatform } from '../../../../contracts/registry.js';
import { applicationCountsByCollege, applicationCountsByCounsellor, applicationCountsByStatus } from '../../applications/index.js';
import { listActiveColleges } from '../../colleges/index.js';
import { commissionTotals } from '../../commissions/index.js';
import { leadCountsByStageAndChannel } from '../../leads/index.js';
import { buildByCollege, buildByStatus, buildCounsellors, buildFunnel, buildSources, collectionRate, parseRange } from '../domain/reports.domain.js';

/** Counts and rupee totals only. No names of students, phones or emails ever appear here. */
const NOTE_RANGE = 'Lead and application counts are all-time; the date range applies to revenue only.';

export const funnelReport = async (tenantId: string) => {
  const { byStage } = await leadCountsByStageAndChannel(tenantId);
  return { ...buildFunnel(byStage), note: NOTE_RANGE };
};

export const sourcesReport = async (tenantId: string) => {
  const { byChannel } = await leadCountsByStageAndChannel(tenantId);
  return { items: buildSources(byChannel), note: NOTE_RANGE };
};

export const counsellorsReport = async (tenantId: string) => {
  const [counts, team] = await Promise.all([applicationCountsByCounsellor(tenantId), getPlatform().listTeam(tenantId)]);
  const names = Object.fromEntries(team.map((m) => [m.id, m.name]));
  // Not available from other modules' public API yet: leads per counsellor, admitted per counsellor, commission per counsellor, time to first contact.
  return { items: buildCounsellors(counts, names), note: NOTE_RANGE };
};

export const applicationsReport = async (tenantId: string) => {
  const [byStatus, byCollege, colleges] = await Promise.all([applicationCountsByStatus(tenantId), applicationCountsByCollege(tenantId), listActiveColleges(tenantId)]);
  const names = Object.fromEntries(colleges.map((c: any) => [String(c._id), String(c.name)]));
  return { byStatus: buildByStatus(byStatus), byCollege: buildByCollege(byCollege, names) };
};

export const revenueReport = async (tenantId: string, from?: string, to?: string) => {
  const range = parseRange(from, to);
  const t = await commissionTotals(tenantId, range);
  return { ...t, outstandingPaise: Math.max(0, t.accruedPaise - t.collectedPaise), collectionPct: collectionRate(t.collectedPaise, t.accruedPaise), from: from ?? null, to: to ?? null };
};
