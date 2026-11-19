/**
 * DOUBLE-ENTRY LEDGER RULES (pure code, no database).
 *
 * In plain words: every money movement is written as an ENTRY with two or more LINES. Money leaves one account
 * (credit) and arrives in another (debit), so total debit always equals total credit. Entries are never edited or
 * deleted. A mistake is fixed by posting a REVERSAL entry, so the history always shows what really happened.
 *
 * Amounts are whole PAISE (integers). Never floats: 0.1 + 0.2 != 0.3 is how ledgers go wrong.
 *
 * Account codes look like  student:<id>  college:<id>  counsellor:<id>  platform:revenue  bank:main  tax:gst
 */

export type Paise = number;

export interface LedgerLine {
  account: string;
  debit: Paise;
  credit: Paise;
}

export class LedgerError extends Error {
  constructor(
    public readonly code: 'TOO_FEW_LINES' | 'BAD_AMOUNT' | 'BAD_ACCOUNT' | 'UNBALANCED',
    message: string,
  ) {
    super(message);
    this.name = 'LedgerError';
  }
}

export const ACCOUNT_KINDS = ['student', 'college', 'counsellor', 'platform', 'bank', 'tax'] as const;
const ACCOUNT_RE = new RegExp(`^(${ACCOUNT_KINDS.join('|')}):[A-Za-z0-9_.-]{1,64}$`);

export const isValidAccount = (code: string): boolean => ACCOUNT_RE.test(code);

const isPaise = (n: unknown): n is Paise => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;

/** Throws LedgerError unless the lines are a valid, balanced entry. */
export const assertBalanced = (lines: LedgerLine[]): void => {
  if (lines.length < 2) throw new LedgerError('TOO_FEW_LINES', 'An entry needs at least two lines.');
  let debit = 0;
  let credit = 0;
  for (const l of lines) {
    if (!isValidAccount(l.account)) throw new LedgerError('BAD_ACCOUNT', `"${l.account}" is not a valid account code.`);
    if (!isPaise(l.debit) || !isPaise(l.credit)) throw new LedgerError('BAD_AMOUNT', 'Amounts must be whole paise (integers, not negative).');
    if ((l.debit > 0) === (l.credit > 0)) throw new LedgerError('BAD_AMOUNT', 'Each line must have either a debit or a credit, not both and not zero.');
    debit += l.debit;
    credit += l.credit;
  }
  if (!Number.isSafeInteger(debit) || !Number.isSafeInteger(credit)) throw new LedgerError('BAD_AMOUNT', 'Total is too large.');
  if (debit !== credit) throw new LedgerError('UNBALANCED', `Debits (${debit}) and credits (${credit}) must be equal.`);
};

export const totalPaise = (lines: LedgerLine[]): Paise => lines.reduce((s, l) => s + l.debit, 0);

/** The mirror image of an entry. Posting it cancels the original exactly. */
export const reverseLines = (lines: LedgerLine[]): LedgerLine[] =>
  lines.map((l) => ({ account: l.account, debit: l.credit, credit: l.debit }));

/** Net = debit - credit across the given entries. */
export const accountBalance = (entries: { lines: LedgerLine[] }[], account: string) => {
  let debit = 0;
  let credit = 0;
  for (const e of entries) {
    for (const l of e.lines) {
      if (l.account === account) {
        debit += l.debit;
        credit += l.credit;
      }
    }
  }
  return { account, debitPaise: debit, creditPaise: credit, netPaise: debit - credit };
};

/** Net per account. The sum of all nets is always 0 if every entry is balanced: the integrity check. */
export const trialBalance = (entries: { lines: LedgerLine[] }[]) => {
  const nets = new Map<string, number>();
  for (const e of entries) for (const l of e.lines) nets.set(l.account, (nets.get(l.account) ?? 0) + l.debit - l.credit);
  const accounts = [...nets.entries()].map(([account, netPaise]) => ({ account, netPaise })).sort((a, b) => a.account.localeCompare(b.account));
  return { accounts, isBalanced: accounts.reduce((s, a) => s + a.netPaise, 0) === 0 };
};
