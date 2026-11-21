import type { Principal } from '../../../../contracts/port.js';
import { notFound, badRequest } from '../../../../shared/kernel/errors.js';
import { audit } from '../../audit/index.js';
import { getJobQueue } from '../../../../shared/infra/queue.js';
import { logger } from '../../../../shared/infra/logger.js';
import { LeadModel } from '../../leads/infrastructure/lead.model.js';
import { StudentModel } from '../../students/infrastructure/student.model.js';
import { TemplateModel } from '../infrastructure/whatsapp.model.js';
import { BroadcastCampaignModel } from '../infrastructure/campaign.model.js';
import { sendMessage } from './whatsapp.service.js';

export interface CreateCampaignInput {
  name: string;
  template: string;
  language?: string;
  audience: 'leads' | 'students' | 'all';
  filters?: {
    stage?: string;
    city?: string;
    course?: string;
  };
  paramMapping?: string[]; // e.g. ['name', 'course']
  scheduledAt?: Date;
}

export const listCampaigns = async (tenantId: string) => {
  return BroadcastCampaignModel(tenantId).find().sort({ createdAt: -1 }).lean();
};

export const getCampaign = async (tenantId: string, campaignId: string) => {
  const c = await BroadcastCampaignModel(tenantId).findById(campaignId).lean();
  if (!c) throw notFound('Campaign');
  return c;
};

export const createCampaign = async (p: Principal, input: CreateCampaignInput) => {
  const tenantId = p.tenantId!;
  const language = input.language ?? 'en';

  // Ensure template exists
  const tpl = await TemplateModel(tenantId).findOne({ name: input.template, language, active: true }).lean();
  if (!tpl) throw notFound('Template');

  const doc = await BroadcastCampaignModel(tenantId).create({
    name: input.name,
    template: input.template,
    language,
    audience: input.audience,
    filters: input.filters || {},
    paramMapping: input.paramMapping || ['name'],
    status: input.scheduledAt ? 'scheduled' : 'draft',
    scheduledAt: input.scheduledAt,
    createdBy: p.userId,
  });

  await audit(tenantId, {
    action: 'whatsapp.campaign_created',
    entity: 'whatsapp_campaign',
    entityId: String(doc._id),
    meta: { name: doc.name, template: doc.template },
  });

  return doc.toObject();
};

/**
 * Executes a broadcast campaign: finds matching audience, verifies consent, interpolates params,
 * and delivers messages via sendMessage/job queue.
 */
export const executeCampaign = async (tenantId: string, campaignId: string, initiatedBy?: string) => {
  const Campaign = BroadcastCampaignModel(tenantId);
  const campaign = await Campaign.findById(campaignId);
  if (!campaign) throw notFound('Campaign');
  if (campaign.status === 'processing' || campaign.status === 'completed') {
    return campaign.toObject();
  }

  campaign.status = 'processing';
  campaign.startedAt = new Date();
  await campaign.save();

  try {
    let leadRecipients: any[] = [];
    let studentRecipients: any[] = [];

    // Query Leads
    if (campaign.audience === 'leads' || campaign.audience === 'all') {
      const q: any = {};
      if (campaign.filters?.stage) q.stage = campaign.filters.stage;
      if (campaign.filters?.city) q.city = new RegExp(campaign.filters.city, 'i');
      if (campaign.filters?.course) q.interestedCourse = new RegExp(campaign.filters.course, 'i');
      leadRecipients = await LeadModel(tenantId).find(q).lean();
    }

    // Query Students
    if (campaign.audience === 'students' || campaign.audience === 'all') {
      const q: any = { status: 'active' };
      if (campaign.filters?.city) q['address.city'] = new RegExp(campaign.filters.city, 'i');
      if (campaign.filters?.course) q['preferences.courses'] = new RegExp(campaign.filters.course, 'i');
      studentRecipients = await StudentModel(tenantId).find(q).lean();
    }

    const totalAudience = leadRecipients.length + studentRecipients.length;
    campaign.stats.total = totalAudience;
    await campaign.save();

    let sent = 0;
    let failed = 0;
    let skippedNoConsent = 0;

    const buildParams = (mapping: string[], item: any, kind: 'lead' | 'student') => {
      return (mapping || ['name']).map((key) => {
        if (key === 'name') return item.name || 'Student';
        if (key === 'course') {
          return kind === 'lead' ? (item.interestedCourse || 'Engineering') : (item.preferences?.courses?.[0] || 'Engineering');
        }
        if (key === 'city') {
          return kind === 'lead' ? (item.city || 'your city') : (item.address?.city || 'your city');
        }
        return '';
      });
    };

    // Send to leads
    for (const lead of leadRecipients) {
      if (!lead.consent?.given) {
        skippedNoConsent++;
        continue;
      }
      try {
        const params = buildParams(campaign.paramMapping, lead, 'lead');
        await sendMessage(
          { role: 'system', tenantId, userId: initiatedBy || 'system:campaign' } as Principal,
          {
            leadId: String(lead._id),
            template: campaign.template,
            language: campaign.language,
            params,
          },
        );
        sent++;
      } catch (err: any) {
        logger.warn({ err: err?.message, leadId: lead._id }, 'campaign message send failed');
        failed++;
      }
    }

    // Send to students
    for (const student of studentRecipients) {
      if (!student.consent?.given) {
        skippedNoConsent++;
        continue;
      }
      try {
        const params = buildParams(campaign.paramMapping, student, 'student');
        await sendMessage(
          { role: 'system', tenantId, userId: initiatedBy || 'system:campaign' } as Principal,
          {
            studentId: String(student._id),
            template: campaign.template,
            language: campaign.language,
            params,
          },
        );
        sent++;
      } catch (err: any) {
        logger.warn({ err: err?.message, studentId: student._id }, 'campaign message send failed');
        failed++;
      }
    }

    campaign.stats.sent = sent;
    campaign.stats.failed = failed;
    campaign.stats.skippedNoConsent = skippedNoConsent;
    campaign.status = 'completed';
    campaign.completedAt = new Date();
    await campaign.save();

    await audit(tenantId, {
      action: 'whatsapp.campaign_completed',
      entity: 'whatsapp_campaign',
      entityId: campaignId,
      meta: { stats: campaign.stats },
    });

    return campaign.toObject();
  } catch (err: any) {
    campaign.status = 'failed';
    campaign.failReason = err?.message || 'Campaign execution failed';
    await campaign.save();
    throw err;
  }
};

