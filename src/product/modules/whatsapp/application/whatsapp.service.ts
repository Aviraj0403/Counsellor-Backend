import { env } from '../../../../config/env.js';
import { getPlatform } from '../../../../contracts/registry.js';
import type { Principal } from '../../../../contracts/port.js';
import { getJobQueue } from '../../../../shared/infra/queue.js';
import { logger } from '../../../../shared/infra/logger.js';
import { AppError, badRequest, forbidden, notFound } from '../../../../shared/kernel/errors.js';
import { audit } from '../../audit/index.js';
import { findLeadById } from '../../leads/index.js';
import { getStudent } from '../../students/index.js';
import {
  dedupeKey,
  dedupeSince,
  fillTemplate,
  placeholderCount,
  placeholdersAreSequential,
  templateComponents,
  toWhatsappNumber,
} from '../domain/whatsapp.domain.js';
import { MessageModel, TemplateModel } from '../infrastructure/whatsapp.model.js';
import { getWhatsAppProvider } from '../infrastructure/provider.js';

const isCounsellor = (p: Principal) => p.role === 'counsellor';

export interface Recipient {
  kind: 'lead' | 'student';
  id: string;
  name: string;
  phone: string;
  consent: boolean;
  assignedTo?: string;
  vars: { name: string; course?: string; city?: string };
}

export const resolveRecipient = async (tenantId: string, ref: { leadId?: string; studentId?: string }): Promise<Recipient> => {
  if (ref.leadId) {
    const l = await findLeadById(tenantId, ref.leadId);
    if (!l) throw notFound('Lead');
    return { kind: 'lead', id: String(l._id), name: l.name, phone: l.phone, consent: !!l.consent?.given, assignedTo: l.assignedTo, vars: { name: l.name, course: l.interestedCourse, city: l.city } };
  }
  if (ref.studentId) {
    const s = await getStudent(tenantId, ref.studentId);
    if (!s || s.status === 'erased') throw notFound('Student');
    return { kind: 'student', id: String(s._id), name: s.name, phone: s.phone, consent: !!s.consent?.given, assignedTo: s.assignedTo, vars: { name: s.name, city: s.address?.city, course: s.preferences?.courses?.[0] } };
  }
  throw badRequest('Choose a lead or a student to message.');
};

export const isConfigured = (): boolean => getWhatsAppProvider().isConfigured();

export interface SendInput {
  leadId?: string;
  studentId?: string;
  template: string;
  language?: string;
  params: string[];
  /** automation rules with a delay set this; the message waits as "queued" until dispatchDue() runs */
  sendAt?: Date;
}

/** Validates, de-duplicates and logs a message. Sends it now unless `sendAt` is in the future. */
export const sendMessage = async (p: Principal, input: SendInput, now = new Date()) => {
  const tenantId = p.tenantId!;
  const recipient = await resolveRecipient(tenantId, input);
  if (isCounsellor(p) && recipient.assignedTo !== p.userId) throw forbidden('You can only message people assigned to you.');
  if (!recipient.consent) throw badRequest('This person has not agreed to be contacted, so no WhatsApp message was sent.');

  const language = input.language ?? 'en';
  const tpl = await TemplateModel(tenantId).findOne({ name: input.template, language, active: true }).lean<any>();
  if (!tpl) throw notFound('Template');
  let text: string;
  try {
    text = fillTemplate(tpl.body, input.params);
  } catch (e) {
    throw badRequest((e as Error).message);
  }

  const key = dedupeKey(recipient.phone, tpl.name, language, input.params);
  const Message = MessageModel(tenantId);
  const dup = await Message.findOne({ dedupeKey: key, direction: 'out', status: { $ne: 'failed' }, createdAt: { $gte: dedupeSince(now) } }).lean<any>();
  if (dup) return { message: dup, duplicate: true };

  const later = input.sendAt && input.sendAt.getTime() > now.getTime();
  if (!later && !isConfigured()) throw new AppError(503, 'WHATSAPP_NOT_CONFIGURED', 'WhatsApp is not set up on the platform yet. Ask the platform team to add the WhatsApp credentials.');

  const doc = await Message.create({
    direction: 'out',
    [recipient.kind === 'lead' ? 'leadId' : 'studentId']: recipient.id,
    to: recipient.phone,
    template: tpl.name,
    language,
    params: input.params,
    text,
    status: 'queued',
    dedupeKey: key,
    sendAt: later ? input.sendAt : undefined,
    by: p.userId,
    at: now,
  });
  await audit(tenantId, { action: later ? 'whatsapp.queued' : 'whatsapp.send_requested', entity: 'whatsapp_message', entityId: String(doc._id), meta: { template: tpl.name, [recipient.kind + 'Id']: recipient.id } });
  if (later) {
    const delayMs = Math.max(0, input.sendAt!.getTime() - now.getTime());
    await getJobQueue().enqueue({ type: 'whatsapp:send', tenantId, messageId: String(doc._id) }, { delayMs });
    return { message: doc.toObject(), duplicate: false };
  }
  return { message: await deliver(tenantId, String(doc._id)), duplicate: false };
};

/** Calls the configured provider for one logged message, records the outcome and meters the cost for a successful send only. */
export const deliver = async (tenantId: string, messageId: string) => {
  const Message = MessageModel(tenantId);
  const m = await Message.findById(messageId);
  if (!m) throw notFound('Message');
  if (m.status !== 'queued') return m.toObject();
  let providerId: string | undefined;
  let error: string | undefined;
  const provider = getWhatsAppProvider();

  if (!provider.isConfigured()) {
    error = 'WhatsApp is not set up on the platform yet.';
  } else {
    try {
      const res = await provider.sendTemplate(m.to, m.template, m.language ?? 'en', m.params ?? []);
      providerId = res.providerId;
    } catch (err: any) {
      logger.warn({ err: err?.message, messageId }, 'whatsapp provider send failed');
      error = err?.message || 'Could not reach WhatsApp provider. Please try again.';
    }
  }
  if (providerId) {
    m.status = 'sent';
    m.providerId = providerId;
    m.error = undefined;
    await m.save();
    if (env.WHATSAPP_COST_PER_MESSAGE_PAISE > 0) {
      await getPlatform().recordUsage(tenantId, { category: 'whatsapp', amountPaise: env.WHATSAPP_COST_PER_MESSAGE_PAISE, note: `WhatsApp ${m.template}` });
    }
  } else {
    m.status = 'failed';
    m.error = error;
    await m.save();
  }
  return m.toObject();
};

/** Sends delayed (automation) messages that are due. Called by staff (POST /whatsapp/process-due) or any scheduler. */
export const dispatchDue = async (tenantId: string, now = new Date()): Promise<{ processed: number }> => {
  const due = await MessageModel(tenantId).find({ status: 'queued', sendAt: { $lte: now } }).limit(200).select('_id').lean<any[]>();
  for (const d of due) await deliver(tenantId, String(d._id));
  return { processed: due.length };
};

export const listMessages = async (p: Principal, q: { page: number; limit: number; leadId?: string; studentId?: string }) => {
  const filter: Record<string, unknown> = {};
  if (q.leadId) {
    if (isCounsellor(p)) {
      const l = await findLeadById(p.tenantId!, q.leadId);
      if (!l || l.assignedTo !== p.userId) throw forbidden('You can only see messages of leads assigned to you.');
    }
    filter.leadId = q.leadId;
  } else if (isCounsellor(p)) filter.by = p.userId;
  if (q.studentId) filter.studentId = q.studentId;
  const M = MessageModel(p.tenantId!);
  const [items, total] = await Promise.all([M.find(filter).sort({ at: -1 }).skip((q.page - 1) * q.limit).limit(q.limit).lean(), M.countDocuments(filter)]);
  return { items, total, page: q.page, limit: q.limit };
};

// ---- templates
export interface TemplateInput { name: string; language: string; body: string; purpose?: string; active?: boolean }

const checkBody = (body: string) => {
  if (!placeholdersAreSequential(body)) throw badRequest('Number the placeholders {{1}}, {{2}}, {{3}} in order, without gaps.');
};

export const listTemplates = (tenantId: string) => TemplateModel(tenantId).find().sort({ name: 1 }).lean();

export const createTemplate = async (p: Principal, input: TemplateInput) => {
  checkBody(input.body);
  try {
    const t = await TemplateModel(p.tenantId!).create(input);
    await audit(p.tenantId!, { action: 'whatsapp.template_created', entity: 'whatsapp_template', entityId: String(t._id), meta: { name: input.name } });
    return { ...t.toObject(), placeholders: placeholderCount(input.body) };
  } catch (e: any) {
    if (e?.code === 11000) throw new AppError(409, 'CONFLICT', 'A template with this name and language already exists.');
    throw e;
  }
};

export const updateTemplate = async (p: Principal, id: string, patch: Partial<TemplateInput>) => {
  if (patch.body !== undefined) checkBody(patch.body);
  const t = await TemplateModel(p.tenantId!).findByIdAndUpdate(id, { $set: patch }, { new: true }).lean<any>();
  if (!t) throw notFound('Template');
  await audit(p.tenantId!, { action: 'whatsapp.template_updated', entity: 'whatsapp_template', entityId: id, meta: { fields: Object.keys(patch) } });
  return t;
};

export const deleteTemplate = async (p: Principal, id: string) => {
  const t = await TemplateModel(p.tenantId!).findByIdAndDelete(id).lean<any>();
  if (!t) throw notFound('Template');
  await audit(p.tenantId!, { action: 'whatsapp.template_deleted', entity: 'whatsapp_template', entityId: id, meta: { name: t.name } });
  return { ok: true };
};
