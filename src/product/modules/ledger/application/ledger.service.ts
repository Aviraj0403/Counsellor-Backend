import type { Principal } from '../../../../contracts/port.js';
import { badRequest, conflict, notFound } from '../../../../shared/kernel/errors.js';
import { audit } from '../../audit/index.js';
import { LedgerEntryModel } from '../infrastructure/ledger.model.js';
import { LedgerError, assertBalanced, isValidAccount, reverseLines, totalPaise, trialBalance, type LedgerLine } from '../domain/ledger.domain.js';

const check = (lines: LedgerLine[]) => {
  try {
    assertBalanced(lines);
  } catch (e) {
    if (e instanceof LedgerError) throw badRequest(e.message, { code: e.code });
    throw e;
  }
};

export const postEntry = async (
  p: Principal,
  input: { idempotencyKey: string; reference: string; description?: string; lines: LedgerLine[] },
) => {
  const tenantId = p.tenantId!;
  check(input.lines);
  const Entry = LedgerEntryModel(tenantId);

  const prior = await Entry.findOne({ idempotencyKey: input.idempotencyKey }).lean();
  if (prior) return { entry: prior, replayed: true };

  try {
    const entry = await Entry.create({ ...input, totalPaise: totalPaise(input.lines), postedBy: p.userId });
    await audit(tenantId, { action: 'ledger.posted', entity: 'ledger_entry', entityId: String(entry._id), meta: { reference: input.reference, totalPaise: entry.totalPaise } });
    return { entry: entry.toObject(), replayed: false };
  } catch (e: any) {
    if (e?.code === 11000) {
      // two identical requests raced: hand back the winner
      const winner = await Entry.findOne({ idempotencyKey: input.idempotencyKey }).lean();
      if (winner) return { entry: winner, replayed: true };
    }
    throw e;
  }
};

export const reverseEntry = async (p: Principal, entryId: string, idempotencyKey: string, reason: string) => {
  const tenantId = p.tenantId!;
  const Entry = LedgerEntryModel(tenantId);
  const original = await Entry.findById(entryId).lean<any>();
  if (!original) throw notFound('Ledger entry');
  if (original.reversalOf) throw conflict('A reversal entry cannot itself be reversed. Post a new entry instead.');
  if (await Entry.exists({ reversalOf: entryId })) throw conflict('This entry has already been reversed.');

  const lines = reverseLines(original.lines);
  const reversal = await Entry.create({
    idempotencyKey,
    reference: `REV-${original.reference}`.slice(0, 120),
    description: reason,
    lines,
    totalPaise: totalPaise(lines),
    reversalOf: entryId,
    postedBy: p.userId,
  });
  await audit(tenantId, { action: 'ledger.reversed', entity: 'ledger_entry', entityId: entryId, meta: { reversalId: String(reversal._id), reason } });
  return { entry: reversal.toObject() };
};

export const listEntries = async (p: Principal, q: { page: number; limit: number; account?: string }) => {
  if (q.account && !isValidAccount(q.account)) throw badRequest('Invalid account code.');
  const Entry = LedgerEntryModel(p.tenantId!);
  const filter = q.account ? { 'lines.account': q.account } : {};
  const [rows, total] = await Promise.all([
    Entry.find(filter).sort({ postedAt: -1 }).skip((q.page - 1) * q.limit).limit(q.limit).lean<any[]>(),
    Entry.countDocuments(filter),
  ]);
  // tell the screen which entries were already reversed, so it does not offer "Reverse" twice
  const ids = rows.map((r) => String(r._id));
  const reversals = await Entry.find({ reversalOf: { $in: ids } }).select('reversalOf').lean<any[]>();
  const reversed = new Set(reversals.map((r) => String(r.reversalOf)));
  return { items: rows.map((r) => ({ ...r, reversed: reversed.has(String(r._id)) })), total, page: q.page, limit: q.limit };
};

export const balanceOf = async (p: Principal, account: string) => {
  if (!isValidAccount(account)) throw badRequest('Invalid account code.');
  const rows = await LedgerEntryModel(p.tenantId!).aggregate([
    { $unwind: '$lines' },
    { $match: { 'lines.account': account } },
    { $group: { _id: null, debit: { $sum: '$lines.debit' }, credit: { $sum: '$lines.credit' } } },
  ]);
  const debit = rows[0]?.debit ?? 0;
  const credit = rows[0]?.credit ?? 0;
  return { account, debitPaise: debit, creditPaise: credit, netPaise: debit - credit };
};

export const getTrialBalance = async (p: Principal) => {
  const rows = await LedgerEntryModel(p.tenantId!).aggregate([
    { $unwind: '$lines' },
    { $group: { _id: '$lines.account', debit: { $sum: '$lines.debit' }, credit: { $sum: '$lines.credit' } } },
  ]);
  // Re-use the pure rule so the DB view and the domain view can never disagree.
  return trialBalance([{ lines: rows.map((r: any) => ({ account: r._id, debit: r.debit, credit: r.credit })) }]);
};

/** COUNT ONLY, for platform research. */
export const countLedgerEntries = async (tenantId: string): Promise<number> => LedgerEntryModel(tenantId).countDocuments();
