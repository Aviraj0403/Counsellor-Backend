import { describe, expect, it } from 'vitest';
import { MODULE_CATALOG } from '../src/core/modules/catalog/domain/moduleCatalog.js';
import { resolveModules } from '../src/core/modules/catalog/domain/resolve.js';
import { GST_RATE_BPS, PERIOD_RE, computeCharge, currentPeriod, rupeesToPaise } from '../src/core/modules/billing/domain/billing.domain.js';
import { conversionPct, funnelRow, sumCounts } from '../src/product/modules/insights/domain/insights.domain.js';

const on = (flags: Record<string, boolean>) => resolveModules(MODULE_CATALOG, flags);
const ledgerPrice = MODULE_CATALOG.find((m) => m.key === 'ledger')!.priceMonthlyInr!;

describe('computeCharge', () => {
  it('bills nothing when there is no plan and no priced add-on is on', () => {
    const c = computeCharge({ plan: null, enabled: on({}), catalog: MODULE_CATALOG });
    expect(c.lines).toEqual([]);
    expect(c.totalPaise).toBe(0);
  });

  it('plan base price + a live add-on, with GST on top, all in integer paise', () => {
    const c = computeCharge({ plan: { name: 'Starter', basePricePaise: 1_999_00, includedModules: [] }, enabled: on({ ledger: true }), catalog: MODULE_CATALOG });
    expect(c.lines.map((l) => l.code)).toEqual(['plan', 'module:ledger']);
    expect(c.subtotalPaise).toBe(199_900 + ledgerPrice * 100);
    expect(c.gstPaise).toBe(Math.round((c.subtotalPaise * GST_RATE_BPS) / 10_000));
    expect(c.totalPaise).toBe(c.subtotalPaise + c.gstPaise);
    for (const n of [c.subtotalPaise, c.gstPaise, c.totalPaise]) expect(Number.isInteger(n)).toBe(true);
  });

  it('never bills a module that is "coming soon", even when switched on', () => {
    // synthetic catalogue: which real modules are "soon" changes as features ship, this rule must not depend on that
    const catalog = [
      ...MODULE_CATALOG.filter((m) => m.key === 'leads'),
      { key: 'whatsapp', label: 'Future thing', whatItDoes: 'x', group: 'channels', optIn: true, priceMonthlyInr: 999, stage: 'soon' },
    ] as typeof MODULE_CATALOG;
    const c = computeCharge({ plan: null, enabled: { leads: true, whatsapp: true }, catalog });
    expect(c.lines).toEqual([]);
    const live = computeCharge({ plan: null, enabled: { whatsapp: true }, catalog: [{ ...catalog[1]!, stage: 'live' }] });
    expect(live.lines.map((l) => l.code)).toEqual(['module:whatsapp']); // the same module IS billed once it is live
  });

  it('does not bill modules the plan already includes', () => {
    const c = computeCharge({ plan: { name: 'Pro', basePricePaise: 500_000, includedModules: ['ledger'] }, enabled: on({ ledger: true }), catalog: MODULE_CATALOG });
    expect(c.lines.map((l) => l.code)).toEqual(['plan']);
  });

  it('a negotiated price replaces the catalogue price; 0 makes it free', () => {
    const cheaper = computeCharge({ plan: null, enabled: on({ ledger: true }), catalog: MODULE_CATALOG, priceOverridesInr: { ledger: 499 } });
    expect(cheaper.subtotalPaise).toBe(49_900);
    const free = computeCharge({ plan: null, enabled: on({ ledger: true }), catalog: MODULE_CATALOG, priceOverridesInr: { ledger: 0 } });
    expect(free.lines).toEqual([]);
  });

  it('a module switched off is not billed', () => {
    const c = computeCharge({ plan: { name: 'Starter', basePricePaise: 100_000, includedModules: [] }, enabled: on({ ledger: false }), catalog: MODULE_CATALOG });
    expect(c.lines.map((l) => l.code)).toEqual(['plan']);
  });
});

describe('money and periods', () => {
  it('rupeesToPaise rounds float noise away', () => {
    expect(rupeesToPaise(0.1 + 0.2)).toBe(30);
    expect(rupeesToPaise(499)).toBe(49_900);
  });
  it('validates billing periods', () => {
    expect(PERIOD_RE.test('2026-11')).toBe(true);
    expect(PERIOD_RE.test('2026-13')).toBe(false);
    expect(PERIOD_RE.test('26-11')).toBe(false);
    expect(currentPeriod(new Date('2026-03-05T10:00:00Z'))).toBe('2026-03');
  });
});

describe('insights maths', () => {
  it('conversion is 0, not NaN, with no leads', () => {
    expect(conversionPct(0, 0)).toBe(0);
    expect(conversionPct(1, 3)).toBe(33.3);
  });
  it('funnel row and merging', () => {
    const merged = sumCounts({ new: 2, admitted: 1 }, { new: 1, lost: 4, admitted: 1 });
    expect(merged).toEqual({ new: 3, admitted: 2, lost: 4 });
    expect(funnelRow(merged)).toEqual({ total: 9, admitted: 2, lost: 4, conversionPct: 22.2 });
  });
});
