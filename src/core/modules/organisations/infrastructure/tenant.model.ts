import { Schema, model, models, type Model } from 'mongoose';

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
  },
  { timestamps: true, minimize: false },
);

export const Tenant: Model<TenantDoc> = (models.Tenant as Model<TenantDoc>) || model<TenantDoc>('Tenant', tenantSchema);
