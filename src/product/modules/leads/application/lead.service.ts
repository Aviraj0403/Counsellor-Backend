import { getPlatform } from '../../../../contracts/registry.js';
import type { Principal } from '../../../../contracts/port.js';
import { badRequest, notFound } from '../../../../shared/kernel/errors.js';
import { publish } from '../../../../shared/kernel/events.js';
import { audit } from '../../audit/index.js';
import { LeadModel } from '../infrastructure/lead.model.js';
import { canTransition, isOpenStage, nextStages, normalizePhone, pickAssignee, type LeadStage } from '../domain/lead.domain.js';
import { recordReferralLead } from './referral.service.js';

export interface CreateLeadInput {
  name: string;
  phone: string;
  email?: string;
  city?: string;
  interestedCourse?: string;
  source: { channel: string; utmSource?: string; utmMedium?: string; utmCampaign?: string; referralCode?: string };
  consent: { given: boolean; source?: string };
  autoAssign?: boolean;
}

/** A counsellor only ever sees leads assigned to them. Everyone else with leads:read sees the whole organisation. */
const visibility = (p: Principal) => (p.role === 'counsellor' ? { assignedTo: p.userId } : {});

const openLoadByUser = async (tenantId: string): Promise<Map<string, number>> => {
  const rows = await LeadModel(tenantId).aggregate([
    { $match: { stage: { $nin: ['admitted', 'lost'] }, assignedTo: { $exists: true } } },
    { $group: { _id: '$assignedTo', n: { $sum: 1 } } },
  ]);
  return new Map(rows.map((r: any) => [String(r._id), r.n as number]));
};

export const createLead = async (p: Principal, input: CreateLeadInput) => {
  const tenantId = p.tenantId!;
  const phone = normalizePhone(input.phone);
  if (!phone) throw badRequest('Enter a valid 10-digit Indian mobile number.');
  const Lead = LeadModel(tenantId);

  // Same student enquiring twice is NOT a new lead: return the existing one and record the repeat.
  const existing = await Lead.findOne({ phone }).lean<any>();
  if (existing) {
    await audit(tenantId, { action: 'lead.duplicate_enquiry', entity: 'lead', entityId: String(existing._id), meta: { channel: input.source.channel } });
    return { lead: existing, duplicate: true };
  }

  let assignedTo: string | undefined;
  // Automatically assign if explicitly requested OR if created by public/system sources (e.g. meta-ads, website, seo, bot, api)
  const isSystemOrPublic = p.role === 'system' || p.userId?.startsWith('system:') || p.userId?.startsWith('api:');
  const shouldAutoAssign = input.autoAssign ?? isSystemOrPublic;

  if (shouldAutoAssign) {
    const team = await getPlatform().listTeam(tenantId, ['counsellor']);
    const load = await openLoadByUser(tenantId);
    assignedTo = pickAssignee(team.map((m) => ({ id: m.id, openLeads: load.get(m.id) ?? 0 })));
  } else if (p.role === 'counsellor') {
    assignedTo = p.userId; // a counsellor who adds a lead owns it
  }

  const lead = await Lead.create({
    name: input.name,
    phone,
    email: input.email,
    city: input.city,
    interestedCourse: input.interestedCourse,
    source: input.source,
    consent: { given: input.consent.given, source: input.consent.source, at: input.consent.given ? new Date() : undefined },
    assignedTo,
    createdBy: p.userId,
  });
  await audit(tenantId, { action: 'lead.created', entity: 'lead', entityId: String(lead._id), meta: { channel: input.source.channel, assignedTo } });
  await publish('lead.created', { tenantId, leadId: String(lead._id), channel: input.source.channel, actorId: p.userId });

  // Record referral attribution if lead came through referral
  if (input.source.channel === 'referral' || input.source.referralCode) {
    const code = input.source.referralCode || input.source.utmCampaign;
    if (code) {
      await recordReferralLead(tenantId, {
        id: String(lead._id),
        name: lead.name,
        phone: lead.phone,
        referralCode: code,
      }).catch(() => {});
    }
  }

  return { lead: lead.toObject(), duplicate: false };
};

export const listLeads = async (
  p: Principal,
  q: { page: number; limit: number; stage?: LeadStage; assignedTo?: string; search?: string },
) => {
  const filter: Record<string, unknown> = { ...visibility(p) };
  if (q.stage) filter.stage = q.stage;
  if (q.assignedTo && p.role !== 'counsellor') filter.assignedTo = q.assignedTo;
  if (q.search) {
    const safe = q.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    filter.$or = [{ name: new RegExp(safe, 'i') }, { phone: new RegExp(safe.replace(/\D/g, '') || '^$') }];
  }
  const Lead = LeadModel(p.tenantId!);
  const [items, total] = await Promise.all([
    Lead.find(filter).sort({ createdAt: -1 }).skip((q.page - 1) * q.limit).limit(q.limit).lean(),
    Lead.countDocuments(filter),
  ]);
  return { items, total, page: q.page, limit: q.limit };
};

export const getLead = async (p: Principal, id: string) => {
  const lead = await LeadModel(p.tenantId!).findOne({ _id: id, ...visibility(p) }).lean<any>();
  if (!lead) throw notFound('Lead');
  return { ...lead, allowedNextStages: nextStages(lead.stage) };
};

export const changeStage = async (p: Principal, id: string, to: LeadStage, note?: string) => {
  const Lead = LeadModel(p.tenantId!);
  const lead = await Lead.findOne({ _id: id, ...visibility(p) });
  if (!lead) throw notFound('Lead');
  const from = lead.stage as LeadStage;
  if (!canTransition(from, to)) {
    throw badRequest(`A lead in "${from}" cannot move to "${to}". Allowed next steps: ${nextStages(from).join(', ') || 'none'}.`);
  }
  lead.stage = to;
  lead.stageHistory.push({ from, to, by: p.userId, note, at: new Date() } as any);
  await lead.save();
  await audit(p.tenantId!, { action: 'lead.stage_changed', entity: 'lead', entityId: id, meta: { from, to } });
  await publish('lead.stage_changed', { tenantId: p.tenantId!, leadId: id, from, to, actorId: p.userId });
  return { id, stage: to, open: isOpenStage(to) };
};

export const assignLead = async (p: Principal, id: string, target: { assigneeId?: string; auto?: boolean }) => {
  const tenantId = p.tenantId!;
  const team = await getPlatform().listTeam(tenantId, ['counsellor']);
  let assigneeId = target.assigneeId;
  if (target.auto) {
    const load = await openLoadByUser(tenantId);
    assigneeId = pickAssignee(team.map((m) => ({ id: m.id, openLeads: load.get(m.id) ?? 0 })));
    if (!assigneeId) throw badRequest('No active counsellor is available to assign.');
  }
  if (!assigneeId || !team.some((m) => m.id === assigneeId)) throw badRequest('Choose an active counsellor of your organisation.');
  const lead = await LeadModel(tenantId).findByIdAndUpdate(id, { assignedTo: assigneeId }, { new: true }).lean<any>();
  if (!lead) throw notFound('Lead');
  await audit(tenantId, { action: 'lead.assigned', entity: 'lead', entityId: id, meta: { assigneeId } });
  await publish('lead.assigned', { tenantId, leadId: id, assigneeId, actorId: p.userId });
  return { id, assignedTo: assigneeId };
};

/** Read one lead (with contact details) for another module that acts on it, for example sending a WhatsApp message. Inside one organisation only. */
export const findLeadById = async (tenantId: string, id: string) => (/^[a-f\d]{24}$/i.test(id) ? LeadModel(tenantId).findById(id).lean<any>() : null);

/** Find a lead by phone number (any format). For modules that receive a message from a number, for example WhatsApp inbound. */
export const findLeadByPhone = async (tenantId: string, rawPhone: string) => {
  const phone = normalizePhone(rawPhone);
  return phone ? LeadModel(tenantId).findOne({ phone }).lean<any>() : null;
};
