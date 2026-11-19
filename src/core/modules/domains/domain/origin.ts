/**
 * Which browser "origins" (scheme + host [+ port]) may talk to this API. Pure rules, no database.
 * An origin is what a browser sends in the `Origin` header: https://counsellor.jdinfotechsolutions.in
 *
 * We accept only a CLEAN origin: no path, no query, no credentials, no wildcard, no IP address. Wildcards and IPs are how
 * "whitelists" quietly become "allow everyone", so they are refused at the door.
 */
export type OriginCheck = { ok: true; origin: string; host: string } | { ok: false; reason: string };

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;
const isIp = (host: string) => /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':'); // IPv4 or IPv6 literal
const isLocal = (host: string) => host === 'localhost' || host === '127.0.0.1';

export const normalizeOrigin = (input: string, opts: { production: boolean }): OriginCheck => {
  const raw = String(input ?? '').trim();
  if (!raw) return { ok: false, reason: 'Enter a domain, for example https://counsellor.example.com' };
  if (raw.includes('*')) return { ok: false, reason: 'Wildcards are not allowed. Add each domain by its exact address.' };

  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`); // "example.com" is taken as https://example.com
  } catch {
    return { ok: false, reason: 'This is not a valid web address.' };
  }

  if (url.username || url.password) return { ok: false, reason: 'Remove the username/password from the address.' };
  if ((url.pathname && url.pathname !== '/') || url.search || url.hash) return { ok: false, reason: 'Enter only the domain, without a page path (https://example.com, not https://example.com/login).' };

  const host = url.hostname.toLowerCase();
  const local = isLocal(host);
  if (url.protocol === 'http:') {
    if (opts.production || !local) return { ok: false, reason: 'Only https:// domains are allowed.' };
  } else if (url.protocol !== 'https:') {
    return { ok: false, reason: 'Only https:// domains are allowed.' };
  }

  if (!local) {
    if (isIp(host)) return { ok: false, reason: 'IP addresses are not allowed. Use a domain name.' };
    const labels = host.split('.');
    if (labels.length < 2 || host.length > 253 || !labels.every((l) => LABEL.test(l))) return { ok: false, reason: 'This is not a valid domain name.' };
  } else if (opts.production) {
    return { ok: false, reason: 'localhost is not allowed in production.' };
  }

  return { ok: true, origin: url.origin.toLowerCase(), host };
};

/** "a, b ,c" -> normalised, valid, de-duplicated origins. Invalid entries are skipped (a typo must not take the API down). */
export const parseOriginList = (raw: string | undefined, opts: { production: boolean }): string[] => {
  const out = new Set<string>();
  for (const part of (raw ?? '').split(',')) {
    const r = normalizeOrigin(part, opts);
    if (r.ok) out.add(r.origin);
  }
  return [...out];
};
