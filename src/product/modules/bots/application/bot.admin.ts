import { env } from '../../../../config/env.js';
import type { Principal } from '../../../../contracts/port.js';
import { conflict, notFound } from '../../../../shared/kernel/errors.js';
import { audit } from '../../audit/index.js';
import { dayKey, type Band, type Channel, type ConvStatus } from '../domain/bots.domain.js';
import { BotUsageModel, ConversationModel } from '../infrastructure/bots.model.js';
import { isLlmConfigured } from '../infrastructure/llm.js';
import { loadSettings } from './bot.settings.js';
import { usageSoFar } from './bot.service.js';

/** A counsellor only sees conversations handed to them; everyone else with bots:read sees the whole organisation. */
const visibility = (p: Principal) => (p.role === 'counsellor' ? { 'handoff.assignedTo': p.userId } : {});

const summaryRow = (c: any) => ({
  id: String(c._id),
  channel: c.channel,
  status: c.status,
  band: c.band,
  score: c.score,
  language: c.language,
  qualification: c.qualification ?? {},
  leadId: c.leadId,
  handoff: c.handoff?.at ? { at: c.handoff.at, reason: c.handoff.reason, assignedTo: c.handoff.assignedTo, takenOverBy: c.handoff.takenOverBy } : null,
  minorSuspected: !!c.minor?.suspected,
  messageCount: c.messages?.length ?? 0,
  lastText: c.messages?.length ? String(c.messages[c.messages.length - 1].text).slice(0, 140) : '',
  lastMessageAt: c.lastMessageAt,
  createdAt: c.createdAt,
});

export interface ConversationQuery {
  page: number;
  limit: number;
  status?: ConvStatus;
  band?: Band;
  channel?: Channel;
  from?: Date;
  to?: Date;
}

export const listConversations = async (p: Principal, q: ConversationQuery) => {
  const filter: Record<string, unknown> = { ...visibility(p), erasedAt: { $exists: false } };
  if (q.status) filter.status = q.status;
  if (q.band) filter.band = q.band;
  if (q.channel) filter.channel = q.channel;
  if (q.from || q.to) filter.lastMessageAt = { ...(q.from ? { $gte: q.from } : {}), ...(q.to ? { $lte: q.to } : {}) };
  const M = ConversationModel(p.tenantId!);
  const [rows, total] = await Promise.all([
    M.find(filter).select('-messages.toolSummary').sort({ lastMessageAt: -1 }).skip((q.page - 1) * q.limit).limit(q.limit).lean(),
    M.countDocuments(filter),
  ]);
  return { items: rows.map(summaryRow), total, page: q.page, limit: q.limit };
};

export const getConversation = async (p: Principal, id: string) => {
  const c = await ConversationModel(p.tenantId!).findOne({ _id: id, ...visibility(p) }).lean<any>();
  if (!c) throw notFound('Conversation');
  return { ...summaryRow(c), scoreReasons: c.scoreReasons ?? [], guardian: c.guardian ?? null, consent: c.consent, tokens: c.tokens, costPaise: c.costPaise, expiresAt: c.expiresAt, messages: c.messages ?? [] };
};

export const takeover = async (p: Principal, id: string) => {
  const M = ConversationModel(p.tenantId!);
  const c = await M.findOne({ _id: id, ...visibility(p) });
  if (!c) throw notFound('Conversation');
  if (c.status === 'closed') throw conflict('This conversation is closed.');
  c.status = 'handed_off';
  c.handoff = { ...(c.handoff?.toObject?.() ?? {}), at: c.handoff?.at ?? new Date(), reason: c.handoff?.reason ?? 'staff_takeover', assignedTo: c.handoff?.assignedTo ?? p.userId, takenOverBy: p.userId };
  await c.save();
  await audit(p.tenantId!, { action: 'bot.takeover', entity: 'botConversation', entityId: id });
  return { id, status: c.status };
};

export const closeConversation = async (p: Principal, id: string) => {
  const c = await ConversationModel(p.tenantId!).findOne({ _id: id, ...visibility(p) });
  if (!c) throw notFound('Conversation');
  c.status = 'closed';
  await c.save();
  await audit(p.tenantId!, { action: 'bot.closed', entity: 'botConversation', entityId: id });
  return { id, status: 'closed' };
};

export const summary = async (p: Principal, range: { from?: Date; to?: Date }) => {
  const tenantId = p.tenantId!;
  const now = new Date();
  const from = dayKey(range.from ?? new Date(now.getFullYear(), now.getMonth(), 1));
  const to = dayKey(range.to ?? now);
  const rows = await BotUsageModel(tenantId).find({ day: { $gte: from, $lte: to } }).lean<any[]>();
  const sum = (k: string) => rows.reduce((n, r) => n + (r[k] ?? 0), 0);
  const conversations = sum('conversations');
  const handoffs = sum('handoffs');
  const settings = await loadSettings(tenantId);
  const used = await usageSoFar(tenantId, now);
  return {
    from,
    to,
    conversations,
    messages: sum('messages'),
    leadsCaptured: sum('leadsCaptured'),
    bookingsViaBot: sum('bookings'),
    handoffs,
    handoffRate: conversations ? Math.round((handoffs / conversations) * 1000) / 10 : 0,
    bookingRate: conversations ? Math.round((sum('bookings') / conversations) * 1000) / 10 : 0,
    costPaise: sum('costPaise'),
    monthCostPaise: used.monthCostPaise,
    monthlyBudgetPaise: settings.monthlyBudgetPaise,
    todayMessages: used.todayMessages,
    dailyMessageCap: settings.dailyMessageCap,
    configured: isLlmConfigured(),
    model: env.AI_MODEL,
    note: 'Handoff and booking rates are measured from this organisation\'s own chats; no uplift over other channels is claimed.',
  };
};

/** Deletes expired conversations now (the database also does it in the background). */
export const purgeExpired = async (p: Principal, now = new Date()) => {
  const r = await ConversationModel(p.tenantId!).deleteMany({ expiresAt: { $lte: now } });
  await audit(p.tenantId!, { action: 'bot.purged', entity: 'botConversation', meta: { deleted: r.deletedCount } });
  return { deleted: r.deletedCount };
};
