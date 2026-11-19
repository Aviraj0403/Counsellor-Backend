import { describe, expect, it } from 'vitest';
import { compareRows, depthProblem, maskEmail, maskPhone, MAX_DEPTH, mergePage, parseDay, sumRecordValues, sumRecords } from '../src/product/modules/central/domain/central.domain.js';

describe('masking', () => {
  it('shows only the country code and the last 3 digits of a phone', () => {
    expect(maskPhone('+919876543210')).toBe('+91 ••••• ••210');
    expect(maskPhone('9876543210')).toBe('+91 ••••• ••210');
  });
  it('never reveals more than 3 digits and handles odd input', () => {
    expect(maskPhone(undefined)).toBeNull();
    expect(maskPhone('')).toBeNull();
    expect(maskPhone('12')).toBe('••••');
    const m = maskPhone('+441234567890')!;
    expect(m.replace(/\D/g, '').length).toBeLessThanOrEqual(3);
  });
  it('keeps the first letter and the domain of an email', () => {
    expect(maskEmail('ravi.kumar@gmail.com')).toBe('r•••@gmail.com');
    expect(maskEmail(undefined)).toBeNull();
    expect(maskEmail('no-at-sign')).toBe('•••');
    expect(maskEmail('ravi.kumar@gmail.com')).not.toContain('ravi');
  });
});

describe('merge and paging across organisations', () => {
  const row = (id: string, at: string) => ({ id, createdAt: new Date(at) });
  it('sorts newest first, ties by id descending', () => {
    const rows = [row('a', '2026-01-01'), row('c', '2026-01-02'), row('b', '2026-01-02')];
    expect(rows.sort(compareRows).map((r) => r.id)).toEqual(['c', 'b', 'a']);
  });
  it('walking every page yields each row exactly once, in a stable order', () => {
    // three organisations, many identical timestamps on purpose
    const mk = (prefix: string, n: number) =>
      Array.from({ length: n }, (_, i) => row(`${prefix}${String(i).padStart(3, '0')}`, `2026-02-${String((i % 5) + 1).padStart(2, '0')}T10:00:00Z`)).sort(compareRows);
    const orgs = [mk('a', 23), mk('b', 17), mk('c', 9)];
    const all = orgs.flat().sort(compareRows).map((r) => r.id);
    const limit = 7;
    const seen: string[] = [];
    for (let page = 1; page <= Math.ceil(all.length / limit); page++) {
      // each organisation only supplies its first page*limit rows, as the service does
      seen.push(...mergePage(orgs.map((o) => o.slice(0, page * limit)), page, limit).map((r) => r.id));
    }
    expect(seen).toEqual(all);
    expect(new Set(seen).size).toBe(49);
  });
  it('a page past the end is empty', () => {
    expect(mergePage([[row('a', '2026-01-01')]], 3, 10)).toEqual([]);
  });
  it('refuses to page deeper than the cap', () => {
    expect(depthProblem(1, 50)).toBeNull();
    expect(depthProblem(MAX_DEPTH / 50, 50)).toBeNull();
    expect(depthProblem(MAX_DEPTH / 50 + 1, 50)).toMatch(/narrow the filters/i);
  });
});

describe('filters and sums', () => {
  it('a date-only "to" covers the whole day; bad dates are null', () => {
    expect(parseDay('2026-11-05', false)!.toISOString()).toBe('2026-11-05T00:00:00.000Z');
    expect(parseDay('2026-11-05', true)!.toISOString()).toBe('2026-11-05T23:59:59.999Z');
    expect(parseDay(undefined, true)).toBeUndefined();
    expect(parseDay('nonsense', false)).toBeNull();
  });
  it('sums counts by key', () => {
    expect(sumRecords({ a: 1 }, { a: 2, b: 3 })).toEqual({ a: 3, b: 3 });
    expect(sumRecordValues({ a: 3, b: 4 })).toBe(7);
  });
});
