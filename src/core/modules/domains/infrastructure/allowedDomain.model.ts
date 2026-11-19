import mongoose, { Schema, model, type Model } from 'mongoose';

export const DOMAIN_KINDS = ['admin', 'portal', 'public_site', 'other'] as const;

/** A browser origin the superadmin allowed from the console (master DB). Static ones come from server config, not from here. */
export interface AllowedDomainDoc {
  _id: any;
  origin: string;
  label?: string;
  kind: (typeof DOMAIN_KINDS)[number];
  /** set when the domain belongs to one organisation (its own admin / portal / website address) */
  tenantId?: string | null;
  active: boolean;
  note?: string;
  addedBy?: string;
  createdAt: Date;
}

const schema = new Schema<AllowedDomainDoc>(
  {
    origin: { type: String, required: true, unique: true, lowercase: true },
    label: { type: String, maxlength: 120 },
    kind: { type: String, enum: DOMAIN_KINDS, default: 'admin' },
    tenantId: { type: String, default: null, index: true },
    active: { type: Boolean, default: true },
    note: { type: String, maxlength: 300 },
    addedBy: String,
  },
  { timestamps: true },
);

export const AllowedDomain: Model<AllowedDomainDoc> =
  (mongoose.models.AllowedDomain as Model<AllowedDomainDoc>) || model<AllowedDomainDoc>('AllowedDomain', schema);
