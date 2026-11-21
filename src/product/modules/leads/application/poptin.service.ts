import { getPlatform } from '../../../../contracts/registry.js';
import { systemPrincipal } from '../../../../contracts/system.js';
import { badRequest, notFound } from '../../../../shared/kernel/errors.js';
import { audit } from '../../audit/index.js';
import { createLead } from './lead.service.js';
import { PoptinConfigModel } from '../infrastructure/poptin.model.js';

export interface PoptinConfigInput {
  enabled?: boolean;
  headline?: string;
  subheadline?: string;
  allowedDomains?: string[];
  triggers?: {
    exitIntent?: boolean;
    timeDelaySeconds?: number;
    scrollPercentage?: number;
  };
  design?: {
    themeColor?: string;
    buttonText?: string;
    buttonColor?: string;
    buttonTextColor?: string;
    backgroundColor?: string;
    textColor?: string;
  };
}

/** Get tenant poptin configuration for CRM staff */
export const getPoptinConfig = async (tenantId: string) => {
  const M = PoptinConfigModel(tenantId);
  let doc = await M.findOne({ key: 'default' }).lean<any>();
  if (!doc) {
    doc = (await M.create({ key: 'default' })).toObject();
  }
  return doc;
};

/** Save tenant poptin configuration */
export const savePoptinConfig = async (tenantId: string, input: PoptinConfigInput, actorId?: string) => {
  const M = PoptinConfigModel(tenantId);
  const doc = await M.findOneAndUpdate(
    { key: 'default' },
    { $set: input },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  ).lean<any>();

  await audit(tenantId, {
    action: 'leads.poptin_config_updated',
    entity: 'poptin_config',
    entityId: String(doc._id),
    meta: { enabled: doc.enabled },
  });

  return doc;
};

/** Public lookup by tenant slug for client embed script */
export const getPublicPoptinConfig = async (slug: string, origin?: string) => {
  const tenant = await getPlatform().findTenantBySlug(slug);
  if (!tenant || tenant.status === 'suspended') return null;

  const config = await getPoptinConfig(tenant.id);
  if (!config.enabled) return null;

  // Domain security verification
  if (config.allowedDomains && config.allowedDomains.length > 0 && origin) {
    const isAllowed = config.allowedDomains.some((d: string) =>
      origin.includes(d) || origin.includes('localhost') || origin.includes('127.0.0.1')
    );
    if (!isAllowed) return null;
  }

  return {
    tenantId: tenant.id,
    orgName: tenant.name,
    headline: config.headline,
    subheadline: config.subheadline,
    triggers: config.triggers,
    design: config.design,
  };
};

/** Record impression view */
export const recordImpression = async (slug: string) => {
  const tenant = await getPlatform().findTenantBySlug(slug);
  if (!tenant) throw notFound('Organisation');
  await PoptinConfigModel(tenant.id).updateOne({ key: 'default' }, { $inc: { viewsCount: 1 } });
  return { ok: true };
};

export interface PublicPoptinSubmission {
  name: string;
  phone: string;
  email?: string;
  city?: string;
  interestedCourse?: string;
  sourceUrl?: string;
}

/** Capture lead from poptin modal directly into CRM */
export const capturePoptinLead = async (slug: string, input: PublicPoptinSubmission) => {
  const tenant = await getPlatform().findTenantBySlug(slug);
  if (!tenant) throw notFound('Organisation');

  const config = await getPoptinConfig(tenant.id);
  if (!config.enabled) throw badRequest('Lead capture popups are currently disabled for this organisation.');

  // Create lead in CRM with automated counsellor round-robin assignment
  const { lead, duplicate } = await createLead(systemPrincipal(tenant.id, 'poptin-popup'), {
    name: input.name,
    phone: input.phone,
    email: input.email,
    city: input.city,
    interestedCourse: input.interestedCourse,
    source: {
      channel: 'website',
      utmSource: 'poptin_popup',
      utmMedium: 'exit_intent_widget',
    },
    consent: {
      given: true,
      source: `poptin:${input.sourceUrl || 'direct'}`,
    },
    autoAssign: true,
  });

  if (!duplicate) {
    await PoptinConfigModel(tenant.id).updateOne({ key: 'default' }, { $inc: { conversionsCount: 1 } });
  }

  return { leadId: String(lead._id), duplicate };
};

