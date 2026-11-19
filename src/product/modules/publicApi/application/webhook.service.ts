import { randomUUID } from 'node:crypto';
import type { Principal } from '../../../../contracts/port.js';
import { getPlatform } from '../../../../contracts/registry.js';
import { decryptString, encryptString, randomToken } from '../../../../shared/infra/crypto.js';
import { httpRequest } from '../../../../shared/infra/http.js';
import { logger } from '../../../../shared/infra/logger.js';
import { subscribe, type DomainEvents } from '../../../../shared/kernel/events.js';
import { badRequest, notFound } from '../../../../shared/kernel/errors.js';
import { audit } from '../../audit/index.js';
import { MAX_ATTEMPTS, nextAttemptDelayMs, signBody, webhookUrlProblem, type WebhookEvent } from '../domain/publicApi.domain.js';
import { listTenantIds, WebhookDeliveryModel, WebhookModel } from '../infrastructure/publicApi.model.js';

const LEASE_MS = 60_000; // a delivery being sent is not picked up by another worker for this long
const TIMEOUT_MS = 5000;

const hookView = (w: any) => ({
  id: String(w._id),
  url: w.url,
  events: w.events as string[],
  active: Boolean(w.active),
  failureCount: w.failureCount ?? 0,
  createdAt: w.createdAt,
});

const deliveryView = (d: any) => ({
  id: String(d._id),
  webhookId: d.webhookId,
  event: d.event,
  status: d.status as string,
  attempts: d.attempts as number,
  responseCode: d.responseCode ?? null,
  error: d.error ?? null,
  nextAttemptAt: d.nextAttemptAt ?? null,
  at: d.at,
});

const urlOrThrow = (url: string) => {
  const problem = webhookUrlProblem(url);
  if (problem) throw badRequest(problem);
};

/** Creates a subscription. The signing secret is in the answer ONCE (stored encrypted). */
export const createWebhook = async (p: Principal, input: { url: string; events: WebhookEvent[] }) => {
  const tenantId = p.tenantId!;
  urlOrThrow(input.url);
  const secret = `whsec_${randomToken(24)}`;
  const w = await WebhookModel(tenantId).create({ url: input.url, events: [...new Set(input.events)], secretEnc: encryptString(secret), createdBy: p.userId });
  await audit(tenantId, { action: 'webhook.created', entity: 'webhook', entityId: String(w._id), meta: { url: input.url, events: input.events } });
  return { ...hookView(w.toObject()), secret };
};

export const listWebhooks = async (tenantId: string) => (await WebhookModel(tenantId).find().sort({ createdAt: -1 }).lean<any[]>()).map(hookView);

export const updateWebhook = async (p: Principal, id: string, input: { url?: string; events?: WebhookEvent[]; active?: boolean }) => {
  const tenantId = p.tenantId!;
  if (input.url !== undefined) urlOrThrow(input.url);
  const set: Record<string, unknown> = {};
  if (input.url !== undefined) set.url = input.url;
  if (input.events !== undefined) set.events = [...new Set(input.events)];
  if (input.active !== undefined) {
    set.active = input.active;
    if (input.active) set.failureCount = 0;
  }
  const w = await WebhookModel(tenantId).findByIdAndUpdate(id, { $set: set }, { new: true }).lean<any>();
  if (!w) throw notFound('Webhook');
  await audit(tenantId, { action: 'webhook.updated', entity: 'webhook', entityId: id, meta: { fields: Object.keys(set) } });
  return hookView(w);
};

export const deleteWebhook = async (p: Principal, id: string) => {
  const tenantId = p.tenantId!;
  const w = await WebhookModel(tenantId).findByIdAndDelete(id).lean<any>();
  if (!w) throw notFound('Webhook');
  await audit(tenantId, { action: 'webhook.deleted', entity: 'webhook', entityId: id, meta: { url: w.url } });
  return { ok: true };
};

export const listDeliveries = async (tenantId: string, q: { webhookId?: string; status?: string } = {}) => {
  const filter: Record<string, unknown> = {};
  if (q.webhookId) filter.webhookId = q.webhookId;
  if (q.status) filter.status = q.status;
  return (await WebhookDeliveryModel(tenantId).find(filter).sort({ at: -1 }).limit(100).lean<any[]>()).map(deliveryView);
};

// ---- sending
/** One signed POST. Records the outcome and schedules the next attempt (or gives up after MAX_ATTEMPTS). Never throws. */
const attempt = async (tenantId: string, delivery: any): Promise<void> => {
  const D = WebhookDeliveryModel(tenantId);
  const hook = await WebhookModel(tenantId).findById(delivery.webhookId).lean<any>();
  const attempts = (delivery.attempts ?? 0) + 1;
  let ok = false;
  let responseCode: number | undefined;
  let error: string | undefined;
  if (!hook || !hook.active) {
    error = 'The subscription was removed or switched off.';
  } else if (webhookUrlProblem(hook.url)) {
    error = 'The web address is not allowed.';
  } else {
    try {
      const res = await httpRequest(hook.url, {
        method: 'POST',
        body: delivery.body,
        timeoutMs: TIMEOUT_MS,
        headers: {
          'content-type': 'application/json',
          'x-cp-signature': signBody(decryptString(hook.secretEnc), delivery.body),
          'x-cp-event': delivery.event,
          'x-cp-delivery': String(delivery._id),
        },
      });
      responseCode = res.status;
      ok = res.ok;
      if (!ok) error = `The receiver answered ${res.status}.`;
    } catch (e: any) {
      error = `Could not reach the receiver: ${String(e?.message ?? e).slice(0, 200)}`;
    }
  }
  const gone = !hook || !hook.active;
  const delay = ok || gone ? null : nextAttemptDelayMs(attempts);
  const status = ok ? 'delivered' : delay === null ? 'failed' : 'retrying';
  const set: Record<string, unknown> = { status, attempts, lastAttemptAt: new Date() };
  const unset: Record<string, 1> = {};
  if (responseCode !== undefined) set.responseCode = responseCode;
  else unset.responseCode = 1;
  if (ok) unset.error = 1;
  else set.error = error;
  if (delay === null) unset.nextAttemptAt = 1;
  else set.nextAttemptAt = new Date(Date.now() + delay);
  await D.updateOne({ _id: delivery._id }, { $set: set, ...(Object.keys(unset).length ? { $unset: unset } : {}) });
  if (hook) await WebhookModel(tenantId).updateOne({ _id: hook._id }, ok ? { $set: { failureCount: 0 } } : { $inc: { failureCount: 1 } });
  if (!ok) logger.warn({ tenantId, event: delivery.event, attempts, responseCode }, 'webhook delivery failed');
};

const enqueue = async (tenantId: string, event: WebhookEvent, data: Record<string, unknown>, occurredAt = new Date()) => {
  const hooks = await WebhookModel(tenantId).find({ active: true, events: event }).lean<any[]>();
  if (!hooks.length) return;
  if (!(await getPlatform().enabledModules(tenantId))['publicApi']) return;
  for (const h of hooks) {
    const id = randomUUID();
    const body = JSON.stringify({ id, event, occurredAt: occurredAt.toISOString(), data });
    const d = await WebhookDeliveryModel(tenantId).create({ webhookId: String(h._id), event, eventId: id, body, status: 'retrying', attempts: 0, nextAttemptAt: new Date(Date.now() + LEASE_MS) });
    await attempt(tenantId, d.toObject());
  }
};

/** Sends every delivery that is due (one organisation, or all when no id is given). Returns how many were tried. */
export const retryDueDeliveries = async (tenantId?: string, now = new Date()): Promise<{ tried: number; delivered: number }> => {
  const tenants = tenantId ? [tenantId] : await listTenantIds();
  let tried = 0;
  let delivered = 0;
  for (const t of tenants) {
    const D = WebhookDeliveryModel(t);
    const due = await D.find({ status: 'retrying', nextAttemptAt: { $lte: now } }).limit(100).lean<any[]>();
    for (const d of due) {
      // claim it so two workers (or two clicks) do not send the same delivery twice
      const claimed = await D.findOneAndUpdate({ _id: d._id, status: 'retrying', nextAttemptAt: { $lte: now } }, { $set: { nextAttemptAt: new Date(now.getTime() + LEASE_MS) } }, { new: true }).lean<any>();
      if (!claimed) continue;
      tried++;
      await attempt(t, claimed);
      if ((await D.findById(d._id).lean<any>())?.status === 'delivered') delivered++;
    }
  }
  return { tried, delivered };
};

/** Staff "retry now" for one delivery. A finished-failed delivery gets a fresh set of attempts. */
export const retryDelivery = async (p: Principal, id: string) => {
  const tenantId = p.tenantId!;
  const D = WebhookDeliveryModel(tenantId);
  const cur = await D.findById(id).lean<any>();
  if (!cur) throw notFound('Delivery');
  if (cur.status === 'delivered') throw badRequest('This delivery already succeeded.');
  const claimed = await D.findOneAndUpdate({ _id: id, status: { $in: ['retrying', 'failed'] } }, { $set: { status: 'retrying', attempts: cur.status === 'failed' ? 0 : cur.attempts, nextAttemptAt: new Date(Date.now() + LEASE_MS) } }, { new: true }).lean<any>();
  if (!claimed) throw badRequest('This delivery cannot be retried now.');
  await attempt(tenantId, claimed);
  await audit(tenantId, { action: 'webhook.delivery_retried', entity: 'webhookDelivery', entityId: id });
  return deliveryView((await D.findById(id).lean<any>())!);
};

export { MAX_ATTEMPTS };

// ---- background work: handlers return immediately; tests await settle()
const pending = new Set<Promise<unknown>>();
const background = (p: Promise<unknown>) => {
  const t = p.catch((err) => logger.error({ err }, 'webhook dispatch failed')).finally(() => pending.delete(t));
  pending.add(t);
};
export const settle = async (): Promise<void> => {
  while (pending.size) await Promise.all([...pending]);
};

const on = <K extends WebhookEvent & keyof DomainEvents>(name: K, data: (e: DomainEvents[K]) => Record<string, unknown>) =>
  subscribe(name, (e) => background(enqueue((e as any).tenantId, name, data(e))));

export const registerEvents = (): void => {
  on('lead.created', (e) => ({ leadId: e.leadId, channel: e.channel }));
  on('lead.stage_changed', (e) => ({ leadId: e.leadId, from: e.from, to: e.to }));
  on('application.created', (e) => ({ applicationId: e.applicationId, studentId: e.studentId, collegeId: e.collegeId }));
  on('application.status_changed', (e) => ({ applicationId: e.applicationId, studentId: e.studentId, collegeId: e.collegeId, from: e.from, to: e.to }));
  on('document.verified', (e) => ({ documentId: e.documentId, studentId: e.studentId, applicationId: e.applicationId ?? null }));
};
