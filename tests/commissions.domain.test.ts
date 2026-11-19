import { describe, expect, it } from 'vitest';
import { computeCommission, triggersAccrual } from '../src/product/modules/commissions/domain/commission.domain.js';

describe('computeCommission', () => {
  it('percent of fee paid (basis points)', () => {
    const r = computeCommission({ mode: 'percent_of_fee', percentBps: 1000, trigger: 'fee_paid', counsellorShareBps: 4000 }, { fee: { paidPaise: 5_000_000 } });
    expect(r).toEqual({ totalPaise: 500_000, counsellorSharePaise: 200_000, organisationSharePaise: 300_000 });
  });
  it('flat amount ignores the fee', () => {
    const r = computeCommission({ mode: 'flat', flatPaise: 1_500_000, trigger: 'admitted', counsellorShareBps: 5000 }, { fee: { paidPaise: 1 } });
    expect(r.totalPaise).toBe(1_500_000);
  });
  it('none gives zero', () => {
    expect(computeCommission({ mode: 'none', trigger: 'admitted', counsellorShareBps: 5000 }, { fee: { paidPaise: 100 } })).toEqual({ totalPaise: 0, counsellorSharePaise: 0, organisationSharePaise: 0 });
  });
  it('split never loses a paisa: counsellor floors, organisation gets the remainder', () => {
    for (const total of [1, 7, 99, 1001, 123_457]) {
      for (const bps of [0, 1, 3333, 5000, 6667, 10000]) {
        const r = computeCommission({ mode: 'flat', flatPaise: total, trigger: 'admitted', counsellorShareBps: bps }, {});
        expect(r.counsellorSharePaise + r.organisationSharePaise).toBe(total);
        expect(Number.isInteger(r.counsellorSharePaise)).toBe(true);
      }
    }
    expect(computeCommission({ mode: 'flat', flatPaise: 101, trigger: 'admitted', counsellorShareBps: 5000 }, {}).counsellorSharePaise).toBe(50);
  });
  it('percent floors to whole paise and tolerates missing fee', () => {
    expect(computeCommission({ mode: 'percent_of_fee', percentBps: 333, trigger: 'fee_paid' }, { fee: { paidPaise: 1001 } }).totalPaise).toBe(33);
    expect(computeCommission({ mode: 'percent_of_fee', percentBps: 1000, trigger: 'fee_paid' }, {}).totalPaise).toBe(0);
  });
  it('triggers only at the rule status and never for mode none', () => {
    expect(triggersAccrual({ mode: 'flat', trigger: 'fee_paid' }, 'fee_paid')).toBe(true);
    expect(triggersAccrual({ mode: 'flat', trigger: 'fee_paid' }, 'admitted')).toBe(false);
    expect(triggersAccrual({ mode: 'none', trigger: 'fee_paid' }, 'fee_paid')).toBe(false);
    expect(triggersAccrual(null, 'fee_paid')).toBe(false);
  });
});
