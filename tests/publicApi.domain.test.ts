import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  allowRequest, bearerToken, BACKOFF_MS, formatKey, hasScope, keyPrefix, MAX_ATTEMPTS, nextAttemptDelayMs, parseKey, signBody, webhookUrlProblem,
} from '../src/product/modules/publicApi/domain/publicApi.domain.js';

const T = 'a'.repeat(24);
const R = 'b'.repeat(48);

describe('API key format', () => {
  it('round-trips and rejects anything else', () => {
    const k = formatKey(T, R);
    expect(k).toBe(`cpk_${T}_${R}`);
    expect(parseKey(k)).toEqual({ tenantId: T, random: R });
    for (const bad of ['', undefined, null, 'cpk_x_y', `cpk_${T}_short`, `xxx_${T}_${R}`, `cpk_${T}_${R}extra`, `cpk_${'z'.repeat(24)}_${R}`]) expect(parseKey(bad as any)).toBeNull();
  });
  it('the display prefix does not reveal the secret', () => {
    expect(keyPrefix(T, R)).not.toContain(R);
  });
  it('reads a bearer header', () => {
    expect(bearerToken('Bearer abc')).toBe('abc');
    expect(bearerToken('bearer abc')).toBe('abc');
    expect(bearerToken('Basic abc')).toBeNull();
    expect(bearerToken(undefined)).toBeNull();
  });
  it('checks scopes', () => {
    expect(hasScope(['leads:create'], 'leads:create')).toBe(true);
    expect(hasScope(['leads:create'], 'colleges:read')).toBe(false);
    expect(hasScope(undefined, 'colleges:read')).toBe(false);
  });
});

describe('webhook URL guard (SSRF)', () => {
  it('accepts public https addresses', () => {
    for (const u of ['https://example.com/hook', 'https://hooks.partner.in:8443/x?y=1', 'https://8.8.8.8/h', 'https://[2606:4700:4700::1111]/h']) expect(webhookUrlProblem(u), u).toBeNull();
  });
  it('rejects non-https, credentials and garbage', () => {
    for (const u of ['http://example.com/h', 'ftp://example.com', 'not a url', '', 'https://user:pw@example.com/h', 'https://user@example.com/h', 'javascript:alert(1)']) expect(webhookUrlProblem(u), u).not.toBeNull();
  });
  it('rejects localhost, internal names and single-label hosts', () => {
    for (const u of ['https://localhost/h', 'https://LOCALHOST:3000/h', 'https://app.localhost/h', 'https://db.internal/h', 'https://printer.local/h', 'https://intranet/h', 'https://localhost./h']) expect(webhookUrlProblem(u), u).not.toBeNull();
  });
  it('rejects loopback, private, link-local and reserved IPv4 literals, including tricky spellings', () => {
    for (const u of [
      'https://127.0.0.1/h', 'https://127.1.2.3/h', 'https://10.0.0.5/h', 'https://172.16.0.1/h', 'https://172.31.255.255/h', 'https://192.168.1.1/h',
      'https://169.254.169.254/latest/meta-data', 'https://0.0.0.0/h', 'https://100.64.0.1/h', 'https://198.18.0.1/h', 'https://224.0.0.1/h', 'https://255.255.255.255/h',
      'https://2130706433/h', // decimal 127.0.0.1
      'https://0x7f.0.0.1/h', // hex
      'https://017700000001/h', // octal
      'https://127.1/h', // short form
    ]) expect(webhookUrlProblem(u), u).not.toBeNull();
    expect(webhookUrlProblem('https://172.32.0.1/h')).toBeNull();
    expect(webhookUrlProblem('https://11.0.0.1/h')).toBeNull();
  });
  it('rejects private IPv6 literals and IPv4-mapped private addresses', () => {
    for (const u of ['https://[::1]/h', 'https://[::]/h', 'https://[fc00::1]/h', 'https://[fd12:3456::1]/h', 'https://[fe80::1]/h', 'https://[::ffff:127.0.0.1]/h', 'https://[::ffff:10.0.0.1]/h', 'https://[::ffff:7f00:1]/h'])
      expect(webhookUrlProblem(u), u).not.toBeNull();
  });
});

describe('webhook signature', () => {
  it('is sha256= plus the hex HMAC of the exact body', () => {
    const body = '{"id":"1","event":"lead.created"}';
    expect(signBody('whsec_x', body)).toBe('sha256=' + createHmac('sha256', 'whsec_x').update(body).digest('hex'));
    expect(signBody('whsec_x', body)).not.toBe(signBody('whsec_y', body));
    expect(signBody('whsec_x', body + ' ')).not.toBe(signBody('whsec_x', body));
  });
});

describe('retry schedule', () => {
  it('backs off 1 min, 5 min, 30 min, 2 h and then gives up after 5 attempts', () => {
    expect(MAX_ATTEMPTS).toBe(5);
    expect(BACKOFF_MS).toEqual([60_000, 300_000, 1_800_000, 7_200_000]);
    expect([1, 2, 3, 4].map(nextAttemptDelayMs)).toEqual([60_000, 300_000, 1_800_000, 7_200_000]);
    expect(nextAttemptDelayMs(5)).toBeNull();
    expect(nextAttemptDelayMs(0)).toBeNull();
  });
});

describe('per-key rate limit', () => {
  it('allows up to the limit inside the window, then refuses, then recovers', () => {
    let hits: number[] = [];
    for (let i = 0; i < 3; i++) {
      const r = allowRequest(hits, 1000 + i, 3);
      expect(r.allowed).toBe(true);
      hits = r.hits;
    }
    expect(allowRequest(hits, 1010, 3).allowed).toBe(false);
    expect(allowRequest(hits, 1000 + 60_001, 3).allowed).toBe(true);
  });
});
