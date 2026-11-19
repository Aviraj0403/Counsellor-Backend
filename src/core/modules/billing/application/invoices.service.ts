import { isValidObjectId } from 'mongoose';
import { badRequest, conflict, notFound } from '../../../../shared/kernel/errors.js';
import { recordPlatformAudit } from '../../audit/index.js';
import { PERIOD_RE } from '../domain/billing.domain.js';
import { Counter, Invoice } from '../infrastructure/invoice.model.js';
import { loadBillingContext } from './billing.service.js';
import { shapeInvoice } from './invoice.shape.js';

const nextInvoiceNo = async (): Promise<string> => {
  const year = new Date().getUTCFullYear();
  const c = await Counter.findOneAndUpdate({ _id: `invoice-${year}` }, { $inc: { seq: 1 } }, { upsert: true, new: true });
  return `CP-${year}-${String(c!.seq).padStart(4, '0')}`;
};

/** Snapshots the current charge, the GST rate/split and both parties' details into an immutable invoice. One per organisation per month. */
export const generateInvoice = async (tenantId: string, period: string) => {
  if (!PERIOD_RE.test(period)) throw badRequest('Period must look like 2026-11.');
  const { charge, settings, details, tenant } = await loadBillingContext(tenantId);
  if (!charge.lines.length) throw badRequest('Nothing to bill: no plan price and no priced add-ons are switched on for this organisation.');
  if (await Invoice.exists({ tenantId, period })) throw conflict(`An invoice for ${period} already exists for this organisation.`);
  const inv = await Invoice.create({
    invoiceNo: await nextInvoiceNo(),
    tenantId,
    period,
    lines: charge.lines,
    subtotalPaise: charge.subtotalPaise,
    gstRateBps: charge.gstRateBps,
    supply: charge.supply,
    cgstPaise: charge.cgstPaise,
    sgstPaise: charge.sgstPaise,
    igstPaise: charge.igstPaise,
    gstPaise: charge.gstPaise,
    totalPaise: charge.totalPaise,
    seller: { legalName: settings.legalName, gstin: settings.gstin, pan: settings.pan, address: settings.address, state: settings.state },
    buyer: { legalName: details.legalName ?? tenant.name, gstin: details.gstin, address: details.address, state: details.state },
  });
  await recordPlatformAudit({ action: 'invoice.issued', targetType: 'invoice', targetId: String(inv._id), tenantId, meta: { period, totalPaise: charge.totalPaise } });
  return shapeInvoice(inv.toObject());
};

export const getInvoiceDoc = async (invoiceId: string) => {
  if (!isValidObjectId(invoiceId)) throw notFound('Invoice');
  const inv = await Invoice.findById(invoiceId).lean();
  if (!inv) throw notFound('Invoice');
  return inv;
};

export const setInvoiceStatus = async (invoiceId: string, status: 'paid' | 'void', paidRef?: string) => {
  if (!isValidObjectId(invoiceId)) throw notFound('Invoice');
  const inv = await Invoice.findById(invoiceId);
  if (!inv) throw notFound('Invoice');
  if (inv.status !== 'issued') throw conflict(`This invoice is already ${inv.status}.`);
  inv.status = status;
  if (status === 'paid') {
    inv.paidAt = new Date();
    inv.paidRef = paidRef;
  }
  await inv.save();
  await recordPlatformAudit({ action: status === 'paid' ? 'invoice.paid' : 'invoice.voided', targetType: 'invoice', targetId: invoiceId, tenantId: inv.tenantId, meta: { invoiceNo: inv.invoiceNo } });
  return shapeInvoice(inv.toObject());
};

export const listInvoices = async (q: { page: number; limit: number; status?: string; period?: string }) => {
  const filter: Record<string, unknown> = {};
  if (q.status) filter.status = q.status;
  if (q.period) filter.period = q.period;
  const [rows, total] = await Promise.all([
    Invoice.find(filter).sort({ issuedAt: -1 }).skip((q.page - 1) * q.limit).limit(q.limit).lean(),
    Invoice.countDocuments(filter),
  ]);
  return { items: rows.map(shapeInvoice), total, page: q.page, limit: q.limit };
};
