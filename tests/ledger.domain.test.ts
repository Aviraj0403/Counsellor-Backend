import { describe, expect, it } from 'vitest';
import { LedgerError, accountBalance, assertBalanced, isValidAccount, reverseLines, totalPaise, trialBalance } from '../src/product/modules/ledger/domain/ledger.domain.js';

const fee = [
  { account: 'bank:main', debit: 5_000_00, credit: 0 },
  { account: 'student:s1', debit: 0, credit: 5_000_00 },
];

describe('ledger domain', () => {
  it('accepts a balanced entry', () => {
    expect(() => assertBalanced(fee)).not.toThrow();
    expect(totalPaise(fee)).toBe(500_000);
  });

  it('rejects unbalanced, one-line, fractional, negative and two-sided lines', () => {
    const code = (l: any) => {
      try { assertBalanced(l); } catch (e) { return (e as LedgerError).code; }
      return 'OK';
    };
    expect(code([{ account: 'bank:main', debit: 100, credit: 0 }, { account: 'student:s1', debit: 0, credit: 90 }])).toBe('UNBALANCED');
    expect(code([fee[0]])).toBe('TOO_FEW_LINES');
    expect(code([{ account: 'bank:main', debit: 10.5, credit: 0 }, { account: 'student:s1', debit: 0, credit: 10.5 }])).toBe('BAD_AMOUNT');
    expect(code([{ account: 'bank:main', debit: -5, credit: 0 }, { account: 'student:s1', debit: 0, credit: -5 }])).toBe('BAD_AMOUNT');
    expect(code([{ account: 'bank:main', debit: 5, credit: 5 }, { account: 'student:s1', debit: 0, credit: 0 }])).toBe('BAD_AMOUNT');
    expect(code([{ account: 'nope', debit: 5, credit: 0 }, { account: 'student:s1', debit: 0, credit: 5 }])).toBe('BAD_ACCOUNT');
  });

  it('validates account codes', () => {
    expect(isValidAccount('college:abc123')).toBe(true);
    expect(isValidAccount('platform:revenue')).toBe(true);
    expect(isValidAccount('random:x')).toBe(false);
    expect(isValidAccount('student:')).toBe(false);
    expect(isValidAccount('student:a b')).toBe(false);
  });

  it('a reversal cancels the original exactly', () => {
    const rev = reverseLines(fee);
    assertBalanced(rev);
    expect(accountBalance([{ lines: fee }, { lines: rev }], 'student:s1').netPaise).toBe(0);
    expect(accountBalance([{ lines: fee }, { lines: rev }], 'bank:main').netPaise).toBe(0);
  });

  it('trial balance always nets to zero when every entry is balanced', () => {
    const commission = [
      { account: 'college:c1', debit: 1_200_00, credit: 0 },
      { account: 'counsellor:u1', debit: 0, credit: 800_00 },
      { account: 'platform:revenue', debit: 0, credit: 400_00 },
    ];
    assertBalanced(commission);
    const tb = trialBalance([{ lines: fee }, { lines: commission }]);
    expect(tb.isBalanced).toBe(true);
    expect(tb.accounts.find((a) => a.account === 'counsellor:u1')?.netPaise).toBe(-80_000);
  });
});
