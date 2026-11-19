import { createHash } from 'node:crypto';

/** Pure WhatsApp rules: no database, no network. */

export const MESSAGE_STATUSES = ['queued', 'sent', 'failed', 'delivered', 'read'] as const;
export type MessageStatus = (typeof MESSAGE_STATUSES)[number];

export const RULE_EVENTS = ['lead.created', 'lead.stage_changed', 'application.status_changed'] as const;
export type RuleEvent = (typeof RULE_EVENTS)[number];

/** Identical sends (same number, template and values) inside this window are treated as one. */
export const DEDUPE_WINDOW_MS = 10 * 60 * 1000;

const PLACEHOLDER = /\{\{\s*(\d+)\s*\}\}/g;

/** Highest placeholder number in a template body: "Hi {{1}}, {{2}}" needs 2 values. */
export const placeholderCount = (body: string): number => {
  let max = 0;
  for (const m of body.matchAll(PLACEHOLDER)) max = Math.max(max, Number(m[1]));
  return max;
};

/** Templates must number their placeholders 1..n without gaps (WhatsApp rejects anything else). */
export const placeholdersAreSequential = (body: string): boolean => {
  const used = new Set<number>();
  for (const m of body.matchAll(PLACEHOLDER)) used.add(Number(m[1]));
  const n = placeholderCount(body);
  for (let i = 1; i <= n; i++) if (!used.has(i)) return false;
  return true;
};

/** Fills {{1}}, {{2}}... with params. Throws a plain message when the number of values does not match. */
export const fillTemplate = (body: string, params: string[]): string => {
  const need = placeholderCount(body);
  if (params.length < need) throw new Error(`This template needs ${need} value${need === 1 ? '' : 's'} but ${params.length} ${params.length === 1 ? 'was' : 'were'} given.`);
  if (params.length > need) throw new Error(`This template takes ${need} value${need === 1 ? '' : 's'} but ${params.length} were given.`);
  return body.replace(PLACEHOLDER, (_m, n: string) => params[Number(n) - 1] ?? '');
};

/** The body component of a WhatsApp Cloud API template message. */
export const templateComponents = (params: string[]) =>
  params.length === 0 ? [] : [{ type: 'body', parameters: params.map((text) => ({ type: 'text', text })) }];

/** WhatsApp wants digits only with country code: "+919876543210" -> "919876543210". */
export const toWhatsappNumber = (phone: string): string => phone.replace(/\D/g, '');

/** Same recipient + template + language + values = same key. */
export const dedupeKey = (to: string, template: string, language: string, params: string[]): string =>
  createHash('sha256').update([to, template, language, ...params].join('\u0001')).digest('hex');

export const dedupeSince = (now: Date): Date => new Date(now.getTime() - DEDUPE_WINDOW_MS);

const RANK: Record<MessageStatus, number> = { queued: 0, sent: 1, delivered: 2, read: 3, failed: 4 };

/**
 * Status callbacks can arrive out of order ("read" before "delivered"). Never go backwards;
 * "failed" only replaces a message that was not already delivered or read.
 */
export const nextStatus = (current: MessageStatus, incoming: MessageStatus): MessageStatus => {
  if (incoming === 'failed') return current === 'delivered' || current === 'read' ? current : 'failed';
  if (current === 'failed') return incoming === 'queued' ? current : incoming;
  return RANK[incoming] > RANK[current] ? incoming : current;
};

export interface RuleLike {
  event: RuleEvent;
  filter?: string | null;
  active: boolean;
}
export interface EventLike {
  event: RuleEvent;
  /** the thing a filter compares with: lead.created -> channel, lead.stage_changed -> new stage, application.status_changed -> new status */
  value: string;
}

/** An active rule fires when the event matches and its filter (if any) equals the event's value. */
export const ruleMatches = (rule: RuleLike, ev: EventLike): boolean => {
  if (!rule.active || rule.event !== ev.event) return false;
  const f = (rule.filter ?? '').trim();
  return f === '' || f === ev.value;
};

/** Rule params can use {name}, {course}, {city}: they are replaced with the lead's / student's details. */
export const resolveRuleParams = (params: string[], vars: Record<string, string | undefined>): string[] =>
  params.map((p) => p.replace(/\{(name|course|city)\}/g, (_m, k: string) => vars[k] ?? ''));
