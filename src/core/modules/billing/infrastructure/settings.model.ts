import mongoose, { Schema, model, type Model } from 'mongoose';

/** Our own company details printed on invoices. A single document (_id "platform"). Master DB. */
export interface PlatformSettingsDoc {
  _id: string;
  legalName?: string;
  gstin?: string;
  pan?: string;
  address?: string;
  state?: string;
  email?: string;
  phone?: string;
  bank?: { name?: string; account?: string; ifsc?: string };
  invoiceFooter?: string;
  /** GST in basis points, 1800 = 18% */
  gstRateBps: number;
}

const settingsSchema = new Schema<PlatformSettingsDoc>(
  {
    _id: { type: String, default: 'platform' },
    legalName: { type: String, maxlength: 160 },
    gstin: { type: String, maxlength: 15 },
    pan: { type: String, maxlength: 10 },
    address: { type: String, maxlength: 400 },
    state: { type: String, maxlength: 60 },
    email: { type: String, maxlength: 120 },
    phone: { type: String, maxlength: 30 },
    bank: { type: new Schema({ name: String, account: String, ifsc: String }, { _id: false }), default: undefined },
    invoiceFooter: { type: String, maxlength: 500 },
    gstRateBps: { type: Number, default: 1800, min: 0, max: 10_000 },
  },
  { timestamps: true },
);

export const PlatformSettings: Model<PlatformSettingsDoc> =
  (mongoose.models.PlatformSettings as Model<PlatformSettingsDoc>) || model<PlatformSettingsDoc>('PlatformSettings', settingsSchema);

/** An organisation's billing identity (who the invoice is addressed to). Kept in billing, one per organisation. Master DB. */
export interface BillingDetailsDoc {
  tenantId: string;
  legalName?: string;
  gstin?: string;
  address?: string;
  state?: string;
}

const detailsSchema = new Schema<BillingDetailsDoc>(
  {
    tenantId: { type: String, required: true, unique: true },
    legalName: { type: String, maxlength: 160 },
    gstin: { type: String, maxlength: 15 },
    address: { type: String, maxlength: 400 },
    state: { type: String, maxlength: 60 },
  },
  { timestamps: true },
);

export const BillingDetails: Model<BillingDetailsDoc> =
  (mongoose.models.BillingDetails as Model<BillingDetailsDoc>) || model<BillingDetailsDoc>('BillingDetails', detailsSchema);
