import { env } from '../../../../config/env.js';
import { getPlatform } from '../../../../contracts/registry.js';
import { systemPrincipal } from '../../../../contracts/system.js';
import { httpRequest } from '../../../../shared/infra/http.js';
import { safeEqual } from '../../../../shared/infra/crypto.js';
import { logger } from '../../../../shared/infra/logger.js';
import { audit } from '../../audit/index.js';
import { createLead } from '../../leads/index.js';
import { leadAdsUtm, mapLeadFields } from '../domain/meta.domain.js';
import { MetaEventModel, MetaLeadLinkModel } from '../infrastructure/meta.model.js';
import { loadConfig, tokenOf } from './meta.config.js';

const OBJECT_ID = /^[a-f\d]{24}$/i;

/** The organisation must exist, have metaAds switched on and a saved config; otherwise the webhook does not exist (404). */
const activeConfig = async (tenantId: string) => {
  if (!OBJECT_ID.test(tenantId)) return null;
  try {
    if (!(await getPlatform().enabledModules(tenantId))['metaAds']) return null;
  } catch {
    return null;
  }
  return loadConfig(tenantId);
};

/** Meta's verification handshake (GET). Returns the challenge to echo, or null when it must be refused. */
export const verifyHandshake = async (tenantId: string, q: { mode?: string; token?: string; challenge?: string }): Promise<string | null> => {
  const c = await activeConfig(tenantId);
  if (!c || q.mode !== 'subscribe' || !q.token || !safeEqual(q.token, c.verifyToken)) return null;
  return q.challenge ?? '';
};

export const webhookAvailable = async (tenantId: string): Promise<boolean> => Boolean(await activeConfig(tenantId));

const collectLeadgen = (payload: any): Array<{ leadgenId: string; formId?: string; adId?: string }> => {
  const out: Array<{ leadgenId: string; formId?: string; adId?: string }> = [];
  for (const entry of payload?.entry ?? []) {
    for (const ch of entry?.changes ?? []) {
      const v = ch?.value;
      if (ch?.field === 'leadgen' && v?.leadgen_id) out.push({ leadgenId: String(v.leadgen_id), formId: v.form_id ? String(v.form_id) : undefined, adId: v.ad_id ? String(v.ad_id) : undefined });
    }
  }
  return out;
};

export const handleLeadgen = async (tenantId: string, payload: unknown) => {
  const c = await activeConfig(tenantId);
  if (!c) return { handled: 0, created: 0, duplicates: 0, failed: 0 };
  const items = collectLeadgen(payload);
  const result = { handled: items.length, created: 0, duplicates: 0, failed: 0 };
  const log = (doc: Record<string, unknown>) => MetaEventModel(tenantId).create({ kind: 'lead_ad', ...doc }).catch(() => undefined);

  for (const it of items) {
    try {
      if (!c.accessTokenEnc) throw new Error('No access token saved, cannot read the lead from Meta.');
      const url = `https://graph.facebook.com/${env.META_GRAPH_VERSION}/${encodeURIComponent(it.leadgenId)}?access_token=${encodeURIComponent(tokenOf(c))}`;
      const res = await httpRequest(url, { method: 'GET', timeoutMs: 8000 });
      if (!res.ok) throw new Error(`Meta answered ${res.status} when reading the lead.`);
      const mapped = mapLeadFields(res.data?.field_data ?? []);
      if (!mapped.phone) {
        result.failed++;
        await log({ eventName: 'leadgen', eventId: it.leadgenId, status: 'skipped', error: 'The form had no valid Indian mobile number.' });
        continue;
      }
      const out = await createLead(systemPrincipal(tenantId, 'meta-ads'), {
        name: mapped.name,
        phone: mapped.phone,
        email: mapped.email,
        city: mapped.city,
        source: { channel: 'meta_ads', ...leadAdsUtm({ form_id: it.formId, ad_id: it.adId }) },
        consent: { given: true, source: 'meta_lead_form' }, // submitting a Meta lead form shows Meta's disclosure
        autoAssign: true,
      });
      out.duplicate ? result.duplicates++ : result.created++;
      if (!out.duplicate) {
        // keep which campaign/ad this lead came from (Meta returns campaign_id/ad_id on the lead; the webhook has ad_id/form_id)
        const g = res.data ?? {};
        const str = (v: unknown) => (v ? String(v) : undefined);
        await MetaLeadLinkModel(tenantId)
          .updateOne(
            { leadgenId: it.leadgenId },
            { $setOnInsert: { leadgenId: it.leadgenId, leadId: String(out.lead._id), campaignId: str(g.campaign_id), campaignName: str(g.campaign_name)?.slice(0, 300), adsetId: str(g.adset_id), adId: str(g.ad_id) ?? it.adId, formId: str(g.form_id) ?? it.formId, at: new Date() } },
            { upsert: true },
          )
          .catch((err) => logger.error({ err, tenantId }, 'could not store the campaign of a meta lead'));
      }
      await log({ leadId: String(out.lead._id), eventName: 'leadgen', eventId: it.leadgenId, status: 'sent' });
    } catch (e: any) {
      result.failed++;
      logger.error({ err: e, tenantId }, 'meta lead ad could not be imported');
      await log({ eventName: 'leadgen', eventId: it.leadgenId, status: 'failed', error: String(e?.message ?? e).slice(0, 200) });
    }
  }
  await audit(tenantId, { action: 'meta.leadgen_received', entity: 'metaConfig', meta: result });
  return result;
};
