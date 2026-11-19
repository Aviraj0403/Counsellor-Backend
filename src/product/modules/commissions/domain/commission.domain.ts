/** Pure commission rules (integer paise). Unit-tested in tests/commissions.domain.test.ts */

export type CommissionMode = 'percent_of_fee' | 'flat' | 'none';
export type CommissionTrigger = 'fee_paid' | 'admitted';

export interface CommissionRuleLike {
  mode: CommissionMode;
  percentBps?: number;
  flatPaise?: number;
  trigger: CommissionTrigger;
  counsellorShareBps?: number;
}

export interface CommissionResult {
  totalPaise: number;
  counsellorSharePaise: number;
  organisationSharePaise: number;
}

/** Total commission for the college: percent of the tuition actually paid (basis points), a flat amount, or nothing. */
export const computeCommission = (rule: CommissionRuleLike, application: { fee?: { paidPaise?: number } }): CommissionResult => {
  let total = 0;
  if (rule.mode === 'percent_of_fee') {
    const paid = Math.max(0, Math.trunc(application.fee?.paidPaise ?? 0));
    total = Math.floor((paid * Math.max(0, rule.percentBps ?? 0)) / 10000);
  } else if (rule.mode === 'flat') {
    total = Math.max(0, Math.trunc(rule.flatPaise ?? 0));
  }
  const bps = Math.min(10000, Math.max(0, rule.counsellorShareBps ?? 0));
  const counsellorSharePaise = Math.floor((total * bps) / 10000); // floors; the organisation gets the remainder, so no paisa is lost
  return { totalPaise: total, counsellorSharePaise, organisationSharePaise: total - counsellorSharePaise };
};

/** Does this status change trigger an accrual? */
export const triggersAccrual = (rule: Pick<CommissionRuleLike, 'trigger' | 'mode'> | null | undefined, to: string): boolean => !!rule && rule.mode !== 'none' && rule.trigger === to;

/** What can still be paid to the counsellor: credits owed minus what was already paid out (never negative). */
export const payableAfter = (netCreditPaise: number): number => Math.max(0, netCreditPaise);
