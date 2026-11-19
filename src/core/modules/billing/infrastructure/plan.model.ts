import mongoose, { Schema, model, type Model } from 'mongoose';

export interface PlanDoc {
  _id: any;
  key: string;
  name: string;
  description?: string;
  /** monthly base price in paise (integer) */
  basePricePaise: number;
  /** add-on modules bundled in the price (not billed separately) */
  includedModules: string[];
  /** max ACTIVE staff accounts (owner included); null/undefined = unlimited */
  maxStaff?: number | null;
  active: boolean;
}

const planSchema = new Schema<PlanDoc>(
  {
    key: { type: String, required: true, unique: true, match: /^[a-z0-9-]{2,30}$/ },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    description: { type: String, maxlength: 300 },
    basePricePaise: { type: Number, required: true, min: 0 },
    includedModules: { type: [String], default: [] },
    maxStaff: { type: Number, min: 1, default: null },
    active: { type: Boolean, default: true },
  },
  { timestamps: true },
);

export const Plan: Model<PlanDoc> = (mongoose.models.Plan as Model<PlanDoc>) || model<PlanDoc>('Plan', planSchema);
