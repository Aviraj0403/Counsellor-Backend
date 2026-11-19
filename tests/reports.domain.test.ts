import { describe, expect, it } from 'vitest';
import { buildByCollege, buildByStatus, buildCounsellors, buildFunnel, buildSources, collectionRate, parseRange, pct, sumValues } from '../src/product/modules/reports/domain/reports.domain.js';

const finite = (o: unknown): boolean => !JSON.stringify(o).includes('null') && !/NaN|Infinity/.test(String(JSON.stringify(o)));

describe('pct', () => {
  it('rounds to one decimal and never returns NaN', () => {
    expect(pct(1, 3)).toBe(33.3);
    expect(pct(2, 3)).toBe(66.7);
    expect(pct(5, 0)).toBe(0);
    expect(pct(0, 0)).toBe(0);
    expect(pct(NaN, 4)).toBe(0);
    expect(pct(3, Infinity)).toBe(0);
    expect(pct(-1, -2)).toBe(0);
  });
  it('sumValues ignores non finite numbers', () => {
    expect(sumValues({ a: 2, b: 3, c: NaN })).toBe(5);
  });
});

describe('buildFunnel', () => {
  it('computes reached and conversion, lost leads stay in the total', () => {
    const f = buildFunnel({ new: 1, contacted: 1, admitted: 1, lost: 1 });
    expect(f).toMatchObject({ total: 4, lost: 1, admitted: 1, conversionPct: 25 });
    expect(f.steps.map((s) => [s.stage, s.count, s.reached, s.ofTotalPct, s.ofPreviousPct])).toEqual([
      ['new', 1, 4, 100, 100],
      ['contacted', 1, 2, 50, 50],
      ['qualified', 0, 1, 25, 50],
      ['counselling_done', 0, 1, 25, 100],
      ['application_started', 0, 1, 25, 100],
      ['admitted', 1, 1, 25, 100],
    ]);
  });
  it('is all zeros for no leads', () => {
    const f = buildFunnel({});
    expect(f.total).toBe(0);
    expect(f.conversionPct).toBe(0);
    expect(f.steps.every((s) => s.reached === 0 && s.ofTotalPct === 0 && s.ofPreviousPct === 0)).toBe(true);
    expect(finite(f)).toBe(true);
  });
});

describe('buildSources', () => {
  it('per channel conversion, sorted by leads', () => {
    const rows = buildSources({ meta_ads: { new: 1, lost: 1 }, website: { contacted: 1, admitted: 2 } });
    expect(rows[0]).toMatchObject({ channel: 'website', leads: 3, contacted: 3, admitted: 2, conversionPct: 66.7, contactedPct: 100 });
    expect(rows[1]).toMatchObject({ channel: 'meta_ads', leads: 2, contacted: 1, admitted: 0, lost: 1, conversionPct: 0, contactedPct: 50 });
    expect(buildSources({})).toEqual([]);
  });
});

describe('counsellors, colleges, statuses', () => {
  it('names counsellors, handles unassigned and unknown ids', () => {
    const rows = buildCounsellors({ u1: 3, unassigned: 1, gone: 1 }, { u1: 'Asha' });
    expect(rows.map((r) => [r.name, r.applications, r.sharePct])).toEqual([
      ['Asha', 3, 60],
      ['Former team member', 1, 20],
      ['Unassigned', 1, 20],
    ]);
    expect(buildCounsellors({}, {})).toEqual([]);
  });
  it('by college and by status', () => {
    expect(buildByCollege({ c1: 3, c2: 1 }, { c1: 'Delta' })).toEqual([
      { id: 'c1', name: 'Delta', applications: 3, sharePct: 75 },
      { id: 'c2', name: 'Other college', applications: 1, sharePct: 25 },
    ]);
    expect(buildByStatus({ draft: 1, fee_paid: 3 })).toEqual({
      total: 4,
      items: [
        { status: 'fee_paid', count: 3, sharePct: 75 },
        { status: 'draft', count: 1, sharePct: 25 },
      ],
    });
    expect(buildByStatus({})).toEqual({ total: 0, items: [] });
  });
});

describe('parseRange and collectionRate', () => {
  it('a plain end date includes that whole day', () => {
    const r = parseRange('2026-11-01', '2026-11-30');
    expect(r.from?.toISOString()).toBe('2026-11-01T00:00:00.000Z');
    expect(r.to?.toISOString()).toBe('2026-12-01T00:00:00.000Z');
    expect(parseRange()).toEqual({});
  });
  it('collection rate is safe with no accruals', () => {
    expect(collectionRate(0, 0)).toBe(0);
    expect(collectionRate(50, 200)).toBe(25);
  });
});
