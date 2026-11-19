/**
 * Pure helpers for server-rendered HTML. RULE: every dynamic value reaches the page ONLY through `esc` (text and
 * attribute values), `safeUrl` (links), `safeColor` (CSS colour) or `jsonLd` (script data). No exceptions.
 */

const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' };

/** Escapes text for element content AND for quoted attribute values. */
export const esc = (value: unknown): string => String(value ?? '').replace(/[&<>"'`]/g, (c) => HTML_ESCAPES[c]!);

/** Only absolute http(s) links are allowed (blocks javascript:, data:, ...). Returns '' when unsafe. */
export const safeUrl = (value: unknown): string => {
  const s = String(value ?? '').trim();
  return /^https?:\/\/[^\s<>"'`]+$/i.test(s) ? s : '';
};

/** A #rrggbb colour or the fallback. Prevents CSS injection through the theme colour. */
export const safeColor = (value: unknown, fallback = '#1d4ed8'): string => (/^#[0-9a-f]{6}$/i.test(String(value ?? '')) ? String(value) : fallback);

/** JSON for a <script type="application/ld+json"> block: cannot close the script tag or break out of it. */
export const jsonLd = (data: unknown): string =>
  JSON.stringify(data).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

export const formatInr = (paise: number): string => `Rs ${Math.round(paise / 100).toLocaleString('en-IN')}`;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const formatIntake = (i: { month?: number; year?: number }): string => `${MONTHS[(i.month ?? 1) - 1] ?? ''} ${i.year ?? ''}`.trim();

/** Trims to a search-snippet length at a word boundary. */
export const clip = (text: string, max: number): string => {
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), max - 20))}…`;
};
