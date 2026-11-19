/** Pure rules for the platform "Central data" view: masking, cross-organisation merge and paging, date filters. No database, no HTTP. */

export const CENTRAL_RESOURCES = ['leads', 'students', 'applications', 'documents'] as const;
export type CentralResource = (typeof CENTRAL_RESOURCES)[number];

/** At most this many organisations are read per request. More than that: the response says `truncated: true` (or the caller names one organisation). */
export const MAX_ORGANISATIONS = 100;
/** page * limit may not exceed this: every organisation is asked for its first page*limit rows, so depth is the cost driver. Narrow the filters instead of paging deeper. */
export const MAX_DEPTH = 500;

const BULLET = '•';

/** "+91 ••••• ••123": country code and the last 3 digits only. Anything unreadable becomes "••••". */
export const maskPhone = (phone?: string | null): string | null => {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 4) return BULLET.repeat(4);
  const national = digits.length >= 10 ? digits.slice(-10) : digits;
  const last3 = national.slice(-3);
  if (national.length === 10 && (digits.length === 10 || digits.startsWith('91'))) return `+91 ${BULLET.repeat(5)} ${BULLET.repeat(2)}${last3}`;
  return `${BULLET.repeat(4)}${last3}`;
};

/** "r•••@gmail.com": first letter of the name part and the full domain. */
export const maskEmail = (email?: string | null): string | null => {
  if (!email) return null;
  const at = email.lastIndexOf('@');
  if (at < 1) return `${BULLET.repeat(3)}`;
  return `${email[0]}${BULLET.repeat(3)}${email.slice(at)}`;
};

export interface Mergeable {
  id: string;
  createdAt: Date | string;
}

const ms = (d: Date | string) => new Date(d).getTime();

/** Newest first; equal times fall back to the id (descending) so the order never depends on which organisation answered first. */
export const compareRows = (a: Mergeable, b: Mergeable): number => {
  const d = ms(b.createdAt) - ms(a.createdAt);
  if (d !== 0) return d;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
};

/**
 * Correct cross-organisation paging: every organisation supplies its own first `page * limit` rows (already newest first),
 * the lists are merged with a total order and the requested slice is cut out. Walking page 1..N therefore yields every row once.
 */
export const mergePage = <T extends Mergeable>(perOrganisation: T[][], page: number, limit: number): T[] =>
  perOrganisation.flat().sort(compareRows).slice((page - 1) * limit, page * limit);

/** null when fine, otherwise a plain-English reason. */
export const depthProblem = (page: number, limit: number): string | null =>
  page * limit > MAX_DEPTH ? `Please narrow the filters: Central data can page at most ${MAX_DEPTH} rows deep (page ${page} x ${limit} is too far).` : null;

/** "2026-11-01" means the whole day (to = end of that day, UTC); a full timestamp is used as given. null when unreadable. */
export const parseDay = (value: string | undefined, end: boolean): Date | null | undefined => {
  if (!value) return undefined;
  const dayOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const d = new Date(dayOnly ? `${value}T${end ? '23:59:59.999' : '00:00:00.000'}Z` : value);
  return Number.isNaN(d.getTime()) ? null : d;
};

export const sumRecords = (target: Record<string, number>, add: Record<string, number>): Record<string, number> => {
  for (const [k, v] of Object.entries(add)) target[k] = (target[k] ?? 0) + v;
  return target;
};

export const sumRecordValues = (r: Record<string, number>): number => Object.values(r).reduce((a, b) => a + b, 0);
