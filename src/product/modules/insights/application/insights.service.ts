import { getPlatform } from '../../../../contracts/registry.js';
import { lastActivityAt } from '../../audit/index.js';
import { countLeads, leadCountsByStageAndChannel } from '../../leads/index.js';
import { countLedgerEntries } from '../../ledger/index.js';
import { funnelRow, sumCounts, type StageCounts } from '../domain/insights.domain.js';

/**
 * PLATFORM RESEARCH across organisations. Returns COUNTS ONLY (how many leads per stage / per channel).
 * No names, phones, emails or documents ever leave an organisation's database here: this module can only
 * call the other modules' count functions, it has no access to their models.
 */

const CONCURRENCY = 5;
const inChunks = async <T, R>(items: T[], fn: (x: T) => Promise<R>): Promise<R[]> => {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += CONCURRENCY) out.push(...(await Promise.all(items.slice(i, i + CONCURRENCY).map(fn))));
  return out;
};

export const funnelAcrossOrganisations = async () => {
  const tenants = (await getPlatform().listTenants()).filter((t) => t.status === 'active');

  const perTenant = await inChunks(tenants, async (t) => ({ tenantId: t.id, name: t.name, ...(await leadCountsByStageAndChannel(t.id)) }));

  let totalByStage: StageCounts = {};
  const channelTotals: Record<string, StageCounts> = {};
  for (const t of perTenant) {
    totalByStage = sumCounts(totalByStage, t.byStage);
    for (const [ch, counts] of Object.entries(t.byChannel)) channelTotals[ch] = sumCounts(channelTotals[ch] ?? {}, counts);
  }

  return {
    totals: { byStage: totalByStage, ...funnelRow(totalByStage) },
    byChannel: Object.entries(channelTotals)
      .map(([channel, counts]) => ({ channel, byStage: counts, ...funnelRow(counts) }))
      .sort((a, b) => b.total - a.total),
    byOrganisation: perTenant
      .map((t) => ({ tenantId: t.tenantId, name: t.name, byStage: t.byStage, ...funnelRow(t.byStage) }))
      .sort((a, b) => b.total - a.total),
  };
};

export const usageAcrossOrganisations = async () => {
  const tenants = await getPlatform().listTenants();
  const rows = await inChunks(tenants, async (t) => {
    const [leads, ledgerEntries, lastActivity] = await Promise.all([countLeads(t.id), countLedgerEntries(t.id), lastActivityAt(t.id)]);
    return { tenantId: t.id, name: t.name, status: t.status, leads, ledgerEntries, lastActivityAt: lastActivity };
  });
  return { organisations: rows.sort((a, b) => b.leads - a.leads) };
};
