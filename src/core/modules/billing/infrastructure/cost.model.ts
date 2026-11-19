import { Schema, model, models, type Model } from 'mongoose';

export const COST_CATEGORIES = ['hosting', 'whatsapp', 'sms', 'email', 'storage', 'ai', 'ads', 'support', 'other'] as const;

export interface CostDoc {
  _id: any;
  month: string;
  category: (typeof COST_CATEGORIES)[number];
  amountPaise: number;
  /** blank = shared platform cost; set = caused by one organisation */
  tenantId?: string;
  note?: string;
  voided: boolean;
  createdBy?: string;
  createdAt: Date;
}

const costSchema = new Schema<CostDoc>(
  {
    month: { type: String, required: true, match: /^\d{4}-(0[1-9]|1[0-2])$/, index: true },
    category: { type: String, enum: COST_CATEGORIES, required: true },
    amountPaise: { type: Number, required: true, min: 1 },
    tenantId: { type: String, index: true },
    note: { type: String, maxlength: 300 },
    voided: { type: Boolean, default: false },
    createdBy: String,
  },
  { timestamps: true },
);

export const CostEntry: Model<CostDoc> = (models.CostEntry as Model<CostDoc>) || model<CostDoc>('CostEntry', costSchema);
