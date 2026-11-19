import { env } from '../../../../config/env.js';
import { getPlatform } from '../../../../contracts/registry.js';
import { httpRequest } from '../../../../shared/infra/http.js';
import { logger } from '../../../../shared/infra/logger.js';
import { subscribe } from '../../../../shared/kernel/events.js';
import { findLeadById } from '../../leads/index.js';
import { buildConversionEvent, eventIdFor, eventNameFor, hashEmail, hasUserData } from '../domain/meta.domain.js';
import { MetaEventModel } from '../infrastructure/meta.model.js';
import { loadConfig, tokenOf } from './meta.config.js';

const eventsUrl = (pixelId: string) => `https://graph.facebook.com/${env.META_GRAPH_VERSION}/${encodeURIComponent(pixelId)}/events`;

/** Sends one event to the Conversions API. Never throws: the outcome is returned (and recorded by the caller). One retry on failure. */
const post = async (config: any, event: object, testEventCode?: string) => {
  const body = { data: [event], access_token: tokenOf(config), ...(testEventCode ? { test_event_code: testEventCode } : {}) };
  let attempts = 0;
  let status: number | undefined;
  let error: string | undefined;
  while (attempts < 2) {
    attempts++;
    try {
      const res = await httpRequest(eventsUrl(config.pixelId), { method: 'POST', body, timeoutMs: 5000 });
      status = res.status;
      if (res.ok) return { ok: true, attempts, status };
      error = `Meta answered ${res.status}: ${String(res.data?.error?.message ?? res.text ?? '').slice(0, 200)}`;
    } catch (e: any) {
      error = `Could not reach Meta: ${String(e?.message ?? e).slice(0, 200)}`;
    }
  }
  return { ok: false, attempts, status, error };
};

const record = (tenantId: string, doc: Record<string, unknown>) =>
  MetaEventModel(tenantId).create(doc).catch((err) => logger.error({ err }, 'could not record meta event'));

const usable = (c: any) => c && c.enabled && c.pixelId && c.accessTokenEnc;

const sendForLead = async (tenantId: string, leadId: string, trigger: 'created' | { stage: string }) => {
  const config = await loadConfig(tenantId);
  if (!usable(config)) return;
  if (!(await getPlatform().enabledModules(tenantId))['metaAds']) return;
  const eventName = eventNameFor(config.eventMap, trigger);
  if (!eventName) return;
  const eventId = eventIdFor(leadId, eventName);
  if (await MetaEventModel(tenantId).exists({ eventId, status: 'sent', kind: 'conversion' })) return; // already told Meta
  const lead = await findLeadById(tenantId, leadId);
  if (!lead) return;
  const event = buildConversionEvent({ leadId, eventName, email: lead.email, phone: lead.phone, timeSeconds: Math.floor(Date.now() / 1000) });
  if (!hasUserData(event)) {
    await record(tenantId, { kind: 'conversion', leadId, eventName, eventId, status: 'skipped', error: 'The lead has no email or valid phone to match.' });
    return;
  }
  const out = await post(config, event);
  await record(tenantId, { kind: 'conversion', leadId, eventName, eventId, status: out.ok ? 'sent' : 'failed', attempts: out.attempts, httpStatus: out.status, error: out.error });
};

/** Sends a test event (shows up in Meta's "Test events" tab using the configured test code). */
export const sendTestEvent = async (tenantId: string) => {
  const config = await loadConfig(tenantId);
  if (!config?.pixelId || !config?.accessTokenEnc) return { ok: false, message: 'Save the Pixel ID and the access token first.' };
  if (!config.testEventCode) return { ok: false, message: 'Add a test event code (from Meta Events Manager, Test events tab) first.' };
  const eventName = 'Lead';
  const eventId = `test_${Date.now()}`;
  const event = { ...buildConversionEvent({ leadId: eventId, eventName, timeSeconds: Math.floor(Date.now() / 1000) }), event_id: eventId, user_data: { em: [hashEmail('test@example.com')] } };
  const out = await post(config, event, config.testEventCode);
  await record(tenantId, { kind: 'test', eventName, eventId, status: out.ok ? 'sent' : 'failed', attempts: out.attempts, httpStatus: out.status, error: out.error });
  return { ok: out.ok, message: out.ok ? 'Test event sent. Check the Test events tab in Meta Events Manager.' : out.error ?? 'Meta did not accept the event.' };
};

export const listEvents = async (tenantId: string) =>
  MetaEventModel(tenantId).find().sort({ at: -1 }).limit(100).lean<any[]>();

// ---- background work: handlers return immediately; tests await settle()
const pending = new Set<Promise<unknown>>();
const background = (p: Promise<unknown>) => {
  const t = p.catch((err) => logger.error({ err }, 'meta conversion failed')).finally(() => pending.delete(t));
  pending.add(t);
};
export const settle = async (): Promise<void> => {
  while (pending.size) await Promise.all([...pending]);
};

export const registerEvents = (): void => {
  subscribe('lead.created', (e) => background(sendForLead(e.tenantId, e.leadId, 'created')));
  subscribe('lead.stage_changed', (e) => background(sendForLead(e.tenantId, e.leadId, { stage: e.to })));
};
