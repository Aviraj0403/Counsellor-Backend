import { badRequest } from '../../../../shared/kernel/errors.js';
import { addDays, buildPerformance, isDateString, istDateString, istDayStart } from '../domain/meta.insights.domain.js';
import { MetaInsightDailyModel, MetaLeadLinkModel } from '../infrastructure/meta.model.js';

const DAY_MS = 86_400_000;
const MAX_RANGE_DAYS = 366;

export const resolveRange = (q: { from?: string; to?: string }, now: Date = new Date()) => {
  const to = q.to ?? istDateString(now);
  const from = q.from ?? addDays(to, -29);
  if (!isDateString(from) || !isDateString(to)) throw badRequest('Use dates like 2026-11-30.');
  if (from > to) throw badRequest('"From" must not be after "To".');
  if ((Date.parse(to) - Date.parse(from)) / DAY_MS >= MAX_RANGE_DAYS) throw badRequest('Choose a range of at most one year.');
  return { from, to };
};

/**
 * Per campaign: Meta's own numbers (spend, impressions, clicks, leads) from the synced days, plus the leads that really arrived
 * in the platform through the lead-ads webhook for that campaign (MetaLeadLink). Platform leads are counted from the links this
 * module stores, so the leads module is untouched.
 */
export const performance = async (tenantId: string, q: { from?: string; to?: string }) => {
  const { from, to } = resolveRange(q);
  const [daily, links, unattributed] = await Promise.all([
    MetaInsightDailyModel(tenantId).find({ date: { $gte: from, $lte: to } }).lean<any[]>(),
    MetaLeadLinkModel(tenantId).aggregate([
      { $match: { at: { $gte: istDayStart(from), $lt: new Date(istDayStart(to).getTime() + DAY_MS) }, campaignId: { $type: 'string' } } },
      { $group: { _id: '$campaignId', n: { $sum: 1 }, name: { $last: '$campaignName' } } },
    ]),
    MetaLeadLinkModel(tenantId).countDocuments({ at: { $gte: istDayStart(from), $lt: new Date(istDayStart(to).getTime() + DAY_MS) }, campaignId: { $not: { $type: 'string' } } }),
  ]);
  // newest campaign name wins (campaigns get renamed)
  const names: Record<string, string> = {};
  for (const d of [...daily].sort((a, b) => a.date.localeCompare(b.date))) if (d.campaignName) names[d.campaignId] = d.campaignName;
  for (const l of links) if (l.name && !names[l._id]) names[l._id] = l.name;
  const built = buildPerformance(
    daily.map((d) => ({ campaignId: d.campaignId, spend: d.spend, impressions: d.impressions, clicks: d.clicks, leads: d.leads, currencyMismatch: d.currencyMismatch })),
    Object.fromEntries(links.map((l: any) => [l._id, l.n])),
    names,
  );
  for (const it of built.items) it.campaignName = names[it.campaignId] ?? it.campaignName;
  return { from, to, ...built, unattributedPlatformLeads: unattributed };
};

export const spendAndLeads30d = async (tenantId: string, now: Date = new Date()) => {
  const today = istDateString(now);
  const rows = await MetaInsightDailyModel(tenantId).aggregate([
    { $match: { date: { $gte: addDays(today, -29), $lte: today }, currencyMismatch: { $ne: true } } },
    { $group: { _id: null, spend: { $sum: '$spend' }, leads: { $sum: '$leads' } } },
  ]);
  return { spendPaise: rows[0]?.spend ?? 0, leads: rows[0]?.leads ?? 0 };
};
