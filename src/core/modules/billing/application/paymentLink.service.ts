import { env } from '../../../../config/env.js';
import { hmacHex, safeEqual } from '../../../../shared/infra/crypto.js';
import { httpRequest } from '../../../../shared/infra/http.js';
import { logger } from '../../../../shared/infra/logger.js';
import { AppError, conflict } from '../../../../shared/kernel/errors.js';
import { recordPlatformAudit } from '../../audit/index.js';
import { Invoice } from '../infrastructure/invoice.model.js';
import { getInvoiceDoc } from './invoices.service.js';
import { shapeInvoice } from './invoice.shape.js';

const RAZORPAY_API = 'https://api.razorpay.com/v1';

/**
 * Creates a Razorpay payment link for an invoice (POST /v1/payment_links) and stores link id/url/status on the invoice.
 * Needs RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET. Written to Razorpay's documented API but only tested with a fake HTTP client.
 */
export const createPaymentLink = async (invoiceId: string) => {
  if (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET) {
    throw new AppError(503, 'PAYMENTS_NOT_CONFIGURED', 'Online payment is not set up on this server (Razorpay keys are missing). Ask your administrator.');
  }
  const inv = await getInvoiceDoc(invoiceId);
  if (inv.status !== 'issued') throw conflict(`This invoice is ${inv.status}; a payment link can only be made for an unpaid invoice.`);
  if (inv.paymentLink && ['created', 'partially_paid'].includes(inv.paymentLink.status)) return shapeInvoice(inv); // reuse the open link
  const res = await httpRequest(`${RAZORPAY_API}/payment_links`, {
    method: 'POST',
    headers: { authorization: `Basic ${Buffer.from(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`).toString('base64')}` },
    body: {
      amount: inv.totalPaise,
      currency: 'INR',
      reference_id: inv.invoiceNo,
      description: `Invoice ${inv.invoiceNo} (${inv.period})`,
      notes: { invoiceId: String(inv._id), invoiceNo: inv.invoiceNo },
    },
  });
  const d = res.data as { id?: string; short_url?: string; status?: string } | null;
  if (!res.ok || !d?.id || !d.short_url) {
    logger.warn({ status: res.status }, 'razorpay payment link creation failed');
    throw new AppError(502, 'PAYMENT_PROVIDER_ERROR', 'The payment provider did not accept the request. Please try again, or check the Razorpay keys.');
  }
  const updated = await Invoice.findOneAndUpdate(
    { _id: inv._id, status: 'issued' },
    { paymentLink: { id: d.id, url: d.short_url, status: d.status ?? 'created', createdAt: new Date() } },
    { new: true },
  ).lean();
  if (!updated) throw conflict('This invoice changed while the link was being created.');
  await recordPlatformAudit({ action: 'invoice.payment_link_created', targetType: 'invoice', targetId: invoiceId, tenantId: inv.tenantId, meta: { linkId: d.id } });
  return shapeInvoice(updated);
};

export const verifyRazorpaySignature = (rawBody: Buffer | undefined, signature: string | undefined): boolean => {
  const secret = env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret || !rawBody || !signature) return false;
  return safeEqual(hmacHex(secret, rawBody), signature);
};

/** Applies a verified Razorpay event. Idempotent: replays and unknown links are acknowledged without changes. */
export const handleRazorpayEvent = async (body: any): Promise<{ result: 'paid' | 'duplicate' | 'ignored' | 'updated' }> => {
  const event = body?.event as string | undefined;
  const link = body?.payload?.payment_link?.entity;
  if (!event || !link?.id) return { result: 'ignored' };
  const inv = await Invoice.findOne({ 'paymentLink.id': link.id });
  if (!inv) return { result: 'ignored' };

  if (event === 'payment_link.paid') {
    const paymentId: string | undefined = body?.payload?.payment?.entity?.id;
    if (typeof link.amount_paid === 'number' && link.amount_paid !== inv.totalPaise) {
      logger.warn({ invoiceNo: inv.invoiceNo }, 'razorpay paid amount does not match invoice total; not marking paid');
      return { result: 'ignored' };
    }
    const done = await Invoice.findOneAndUpdate(
      { _id: inv._id, status: 'issued' },
      { status: 'paid', paidAt: new Date(), paidRef: paymentId, 'paymentLink.status': 'paid' },
      { new: true },
    );
    if (!done) return { result: 'duplicate' };
    await recordPlatformAudit({ action: 'invoice.paid', targetType: 'invoice', targetId: String(inv._id), tenantId: inv.tenantId, meta: { invoiceNo: inv.invoiceNo, via: 'razorpay', paymentId } });
    return { result: 'paid' };
  }
  if (event === 'payment_link.cancelled' || event === 'payment_link.expired') {
    await Invoice.updateOne({ _id: inv._id }, { 'paymentLink.status': event === 'payment_link.expired' ? 'expired' : 'cancelled' });
    return { result: 'updated' };
  }
  return { result: 'ignored' };
};

export const assertWebhookConfigured = () => {
  if (!env.RAZORPAY_WEBHOOK_SECRET) throw new AppError(503, 'WEBHOOK_NOT_CONFIGURED', 'Razorpay webhook secret is not configured.');
};
