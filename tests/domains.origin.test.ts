import { describe, expect, it } from 'vitest';
import { normalizeOrigin, parseOriginList } from '../src/core/modules/domains/domain/origin.js';

const prod = { production: true };
const dev = { production: false };

describe('normalizeOrigin', () => {
  it('accepts the platform domain and normalises case and trailing slash', () => {
    expect(normalizeOrigin('https://counsellor.jdinfotechsolutions.in', prod)).toMatchObject({ ok: true, origin: 'https://counsellor.jdinfotechsolutions.in' });
    expect(normalizeOrigin('HTTPS://Counsellor.JDInfotechSolutions.in/', prod)).toMatchObject({ ok: true, origin: 'https://counsellor.jdinfotechsolutions.in' });
  });
  it('a bare domain is taken as https', () => {
    expect(normalizeOrigin('counsellor.example.com', prod)).toMatchObject({ ok: true, origin: 'https://counsellor.example.com' });
  });
  it('keeps an explicit port and drops the default one', () => {
    expect(normalizeOrigin('https://app.example.com:8443', prod)).toMatchObject({ ok: true, origin: 'https://app.example.com:8443' });
    expect(normalizeOrigin('https://app.example.com:443', prod)).toMatchObject({ ok: true, origin: 'https://app.example.com' });
  });
  it.each([
    ['wildcard', 'https://*.example.com'],
    ['wildcard in the middle', 'https://a*.example.com'],
    ['a page path', 'https://example.com/login'],
    ['a query string', 'https://example.com/?a=1'],
    ['a fragment', 'https://example.com/#x'],
    ['credentials', 'https://user:pass@example.com'],
    ['an IPv4 address', 'https://203.0.113.10'],
    ['an IPv6 address', 'https://[2001:db8::1]'],
    ['no dot (single label)', 'https://intranet'],
    ['a bad label', 'https://-bad.example.com'],
    ['an empty value', '   '],
    ['another scheme', 'ftp://example.com'],
    ['javascript scheme', 'javascript://example.com/%0aalert(1)'],
  ])('rejects %s', (_name, value) => {
    expect(normalizeOrigin(value, prod).ok).toBe(false);
  });
  it('plain http is refused in production and for real domains, but localhost works in development', () => {
    expect(normalizeOrigin('http://example.com', prod).ok).toBe(false);
    expect(normalizeOrigin('http://example.com', dev).ok).toBe(false);
    expect(normalizeOrigin('http://localhost:5173', prod).ok).toBe(false);
    expect(normalizeOrigin('http://localhost:5173', dev)).toMatchObject({ ok: true, origin: 'http://localhost:5173' });
    expect(normalizeOrigin('http://127.0.0.1:3000', dev)).toMatchObject({ ok: true });
  });
  it('explains problems in plain language', () => {
    const r = normalizeOrigin('https://*.example.com', prod);
    expect(r.ok === false && r.reason).toMatch(/Wildcards are not allowed/);
  });
});

describe('parseOriginList', () => {
  it('splits, normalises, de-duplicates and silently skips bad entries', () => {
    expect(parseOriginList('https://a.example.com, https://A.example.com/ ,nonsense value,https://b.example.com', prod)).toEqual(['https://a.example.com', 'https://b.example.com']);
    expect(parseOriginList(undefined, prod)).toEqual([]);
  });
});
