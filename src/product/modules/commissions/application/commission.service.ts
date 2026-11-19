import { getPlatform } from '../../../../contracts/registry.js';
import type { Principal } from '../../../../contracts/port.js';
import { systemPrincipal } from '../../../../contracts/system.js';
import { badRequest, conflict, notFound } from '../../../../shared/kernel/errors.js';
import { publish, subscribe } from '../../../../shared/kernel/events.js';
import { audit } from '../../audit/index.js';
import { getApplication } from '../../applications/index.js';
import { getCollege } from '../../colleges/index.js';
import { balanceOf, postEntry, reverseEntry } from '../../ledger/index.js';
import { computeCommission, payableAfter, triggersAccrual, type CommissionMode, type CommissionTrigger } from '../domain/commission.domain.js';
import { AccrualModel, CommissionRuleModel, PayoutModel } from '../infrastructure/commission.model.js';

const visibility = (p: Principal) => (p.role === 'counsellor' ? { counsellorId: p.userId } : {});

// ---------------- rules
export interface RuleInput {
  collegeId: string;
  mode: CommissionMode;
  percentBps?: number;
  flatPaise?: number;
  trigger: CommissionTrigger;
  counsellorShareBps?: number;
  active?: boolean;
}

const rulesWithNames = async (tenantId: string, rows: any[]) =>
  Promise.all(rows.map(async (r) => ({ ...r, collegeName: (await getCollege(tenantId, r.collegeId))?.name })));

export const listRules = async (tenantId: string) => rulesWithNames(tenantId, await CommissionRuleModel(tenantId).find().sort({ createdAt: -1 }).lean<any[]>());

const checkRule = (r: Partial<RuleInput>) => {
  if (r.mode === 'percent_of_fee' && !(r.percentBps && r.percentBps > 0)) throw badRequest('Enter the commission percentage for this rule.');
  if (r.mode === 'flat' && !(r.flatPaise && r.flatPaise > 0)) throw badRequest('Enter the flat commission amount for this rule.');
};

export const createRule = async (p: Principal, input: RuleInput) => {
  const tenantId = p.tenantId!;
  if (!(await getCollege(tenantId, input.collegeId))) throw notFound('College');
  checkRule(input);
  try {
    const doc = await CommissionRuleModel(tenantId).create(input);
    await audit(tenantId, { action: 'commission.rule_created', entity: 'commission_rule', entityId: String(doc._id), meta: { collegeId: input.collegeId, mode: input.mode } });
    return doc.toObject();
  } catch (e: any) {
    if (e?.code === 11000) throw conflict('This college already has a commission rule. Edit it instead.');
    throw e;
  }
};

export const updateRule = async (p: Principal, id: string, patch: Partial<Omit<RuleInput, 'collegeId'>>) => {
  const tenantId = p.tenantId!;
  const M = CommissionRuleModel(tenantId);
  const cur = await M.findById(id).lean<any>();
  if (!cur) throw notFound('Commission rule');
  checkRule({ ...cur, ...patch });
  const updated = await M.findByIdAndUpdate(id, { $set: patch }, { new: true }).lean<any>();
  await audit(tenantId, { action: 'commission.rule_updated', entity: 'commission_rule', entityId: id, meta: { fields: Object.keys(patch) } });
  return updated;
};

export const deleteRule = async (p: Principal, id: string) => {
  const tenantId = p.tenantId!;
  const gone = await CommissionRuleModel(tenantId).findByIdAndDelete(id).lean<any>();
  if (!gone) throw notFound('Commission rule');
  await audit(tenantId, { action: 'commission.rule_deleted', entity: 'commission_rule', entityId: id, meta: { collegeId: gone.collegeId } });
  return { id, deleted: true };
};

// ---------------- accrual (driven by application.status_changed)
export const accrueForApplication = async (tenantId: string, applicationId: string, to: string): Promise<boolean> => {
  const app = await getApplication(tenantId, applicationId);
  if (!app) return false;
  const rule = await CommissionRuleModel(tenantId).findOne({ collegeId: app.collegeId, active: true }).lean<any>();
  if (!triggersAccrual(rule, to)) return false;
  const c = computeCommission(rule, app);
  if (c.totalPaise <= 0) return false;
  const counsellorId = app.assignedTo;
  const counsellorSharePaise = counsellorId ? c.counsellorSharePaise : 0;
  const organisationSharePaise = c.totalPaise - counsellorSharePaise;

  const Accrual = AccrualModel(tenantId);
  let accrual: any;
  try {
    accrual = (await Accrual.create({ applicationId, collegeId: app.collegeId, counsellorId, totalPaise: c.totalPaise, counsellorSharePaise, organisationSharePaise })).toObject();
  } catch (e: any) {
    if (e?.code === 11000) return false; // already accrued
    throw e;
  }
  try {
    const lines = [{ account: `college:${app.collegeId}`, debit: c.totalPaise, credit: 0 }];
    if (counsellorSharePaise > 0) lines.push({ account: `counsellor:${counsellorId}`, debit: 0, credit: counsellorSharePaise });
    if (organisationSharePaise > 0) lines.push({ account: 'platform:commission_income', debit: 0, credit: organisationSharePaise });
    const { entry } = await postEntry(systemPrincipal(tenantId, 'commissions'), {
      idempotencyKey: `commission-accrual-${applicationId}`,
      reference: `COMM-${applicationId}`,
      description: 'Commission accrued',
      lines,
    });
    await Accrual.updateOne({ _id: accrual._id }, { $set: { ledgerEntryId: String(entry._id) } });
  } catch (err) {
    await Accrual.deleteOne({ _id: accrual._id }); // nothing was posted: allow a later retry
    throw err;
  }
  await audit(tenantId, { action: 'commission.accrued', entity: 'commission_accrual', entityId: String(accrual._id), meta: { applicationId, totalPaise: c.totalPaise } });
  await publish('commission.accrued', { tenantId, applicationId, collegeId: app.collegeId, counsellorId, totalPaise: c.totalPaise });
  return true;
};

export const registerEvents = (): void => {
  subscribe('application.status_changed', async ({ tenantId, applicationId, to }) => {
    await accrueForApplication(tenantId, applicationId, to);
  });
};

// ---------------- accruals
export const listAccruals = async (p: Principal, q: { page: number; limit: number; status?: string; collegeId?: string; counsellorId?: string }) => {
  const tenantId = p.tenantId!;
  const filter: Record<string, unknown> = { ...visibility(p) };
  if (q.status) filter.status = q.status;
  if (q.collegeId) filter.collegeId = q.collegeId;
  if (q.counsellorId && p.role !== 'counsellor') filter.counsellorId = q.counsellorId;
  const M = AccrualModel(tenantId);
  const [rows, total] = await Promise.all([M.find(filter).sort({ createdAt: -1 }).skip((q.page - 1) * q.limit).limit(q.limit).lean<any[]>(), M.countDocuments(filter)]);
  const team = await getPlatform().listTeam(tenantId);
  const names = new Map(team.map((m) => [m.id, m.name]));
  const items = await Promise.all(rows.map(async (r) => ({ ...r, collegeName: (await getCollege(tenantId, r.collegeId))?.name, counsellorName: r.counsellorId ? names.get(r.counsellorId) : undefined })));
  return { items, total, page: q.page, limit: q.limit };
};

const payableFor = async (p: Principal, counsellorId: string) => payableAfter(-(await balanceOf(p, `counsellor:${counsellorId}`)).netPaise);

export const summaryPerCounsellor = async (p: Principal) => {
  const tenantId = p.tenantId!;
  const match: Record<string, unknown> = { status: { $in: ['accrued', 'collected'] }, counsellorId: { $exists: true, $ne: null }, ...visibility(p) };
  const rows = await AccrualModel(tenantId).aggregate([{ $match: match }, { $group: { _id: '$counsellorId', accruedPaise: { $sum: '$counsellorSharePaise' }, count: { $sum: 1 } } }]);
  const team = await getPlatform().listTeam(tenantId);
  const names = new Map(team.map((m) => [m.id, m.name]));
  const items = await Promise.all(
    rows.map(async (r: any) => {
      const payablePaise = await payableFor(p, r._id);
      return { counsellorId: r._id, counsellorName: names.get(r._id), accrualCount: r.count, accruedPaise: r.accruedPaise, paidPaise: r.accruedPaise - payablePaise, payablePaise };
    }),
  );
  return { items };
};

export const payout = async (p: Principal, input: { counsellorId: string; amountPaise: number; reference: string }) => {
  const tenantId = p.tenantId!;
  const Payout = PayoutModel(tenantId);
  const prior = await Payout.findOne({ counsellorId: input.counsellorId, reference: input.reference }).lean<any>();
  if (prior) return { payout: prior, replayed: true };
  const payable = await payableFor(p, input.counsellorId);
  if (input.amountPaise > payable) throw conflict(`You can pay at most ${payable} paise (payable balance) to this counsellor.`, { payablePaise: payable });
  const key = `commission-payout-${input.counsellorId}-${input.reference}`;
  const { entry } = await postEntry(p, {
    idempotencyKey: key,
    reference: `PAYOUT-${input.reference}`.slice(0, 120),
    description: 'Counsellor commission payout',
    lines: [
      { account: `counsellor:${input.counsellorId}`, debit: input.amountPaise, credit: 0 },
      { account: 'bank:main', debit: 0, credit: input.amountPaise },
    ],
  });
  const doc = await Payout.create({ ...input, ledgerEntryId: String(entry._id), by: p.userId });
  await audit(tenantId, { action: 'commission.payout', entity: 'counsellor', entityId: input.counsellorId, meta: { amountPaise: input.amountPaise, reference: input.reference } });
  return { payout: doc.toObject(), replayed: false };
};

export const collect = async (p: Principal, accrualId: string, reference: string) => {
  const tenantId = p.tenantId!;
  const M = AccrualModel(tenantId);
  const cur = await M.findById(accrualId).lean<any>();
  if (!cur) throw notFound('Commission');
  if (cur.status !== 'accrued') throw conflict(cur.status === 'collected' ? 'This commission was already collected.' : 'A reversed commission cannot be collected.');
  const { entry } = await postEntry(p, {
    idempotencyKey: `commission-collect-${accrualId}`,
    reference: `COLLECT-${reference}`.slice(0, 120),
    description: 'Commission received from college',
    lines: [
      { account: 'bank:main', debit: cur.totalPaise, credit: 0 },
      { account: `college:${cur.collegeId}`, debit: 0, credit: cur.totalPaise },
    ],
  });
  const updated = await M.findOneAndUpdate({ _id: accrualId, status: 'accrued' }, { $set: { status: 'collected', collectedAt: new Date(), collectReference: reference, collectEntryId: String(entry._id) } }, { new: true }).lean<any>();
  if (!updated) throw conflict('This commission was already collected.');
  await audit(tenantId, { action: 'commission.collected', entity: 'commission_accrual', entityId: accrualId, meta: { reference, totalPaise: cur.totalPaise } });
  return updated;
};

export const reverse = async (p: Principal, accrualId: string, reason: string) => {
  const tenantId = p.tenantId!;
  const M = AccrualModel(tenantId);
  const cur = await M.findById(accrualId).lean<any>();
  if (!cur) throw notFound('Commission');
  if (cur.status === 'reversed') throw conflict('This commission was already reversed.');
  if (cur.counsellorId && cur.counsellorSharePaise > 0) {
    const payable = await payableFor(p, cur.counsellorId);
    if (payable < cur.counsellorSharePaise) throw conflict('The counsellor has already been paid part of this commission. Recover that payout first, then reverse.');
  }
  if (cur.status === 'collected' && cur.collectEntryId) await reverseEntry(p, cur.collectEntryId, `commission-reverse-collect-${accrualId}`, reason);
  await reverseEntry(p, cur.ledgerEntryId, `commission-reverse-${accrualId}`, reason);
  const updated = await M.findByIdAndUpdate(accrualId, { $set: { status: 'reversed', reversedAt: new Date(), reverseReason: reason } }, { new: true }).lean<any>();
  await audit(tenantId, { action: 'commission.reversed', entity: 'commission_accrual', entityId: accrualId, meta: { reason } });
  return updated;
};

// ---------------- public API
export const commissionTotals = async (tenantId: string, range: { from?: Date; to?: Date } = {}) => {
  const dates = (field: string) => (range.from || range.to ? { [field]: { ...(range.from ? { $gte: range.from } : {}), ...(range.to ? { $lt: range.to } : {}) } } : {});
  const sum = async (match: Record<string, unknown>, field: string) => {
    const r = await AccrualModel(tenantId).aggregate([{ $match: match }, { $group: { _id: null, n: { $sum: `$${field}` } } }]);
    return (r[0]?.n as number) ?? 0;
  };
  const accruedPaise = await sum({ status: { $in: ['accrued', 'collected'] }, ...dates('createdAt') }, 'totalPaise');
  const collectedPaise = await sum({ status: 'collected', ...dates('collectedAt') }, 'totalPaise');
  const counsellorSharePaise = await sum({ status: { $in: ['accrued', 'collected'] }, ...dates('createdAt') }, 'counsellorSharePaise');
  const organisationSharePaise = await sum({ status: { $in: ['accrued', 'collected'] }, ...dates('createdAt') }, 'organisationSharePaise');
  const pr = await PayoutModel(tenantId).aggregate([{ $match: dates('createdAt') }, { $group: { _id: null, n: { $sum: '$amountPaise' } } }]);
  return { accruedPaise, collectedPaise, counsellorSharePaise, organisationSharePaise, paidOutPaise: (pr[0]?.n as number) ?? 0 };
};

