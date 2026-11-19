import { createHmac } from 'node:crypto';

/** Pure rules of the public API: key format, scopes, the webhook URL guard (SSRF), signing and the retry schedule. */

export const SCOPES = ['leads:create', 'colleges:read', 'applications:read', 'applications:update'] as const;
export type Scope = (typeof SCOPES)[number];
export const isScope = (s: string): s is Scope => (SCOPES as readonly string[]).includes(s);

export const WEBHOOK_EVENTS = ['lead.created', 'lead.stage_changed', 'application.created', 'application.status_changed', 'document.verified'] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];
export const isWebhookEvent = (s: string): s is WebhookEvent => (WEBHOOK_EVENTS as readonly string[]).includes(s);

// ---- API keys: cpk_<tenantId>_<random>
const KEY_RE = /^cpk_([a-f\d]{24})_([a-f\d]{48})$/;

export const formatKey = (tenantId: string, random: string): string => `cpk_${tenantId}_${random}`;

/** Splits a presented key. Returns null for anything that is not shaped like a key (no database lookup is needed to refuse it). */
export const parseKey = (raw: string | undefined | null): { tenantId: string; random: string } | null => {
  const m = KEY_RE.exec((raw ?? '').trim());
  return m ? { tenantId: m[1]!.toLowerCase(), random: m[2]! } : null;
};

/** The harmless part shown in lists so a key can be recognised: cpk_<first 8 of tenant>...<last 4 of random>. */
export const keyPrefix = (tenantId: string, random: string): string => `cpk_${tenantId.slice(0, 8)}…${random.slice(-4)}`;

export const bearerToken = (header: string | undefined): string | null => {
  const m = /^Bearer\s+(\S+)$/i.exec(header ?? '');
  return m ? m[1]! : null;
};

export const hasScope = (scopes: readonly string[] | undefined, needed: Scope): boolean => Boolean(scopes?.includes(needed));

// ---- webhook URL guard (SSRF)
const v4 = (host: string): number[] | null => {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.every((n) => n <= 255) ? parts : null;
};

const privateV4 = ([a, b, c]: number[]): boolean =>
  a === 0 || a === 10 || a === 127 ||
  (a === 100 && b! >= 64 && b! <= 127) || // carrier-grade NAT
  (a === 169 && b === 254) || // link-local, cloud metadata
  (a === 172 && b! >= 16 && b! <= 31) ||
  (a === 192 && b === 0 && c === 0) ||
  (a === 192 && b === 168) ||
  (a === 198 && (b === 18 || b === 19)) ||
  a! >= 224; // multicast, reserved, broadcast

const privateV6 = (host: string): boolean => {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === '::' || h === '::1') return true;
  if (/^f[cd][0-9a-f]{2}:/.test(h)) return true; // unique local fc00::/7
  if (/^fe[89ab][0-9a-f]:/.test(h)) return true; // link-local fe80::/10
  const mapped = /^::ffff:(.+)$/.exec(h); // IPv4-mapped
  if (mapped) {
    const dotted = v4(mapped[1]!);
    if (dotted) return privateV4(dotted);
    return true; // hex form of a mapped address: refuse, nobody needs it
  }
  return false;
};

/** Returns a plain-language problem, or null when the URL is acceptable as a webhook target. */
export const webhookUrlProblem = (raw: string): string | null => {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return 'Enter a full web address, for example https://example.com/hooks.';
  }
  if (u.protocol !== 'https:') return 'The web address must start with https://.';
  if (u.username || u.password) return 'The web address must not contain a username or password.';
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (!host) return 'The web address has no host name.';
  if (host.startsWith('[')) return privateV6(host) ? 'That address points to a private or internal network.' : null;
  const ip = v4(host);
  if (ip) return privateV4(ip) ? 'That address points to a private or internal network.' : null;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.lan') || host.endsWith('.home.arpa'))
    return 'That address points to this machine or a private network.';
  if (!host.includes('.')) return 'Use a public domain name (for example hooks.example.com).';
  return null;
};

// ---- signing
export const signBody = (secret: string, body: string): string => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

// ---- retry schedule
export const MAX_ATTEMPTS = 5;
/** Wait before attempt N+1, indexed by attempts already made (1..4). After the 5th failed attempt there is no next one. */
export const BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3_600_000] as const;

export const nextAttemptDelayMs = (attemptsMade: number): number | null => (attemptsMade >= MAX_ATTEMPTS || attemptsMade < 1 ? null : BACKOFF_MS[attemptsMade - 1]!);

// ---- per-key rate limit (in-process sliding window)
export const RATE_LIMIT_PER_MINUTE = 60;
export const allowRequest = (hits: number[], now: number, limit = RATE_LIMIT_PER_MINUTE, windowMs = 60_000): { allowed: boolean; hits: number[] } => {
  const recent = hits.filter((t) => now - t < windowMs);
  if (recent.length >= limit) return { allowed: false, hits: recent };
  return { allowed: true, hits: [...recent, now] };
};
