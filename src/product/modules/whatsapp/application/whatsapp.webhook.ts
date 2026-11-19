import { env } from '../../../../config/env.js';
import { getPlatform } from '../../../../contracts/registry.js';
import { hmacHex, safeEqual } from '../../../../shared/infra/crypto.js';
import { normalizePhone } from '../../../../shared/kernel/phone.js';
import { audit } from '../../audit/index.js';
import { findLeadByPhone } from '../../leads/index.js';
import { nextStatus, type MessageStatus } from '../domain/whatsapp.domain.js';
import { MessageModel } from '../infrastructure/whatsapp.model.js';

/** `x-hub-signature-256: sha256=<hmac of the raw body with the Meta app secret>` */
export const verifySignature = (rawBody: Buffer | undefined, header: string | undefined): boolean => {
  if (!env.META_APP_SECRET || !rawBody || !header) return false;
  return safeEqual(`sha256=${hmacHex(env.META_APP_SECRET, rawBody)}`, header);
};

export const verifyHandshake = (mode: unknown, token: unknown): boolean =>
  mode === 'subscribe' && typeof token === 'string' && !!env.WHATSAPP_VERIFY_TOKEN && safeEqual(token, env.WHATSAPP_VERIFY_TOKEN);

const STATUS_MAP: Record<string, MessageStatus> = { sent: 'sent', delivered: 'delivered', read: 'read', failed: 'failed' };

/** The shared platform number means a callback does not say which organisation: look the message id up in each one. */
export const applyStatus = async (providerId: string, incoming: string, errorText?: string): Promise<boolean> => {
  const next = STATUS_MAP[incoming];
  if (!next) return false;
  for (const t of await getPlatform().listTenants()) {
    const M = MessageModel(t.id);
    const m = await M.findOne({ providerId });
    if (!m) continue;
    const status = nextStatus(m.status, next);
    if (status !== m.status) {
      m.status = status;
      if (status === 'failed') m.error = errorText ?? 'WhatsApp could not deliver this message.';
      await m.save();
      await audit(t.id, { action: 'whatsapp.status_updated', entity: 'whatsapp_message', entityId: String(m._id), meta: { status } });
    }
    return true;
  }
  return false;
};

/**
 * An inbound text is attached to the organisation that last messaged this number (the shared number cannot tell otherwise).
 * The text is kept in the WhatsApp message log, linked to the lead of the earlier outbound message (or found by phone number).
 */
export const recordInbound = async (fromDigits: string, text: string): Promise<boolean> => {
  const phone = normalizePhone(fromDigits);
  if (!phone) return false;
  for (const t of await getPlatform().listTenants()) {
    const M = MessageModel(t.id);
    const prev = await M.findOne({ to: phone, direction: 'out' }).sort({ at: -1 }).lean<any>();
    if (!prev) continue;
    await M.create({ direction: 'in', to: phone, leadId: prev.leadId ?? (await findLeadByPhone(t.id, phone))?._id, studentId: prev.studentId, text: text.slice(0, 1000), status: 'delivered' });
    return true;
  }
  return false;
};

export interface WebhookResult { statuses: number; inbound: number }

export const processWebhook = async (body: any): Promise<WebhookResult> => {
  const out: WebhookResult = { statuses: 0, inbound: 0 };
  for (const entry of body?.entry ?? []) {
    for (const ch of entry?.changes ?? []) {
      const v = ch?.value ?? {};
      for (const s of v.statuses ?? []) if (s?.id && (await applyStatus(String(s.id), String(s.status), s.errors?.[0]?.title))) out.statuses++;
      for (const m of v.messages ?? []) if (m?.type === 'text' && m.from && (await recordInbound(String(m.from), String(m.text?.body ?? '')))) out.inbound++;
    }
  }
  return out;
};
