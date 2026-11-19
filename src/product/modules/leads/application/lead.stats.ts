import { LeadModel } from '../infrastructure/lead.model.js';
import { createdRange, escapeForRegex, type CentralFilters, type CentralPageOf } from '../../../../shared/kernel/central.js';

/** COUNTS ONLY, for platform research: the two count functions below never return names, phones or emails. (The central listing at the end of this file is separate and masked by its caller.) */
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

/**
 * CENTRAL DATA (platform view across organisations): one organisation's leads, newest first, with the same filters for every
 * organisation so the caller can merge pages correctly. Returns the first `take` rows plus the total. Raw values: the caller masks.
 */
export const listLeadsForCentral = async (tenantId: string, f: CentralFilters, take: number): Promise<CentralPageOf<CentralLeadRow>> => {
  const filter: Record<string, unknown> = {};
  if (f.status) filter.stage = f.status;
  if (f.assignedTo) filter.assignedTo = { $in: f.assignedTo };
  const range = createdRange(f);
  if (range) filter.createdAt = range;
  if (f.q) {
    const digits = f.q.replace(/\D/g, '');
    filter.$or = [{ name: new RegExp(escapeForRegex(f.q), 'i') }, ...(digits ? [{ phone: new RegExp(digits) }] : [])];
  }
  const Lead = LeadModel(tenantId);
  const [rows, total] = await Promise.all([Lead.find(filter).sort({ createdAt: -1, _id: -1 }).limit(take).lean<any[]>(), Lead.countDocuments(filter)]);
  return {
    total,
    items: rows.map((l) => ({
      id: String(l._id),
      name: l.name,
      phone: l.phone,
      email: l.email,
      city: l.city,
      interestedCourse: l.interestedCourse,
      channel: l.source?.channel,
      stage: l.stage,
      assignedTo: l.assignedTo,
      createdAt: l.createdAt,
    })),
  };
};

export interface CentralLeadRow {
  id: string;
  name: string;
  phone?: string;
  email?: string;
  city?: string;
  interestedCourse?: string;
  channel?: string;
  stage: string;
  assignedTo?: string;
  createdAt: Date;
}
