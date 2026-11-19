import { PdfDoc } from '../../../../shared/infra/pdf.js';
import type { InvoiceDoc } from '../infrastructure/invoice.model.js';
import type { PlatformSettingsDoc } from '../infrastructure/settings.model.js';

/** "Rs. 1,23,456.78" (Indian digit grouping), from integer paise. */
export const formatInr = (paise: number): string => {
  const neg = paise < 0;
  const abs = Math.abs(paise);
  const rupees = String(Math.floor(abs / 100));
  const last3 = rupees.slice(-3);
  const rest = rupees.slice(0, -3);
  const grouped = rest ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}` : last3;
  return `${neg ? '-' : ''}Rs. ${grouped}.${String(abs % 100).padStart(2, '0')}`;
};

const pct = (bps: number): string => `${bps / 100}%`;

/** Renders one invoice as a PDF. Uses the seller/buyer details frozen on the invoice (fallback: current company settings). */
export const renderInvoicePdf = (inv: InvoiceDoc, fallbackSeller?: Partial<PlatformSettingsDoc>, footer?: string, bank?: PlatformSettingsDoc['bank']): Buffer => {
  const seller = { ...fallbackSeller, ...(inv.seller ?? {}) } as Record<string, string | undefined>;
  const buyer = (inv.buyer ?? {}) as Record<string, string | undefined>;
  const d = new PdfDoc();
  d.text('TAX INVOICE', { size: 18, bold: true });
  d.text(`Invoice No: ${inv.invoiceNo}`, { bold: true });
  d.text(`Date: ${new Date(inv.issuedAt).toISOString().slice(0, 10)}    Period: ${inv.period}    Status: ${inv.status.toUpperCase()}`);
  d.rule();
  d.text('From', { bold: true });
  d.text(seller.legalName || '(company name not set)');
  if (seller.address) d.text(seller.address);
  if (seller.state) d.text(`State: ${seller.state}`);
  d.text(`GSTIN: ${seller.gstin || '-'}${seller.pan ? `    PAN: ${seller.pan}` : ''}`);
  d.space();
  d.text('Bill to', { bold: true });
  d.text(buyer.legalName || '-');
  if (buyer.address) d.text(buyer.address);
  if (buyer.state) d.text(`State: ${buyer.state}`);
  d.text(`GSTIN: ${buyer.gstin || '-'}`);
  d.rule();
  d.row([{ text: 'Description', x: d.leftX }, { text: 'Amount', x: d.rightX, align: 'right' }], { bold: true });
  d.rule();
  for (const l of inv.lines) d.row([{ text: l.label, x: d.leftX }, { text: formatInr(l.amountPaise), x: d.rightX, align: 'right' }]);
  d.rule();
  const sum = (label: string, paise: number, bold = false) =>
    d.row([{ text: label, x: d.rightX - 140, align: 'right' }, { text: formatInr(paise), x: d.rightX, align: 'right' }], { bold });
  sum('Subtotal', inv.subtotalPaise);
  const half = (inv.gstRateBps ?? 1800) / 2;
  if (inv.igstPaise > 0 || (!inv.cgstPaise && !inv.sgstPaise)) sum(`IGST @ ${pct(inv.gstRateBps ?? 1800)}`, inv.igstPaise ?? 0);
  else {
    sum(`CGST @ ${pct(half)}`, inv.cgstPaise);
    sum(`SGST @ ${pct(half)}`, inv.sgstPaise);
  }
  sum('Total', inv.totalPaise, true);
  if (inv.status === 'paid') d.text(`Paid${inv.paidRef ? ` (ref ${inv.paidRef})` : ''}`, { bold: true });
  if (bank?.account) {
    d.space(12);
    d.text('Bank details', { bold: true });
    d.text(`${bank.name ?? ''}  A/c ${bank.account}  IFSC ${bank.ifsc ?? ''}`);
  }
  if (inv.paymentLink?.url && inv.status === 'issued') d.text(`Pay online: ${inv.paymentLink.url}`);
  if (footer) {
    d.space(12);
    d.text(footer, { size: 8 });
  }
  return d.toBuffer();
};
