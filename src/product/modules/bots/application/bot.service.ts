import { env } from '../../../../config/env.js';
import { getPlatform } from '../../../../contracts/registry.js';
import { AppError, badRequest } from '../../../../shared/kernel/errors.js';
import { publish } from '../../../../shared/kernel/events.js';
import { randomToken, sha256Hex } from '../../../../shared/infra/crypto.js';
import { audit } from '../../audit/index.js';
import {
  HANDOFF_REPLY,
  HISTORY_WINDOW,
  MAX_MESSAGE_CHARS,
  MAX_STORED_MESSAGES,
  dayKey,
  detectMinor,
  expiryFor,
  handoffFromMessage,
  maskPii,
  monthKey,
  pickLeastLoaded,
  sanitizeReply,
  type Channel,
  type HandoffReason,
} from '../domain/bots.domain.js';
import { costPaise } from '../domain/pricing.js';
import { buildSystemPrompt } from '../domain/prompt.js';
import { TOOL_DEFS } from './tools.js';
import { BotUsageModel, ConversationModel } from '../infrastructure/bots.model.js';
import { getLlmClient, type LlmMessage, type LlmResult } from '../infrastructure/llm.js';
import { loadSettings, effectiveKeywords, type BotSettings } from './bot.settings.js';
import { loadLeadAssignee, refreshScore, runTool, teamCounsellors, type ToolContext } from './bot.tools.js';

const MAX_TOOL_ROUNDS = 4;
const OFFLINE_REPLY = 'Our assistant is offline right now. Please leave your name and phone number with the office, and a counsellor will contact you.';
const LIMIT_REPLY = 'Our assistant has reached its limit for now. A counsellor will help you; please try again later or contact the office.';
const CLOSED_REPLY = 'This chat has been closed. Please start a new chat if you need more help.';
const WAITING_REPLY = 'A counsellor has been notified and will reply to you shortly.';

export interface TurnInput {
  tenantId: string;
  orgName: string;
  channel: Channel;
  text: string;
  /** web: the token the widget kept from the first answer */
  visitorToken?: string;
  /** whatsapp: the sender's phone digits (the conversation key) */
  externalKey?: string;
  /** staff test console: continue this conversation */
  conversationId?: string;
  /** the visitor ticked / accepted the consent line (required to start a web conversation) */
  consent?: boolean;
}

export interface TurnResult {
  reply: string;
  conversationId: string;
  /** web: send this back with the next message. Only returned when a conversation starts. */
  visitorToken?: string;
  status: string;
  handedOff: boolean;
  handoffReason?: string;
  offline?: boolean;
  limited?: boolean;
}

// ---- one turn at a time per conversation (two quick messages must not overwrite each other)
const locks = new Map<string, Promise<unknown>>();
const withLock = async <T>(key: string, fn: () => Promise<T>): Promise<T> => {
  const prev = locks.get(key) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(fn);
  locks.set(key, next);
  try {
    return await next;
  } finally {
    if (locks.get(key) === next) locks.delete(key);
  }
};

const bump = async (tenantId: string, inc: Record<string, number>) => {
  await BotUsageModel(tenantId).updateOne({ day: dayKey(new Date()) }, { $inc: inc, $setOnInsert: { day: dayKey(new Date()) } }, { upsert: true });
};

/** Messages and spend so far today / this month, for the caps. */
export const usageSoFar = async (tenantId: string, now = new Date()) => {
  const M = BotUsageModel(tenantId);
  const today = await M.findOne({ day: dayKey(now) }).lean<any>();
  const month = await M.aggregate([{ $match: { day: { $regex: `^${monthKey(now)}` } } }, { $group: { _id: null, costPaise: { $sum: '$costPaise' } } }]);
  return { todayMessages: (today?.messages as number) ?? 0, monthCostPaise: (month[0]?.costPaise as number) ?? 0 };
};

const hashKey = (channel: Channel, key: string) => sha256Hex(`${channel}:${key}`);

const newConversation = async (i: TurnInput, settings: BotSettings, token: string | undefined) => {
  const now = new Date();
  const conv = await ConversationModel(i.tenantId).create({
    channel: i.channel,
    visitorTokenHash: i.channel === 'whatsapp' ? hashKey('whatsapp', i.externalKey ?? '') : token ? sha256Hex(token) : sha256Hex(randomToken(8)),
    consent: { given: true, at: now },
    expiresAt: expiryFor(now, settings.retentionDays),
    messages: [],
  });
  await bump(i.tenantId, { conversations: 1 });
  await audit(i.tenantId, { action: 'bot.conversation_started', entity: 'botConversation', entityId: String(conv._id), meta: { channel: i.channel } });
  return conv;
};

/** Finds the visitor's conversation or starts one. Never trusts a client-chosen id: web uses a server-issued secret token. */
const resolveConversation = async (i: TurnInput, settings: BotSettings): Promise<{ conv: any; token?: string }> => {
  const M = ConversationModel(i.tenantId);
  const now = new Date();
  if (i.channel === 'staff_test') {
    if (i.conversationId && /^[a-f\d]{24}$/i.test(i.conversationId)) {
      const found = await M.findOne({ _id: i.conversationId, channel: 'staff_test' });
      if (found) return { conv: found };
    }
    return { conv: await newConversation(i, settings, undefined) };
  }
  if (i.channel === 'whatsapp') {
    const found = await M.findOne({ channel: 'whatsapp', visitorTokenHash: hashKey('whatsapp', i.externalKey ?? ''), status: { $ne: 'closed' }, expiresAt: { $gt: now } }).sort({ lastMessageAt: -1 });
    return { conv: found ?? (await newConversation(i, settings, undefined)) };
  }
  if (i.visitorToken) {
    const found = await M.findOne({ channel: 'web', visitorTokenHash: sha256Hex(i.visitorToken), expiresAt: { $gt: now } });
    if (found) return { conv: found };
  }
  if (!i.consent) throw new AppError(400, 'CONSENT_REQUIRED', 'Please accept the consent line before chatting.', { consentText: settings.consentText });
  const token = randomToken(24);
  return { conv: await newConversation(i, settings, token), token };
};

const pushMessage = (conv: any, role: 'user' | 'assistant', text: string, toolSummary?: string) => {
  conv.messages.push({ role, text, at: new Date(), toolSummary: toolSummary || undefined });
  if (conv.messages.length > MAX_STORED_MESSAGES) conv.messages.splice(0, conv.messages.length - MAX_STORED_MESSAGES);
};

/** What the model sees of earlier turns: the stored (masked) transcript, last few messages, starting with a student message. */
const historyFor = (conv: any): LlmMessage[] => {
  const rows = (conv.messages as any[]).filter((m) => m.role === 'user' || m.role === 'assistant').slice(-HISTORY_WINDOW);
  while (rows.length && rows[0].role !== 'user') rows.shift();
  return rows.map((m) => ({ role: m.role, content: m.text }));
};

const finalize = async (ctx: ToolContext, text: string, reply: string, extras: { usage?: { in: number; out: number }; handoff?: HandoffReason; offline?: boolean; limited?: boolean }) => {
  const { conv, tenantId } = ctx;
  const keep = { phones: ctx.turn.keepPhones, emails: ctx.turn.keepEmails };
  pushMessage(conv, 'user', maskPii(text, keep));
  pushMessage(conv, 'assistant', reply, ctx.turn.summary.join(', '));
  const now = new Date();
  conv.lastMessageAt = now;
  conv.userTurns = (conv.userTurns ?? 0) + 1;
  refreshScore(conv);
  let cost = 0;
  if (extras.usage && (extras.usage.in || extras.usage.out)) {
    const model = getLlmClient()?.model ?? env.AI_MODEL;
    cost = costPaise(model, { inputTokens: extras.usage.in, outputTokens: extras.usage.out }, env.AI_INR_PER_USD);
    conv.tokens.in += extras.usage.in;
    conv.tokens.out += extras.usage.out;
    conv.costPaise += cost;
  }
  const handedOffNow = !!extras.handoff && conv.status === 'open';
  if (handedOffNow) await applyHandoff(ctx, extras.handoff!);
  const settings = await loadSettings(tenantId);
  conv.expiresAt = expiryFor(now, settings.retentionDays);
  await conv.save();
  await bump(tenantId, {
    messages: extras.offline || extras.limited ? 0 : 1,
    tokensIn: extras.usage?.in ?? 0,
    tokensOut: extras.usage?.out ?? 0,
    costPaise: cost,
    leadsCaptured: ctx.turn.newLead ? 1 : 0,
    bookings: ctx.turn.booked ? 1 : 0,
    handoffs: handedOffNow ? 1 : 0,
  });
  if (cost > 0) await getPlatform().recordUsage(tenantId, { category: 'ai', amountPaise: cost, note: `AI assistant (${getLlmClient()?.model ?? env.AI_MODEL})` });
};

/** Marks the conversation handed off, picks the counsellor, announces it. The caller saves the document. */
const applyHandoff = async (ctx: ToolContext, reason: string) => {
  const { conv, tenantId } = ctx;
  conv.status = 'handed_off';
  let assignee = await loadLeadAssignee(tenantId, conv.leadId);
  if (!assignee) {
    const team = await teamCounsellors(tenantId);
    const rows = await ConversationModel(tenantId).aggregate([{ $match: { status: 'handed_off', 'handoff.assignedTo': { $exists: true } } }, { $group: { _id: '$handoff.assignedTo', n: { $sum: 1 } } }]);
    assignee = pickLeastLoaded(team, new Map(rows.map((r: any) => [String(r._id), r.n as number])));
  }
  conv.handoff = { at: new Date(), reason, assignedTo: assignee };
  await audit(tenantId, { action: 'bot.handoff', entity: 'botConversation', entityId: String(conv._id), meta: { reason, assignedTo: assignee } });
  await publish('bot.handoff', { tenantId, conversationId: String(conv._id), reason, leadId: conv.leadId, assigneeId: assignee });
};

const ensureDisclosure = (reply: string, firstTurn: boolean): string => (firstTurn && !/\bAI\b|artificial intelligence/i.test(reply) ? `I am an AI assistant. ${reply}` : reply);

/** The whole model conversation for one student message, including tool rounds. Returns what to say and what happened. */
const converse = async (ctx: ToolContext, i: TurnInput, settings: BotSettings, minorMode: boolean) => {
  const llm = getLlmClient()!;
  const system = buildSystemPrompt({
    botName: settings.name,
    orgName: i.orgName,
    languages: settings.languages,
    workingHoursNote: settings.workingHoursNote,
    minorMode,
    today: new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10),
  });
  const messages: LlmMessage[] = [...historyFor(ctx.conv), { role: 'user', content: i.text }];
  const usage = { in: 0, out: 0 };
  let text = '';
  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    let res: LlmResult;
    try {
      res = await llm.complete({ system, messages, tools: TOOL_DEFS as never, maxTokens: 1500, effort: 'low' });
    } catch {
      return { failed: 'model_failed' as const, usage };
    }
    usage.in += res.usage.inputTokens;
    usage.out += res.usage.outputTokens;
    if (res.stopReason === 'refusal') return { failed: 'model_refused' as const, usage };
    if (res.stopReason === 'max_tokens' && res.toolCalls.length) return { failed: 'model_failed' as const, usage }; // tool input may be cut off: never run it
    if (res.stopReason === 'tool_use' || (res.toolCalls.length && res.stopReason === 'end_turn')) {
      if (round === MAX_TOOL_ROUNDS) return { failed: 'model_failed' as const, usage };
      messages.push({ role: 'assistant', content: res.rawContent ?? [...(res.text ? [{ type: 'text', text: res.text }] : []), ...res.toolCalls.map((t) => ({ type: 'tool_use', id: t.id, name: t.name, input: t.input }))] });
      const results = [];
      for (const call of res.toolCalls) {
        const r = await runTool(ctx, call.name, call.input);
        results.push({ type: 'tool_result', tool_use_id: call.id, content: r.content, ...(r.isError ? { is_error: true } : {}) });
      }
      messages.push({ role: 'user', content: results });
      continue;
    }
    text = res.text;
    if (!text.trim()) return { failed: 'model_failed' as const, usage };
    break;
  }
  return { text, usage };
};

/** One student message in, one reply out. Everything the bot does for a student goes through here. */
export const handleTurn = async (i: TurnInput): Promise<TurnResult> => {
  const text = i.text.trim().slice(0, MAX_MESSAGE_CHARS);
  if (!text) throw badRequest('Please type a message.');
  const settings = await loadSettings(i.tenantId);
  const { conv, token } = await resolveConversation(i, settings);
  const lockKey = `${i.tenantId}:${conv._id}`;
  return withLock(lockKey, async () => {
    const fresh = await ConversationModel(i.tenantId).findById(conv._id); // inside the lock: the latest saved state
    if (!fresh) throw new AppError(404, 'NOT_FOUND', 'Conversation not found.');
    const c = fresh;
    const ctx: ToolContext = { tenantId: i.tenantId, conv: c, turn: { newLead: false, booked: false, keepPhones: [], keepEmails: [], summary: [] } };
    const result = (reply: string, extra: Partial<TurnResult> = {}): TurnResult => ({
      reply,
      conversationId: String(c._id),
      visitorToken: token,
      status: c.status,
      handedOff: c.status === 'handed_off',
      handoffReason: c.handoff?.reason ?? undefined,
      ...extra,
    });

    if (c.status === 'closed') return result(CLOSED_REPLY);
    const firstTurn = (c.userTurns ?? 0) === 0;

    // A person has the conversation: record the message, no model call.
    if (c.status === 'handed_off') {
      await finalize(ctx, text, WAITING_REPLY, {});
      return result(WAITING_REPLY);
    }

    // minors (DPDP): detect from what they typed
    const signal = detectMinor(text);
    if (signal.suspected && !c.minor.suspected) {
      c.minor.suspected = true;
      c.minor.sinceTurn = c.userTurns ?? 0;
    }
    const minorTurns = c.minor.suspected ? (c.userTurns ?? 0) + 1 - (c.minor.sinceTurn ?? 0) : 0;

    // rule-based hand-off BEFORE any model call
    const rule = handoffFromMessage({ text, keywords: effectiveKeywords(settings), minor: { suspected: !!c.minor.suspected, guardianConsent: !!c.minor.guardianConsent }, minorTurns });
    if (rule) {
      if (rule === 'human_request') c.askedForCounsellor = true;
      await finalize(ctx, text, HANDOFF_REPLY[rule], { handoff: rule });
      return result(HANDOFF_REPLY[rule]);
    }

    // offline / caps
    if (!getLlmClient()) {
      await finalize(ctx, text, OFFLINE_REPLY, { offline: true });
      return result(OFFLINE_REPLY, { offline: true });
    }
    const used = await usageSoFar(i.tenantId);
    if ((settings.dailyMessageCap > 0 && used.todayMessages >= settings.dailyMessageCap) || (settings.monthlyBudgetPaise > 0 && used.monthCostPaise >= settings.monthlyBudgetPaise)) {
      await finalize(ctx, text, LIMIT_REPLY, { limited: true });
      return result(LIMIT_REPLY, { limited: true });
    }

    const out = await converse(ctx, i, settings, !!c.minor.suspected && !c.minor.guardianConsent);
    if ('failed' in out && out.failed) {
      await finalize(ctx, text, HANDOFF_REPLY[out.failed], { usage: out.usage, handoff: out.failed });
      return result(HANDOFF_REPLY[out.failed]);
    }
    const reply = ensureDisclosure(sanitizeReply(out.text ?? ''), firstTurn) || HANDOFF_REPLY.low_confidence;
    if (ctx.turn.handoffRequested) {
      await finalize(ctx, text, reply, { usage: out.usage, handoff: 'low_confidence' });
    } else {
      await finalize(ctx, text, reply, { usage: out.usage });
    }
    return result(reply);
  });
};

/** Public chat settings shown by the widget before the first message. */
export const publicBotConfig = async (tenantId: string) => {
  const s = await loadSettings(tenantId);
  return { name: s.name, greeting: s.greeting, consentText: s.consentText, languages: s.languages, maxMessageChars: MAX_MESSAGE_CHARS, workingHoursNote: s.workingHoursNote };
};
