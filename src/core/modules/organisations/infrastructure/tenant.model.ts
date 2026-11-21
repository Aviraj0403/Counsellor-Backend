import mongoose, { Schema, model, type Model } from 'mongoose';

export interface TenantSettings {
  /** If true, counsellors in the organisation can view all students, not just those assigned to them */
  counsellorAllStudentsVisible?: boolean;
}

/** An organisation (counsellor business). Master DB. Student/lead data does NOT live here, it lives in the organisation's own database. */
export interface TenantDoc {
  _id: any;
  name: string;
  slug: string;
  status: 'active' | 'suspended';
  /** per-module switches set by the superadmin; resolved by resolveModules() */
  modules: Record<string, boolean>;
  /** commercial plan (Plan.key); null = no plan (custom / trial) */
  planKey?: string | null;
  /** negotiated monthly price in RUPEES per module, overrides the catalogue price (0 = free for this customer) */
  priceOverrides?: Record<string, number>;
  /** https URL of the organisation's logo and an optional brand colour (#rrggbb), shown in the admin */
  logoUrl?: string | null;
  brandColor?: string | null;
  settings?: TenantSettings;
  createdAt: Date;
}

const tenantSchema = new Schema<TenantDoc>(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    slug: { type: String, required: true, unique: true, lowercase: true, match: /^[a-z0-9-]{3,40}$/ },
    status: { type: String, enum: ['active', 'suspended'], default: 'active' },
    modules: { type: Schema.Types.Mixed, default: {} },
    planKey: { type: String, default: null },
    priceOverrides: { type: Schema.Types.Mixed, default: {} },
    logoUrl: { type: String, maxlength: 500, default: null },
    brandColor: { type: String, match: /^#[0-9a-fA-F]{6}$/, default: null },
    settings: {
      counsellorAllStudentsVisible: { type: Boolean, default: true },
    },
  },
  { timestamps: true, minimize: false },
);

export const Tenant: Model<TenantDoc> = (mongoose.models.Tenant as Model<TenantDoc>) || model<TenantDoc>('Tenant', tenantSchema);
