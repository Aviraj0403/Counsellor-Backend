import { LeadModel } from '../infrastructure/lead.model.js';

/** COUNTS ONLY, for platform research. No names, phones or emails ever leave this module through these functions. */
export const countLeads = async (tenantId: string): Promise<number> => LeadModel(tenantId).countDocuments();

export const leadCountsByStageAndChannel = async (tenantId: string) => {
  const Lead = LeadModel(tenantId);
  const [stages, channels] = await Promise.all([
    Lead.aggregate([{ $group: { _id: '$stage', n: { $sum: 1 } } }]),
    Lead.aggregate([{ $group: { _id: { channel: '$source.channel', stage: '$stage' }, n: { $sum: 1 } } }]),
  ]);
  const byStage: Record<string, number> = Object.fromEntries(stages.map((s: any) => [s._id, s.n]));
  const byChannel: Record<string, Record<string, number>> = {};
  for (const c of channels as any[]) {
    const ch = c._id.channel ?? 'unknown';
    byChannel[ch] = { ...(byChannel[ch] ?? {}), [c._id.stage]: c.n };
  }
  return { byStage, byChannel };
};
