import { Schema, model, models, type Model } from 'mongoose';

export interface InvoiceLine {
  code: string;
  label: string;
  amountPaise: number;
}

/** Who issued / who is billed, copied onto the invoice when it is issued so later edits never rewrite an old invoice. */
export interface InvoiceParty {
  legalName?: string;
  gstin?: string;
  pan?: string;
  address?: string;
  state?: string;
}

export interface PaymentLink {
  id: string;
  url: string;
  /** Razorpay payment link status: created, paid, cancelled, expired ... */
  status: string;
  createdAt: Date;
}

export interface InvoiceDoc {
  _id: any;
  invoiceNo: string;
  tenantId: string;
  /** billing month, YYYY-MM */
  period: string;
  lines: InvoiceLine[];
  subtotalPaise: number;
  /** GST rate used for this invoice, basis points */
  gstRateBps: number;
  supply?: 'intra' | 'inter';
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  gstPaise: number;
  totalPaise: number;
  seller?: InvoiceParty;
  buyer?: InvoiceParty;
  status: 'issued' | 'paid' | 'void';
  paidAt?: Date;
  /** payment reference: a manual note, or the Razorpay payment id */
  paidRef?: string;
  paymentLink?: PaymentLink;
  issuedAt: Date;
}

const partySchema = new Schema({ legalName: String, gstin: String, pan: String, address: String, state: String }, { _id: false });

const invoiceSchema = new Schema<InvoiceDoc>(
  {
    invoiceNo: { type: String, required: true, unique: true },
    tenantId: { type: String, required: true, index: true },
    period: { type: String, required: true, match: /^\d{4}-(0[1-9]|1[0-2])$/ },
    lines: { type: [{ _id: false, code: String, label: String, amountPaise: Number }], required: true },
    subtotalPaise: { type: Number, required: true },
    gstRateBps: { type: Number, default: 1800 },
    supply: { type: String, enum: ['intra', 'inter'] },
    cgstPaise: { type: Number, default: 0 },
    sgstPaise: { type: Number, default: 0 },
    igstPaise: { type: Number, default: 0 },
    gstPaise: { type: Number, required: true },
    totalPaise: { type: Number, required: true },
    seller: { type: partySchema, default: undefined },
    buyer: { type: partySchema, default: undefined },
    status: { type: String, enum: ['issued', 'paid', 'void'], default: 'issued' },
    paidAt: Date,
    paidRef: { type: String, maxlength: 120 },
    paymentLink: { type: new Schema({ id: String, url: String, status: String, createdAt: Date }, { _id: false }), default: undefined },
    issuedAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);
invoiceSchema.index({ tenantId: 1, period: 1 }, { unique: true }); // one invoice per organisation per month
invoiceSchema.index({ 'paymentLink.id': 1 }, { sparse: true }); // webhook lookup

export const Invoice: Model<InvoiceDoc> = (models.Invoice as Model<InvoiceDoc>) || model<InvoiceDoc>('Invoice', invoiceSchema);

/** Yearly running number for invoice numbers (CP-2026-0001). */
const counterSchema = new Schema<{ _id: string; seq: number }>({ _id: String, seq: { type: Number, default: 0 } });
export const Counter: Model<{ _id: string; seq: number }> =
  (models.Counter as Model<{ _id: string; seq: number }>) || model<{ _id: string; seq: number }>('Counter', counterSchema);
