import { isValidObjectId } from 'mongoose';
import { getContext } from '../../../../shared/kernel/context.js';
import { badRequest, conflict, notFound } from '../../../../shared/kernel/errors.js';
import { recordPlatformAudit } from '../../audit/index.js';
import { tenantExists } from '../../organisations/index.js';
import { CostEntry, type CostDoc } from '../infrastructure/cost.model.js';

/**
 * What it costs US to run the platform (WhatsApp, SMS, hosting, ads...). Entered by finance for now;
 * automatic metering comes with the WhatsApp / Meta modules. Entries are never edited: a wrong one is voided.
 */
const shape = (c: any) => ({
  id: String(c._id),
  month: c.month,
  category: c.category,
  amountPaise: c.amountPaise,
  tenantId: c.tenantId,
  note: c.note,
  voided: c.voided,
  createdAt: c.createdAt,
});

export const addCost = async (input: { month: string; category: CostDoc['category']; amountPaise: number; tenantId?: string; note?: string }) => {
  if (input.tenantId && !(await tenantExists(input.tenantId))) throw badRequest('That organisation does not exist.');
  const c = await CostEntry.create({ ...input, createdBy: getContext()?.userId });
  await recordPlatformAudit({ action: 'cost.recorded', targetType: 'cost', targetId: String(c._id), tenantId: input.tenantId, meta: { month: input.month, category: input.category, amountPaise: input.amountPaise } });
  return shape(c.toObject());
};

export const voidCost = async (id: string) => {
  if (!isValidObjectId(id)) throw notFound('Cost entry');
  const c = await CostEntry.findById(id);
  if (!c) throw notFound('Cost entry');
  if (c.voided) throw conflict('This cost entry is already voided.');
  c.voided = true;
  await c.save();
  await recordPlatformAudit({ action: 'cost.voided', targetType: 'cost', targetId: id, tenantId: c.tenantId, meta: { month: c.month, amountPaise: c.amountPaise } });
  return shape(c.toObject());
};

export const listCosts = async (month: string) => {
  const rows = await CostEntry.find({ month }).sort({ createdAt: -1 }).lean();
  const live = rows.filter((r) => !r.voided);
  const byCategory: Record<string, number> = {};
  for (const r of live) byCategory[r.category] = (byCategory[r.category] ?? 0) + r.amountPaise;
  return { month, items: rows.map(shape), totalPaise: live.reduce((s, r) => s + r.amountPaise, 0), byCategory };
};

/**
 * Automatic metering: the platform pays for something on an organisation's behalf (a WhatsApp message, an SMS, storage).
 * All usage of one kind in one month is ONE row that grows, so a busy organisation does not create thousands of cost entries.
 * Never throws: failing to meter must not break the customer's action (it is logged by the caller if it matters).
 */
export const recordUsageCost = async (tenantId: string, entry: { category: CostDoc['category']; amountPaise: number; note?: string }): Promise<void> => {
  try {
    if (!(entry.amountPaise > 0)) return;
    const now = new Date();
    const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    await CostEntry.findOneAndUpdate(
      { month, category: entry.category, tenantId, voided: false, note: 'metered usage' },
      { $inc: { amountPaise: Math.round(entry.amountPaise) }, $setOnInsert: { createdBy: 'system' } },
      { upsert: true },
    );
  } catch {
    /* metering must never break the action that caused it */
  }
};
