import { Schema } from 'mongoose';
import { defineTenantModel } from '../../../../shared/infra/tenantDb.js';

export const REFERRAL_STATUSES = ['pending', 'enrolled', 'rewarded', 'rejected'] as const;
export type ReferralStatus = (typeof REFERRAL_STATUSES)[number];

const referralProgramSchema = new Schema(
  {
    enabled: { type: Boolean, default: true },
    rewardAmountRupees: { type: Number, default: 2000, min: 0 },
    rewardDescription: { type: String, default: '₹2,000 Amazon Gift Card or Admission Fee Cashback on successful admission' },
    termsAndConditions: { type: String, default: 'Reward is credited after the referred student completes admission confirmation.' },
  },
  { timestamps: true },
);

const referralSchema = new Schema(
  {
    referralCode: { type: String, required: true, uppercase: true, trim: true, index: true },
    referrerStudentId: { type: String, required: true, index: true },
    referrerName: { type: String, required: true },
    referrerPhone: { type: String, required: true },

    referredLeadId: { type: String, index: true },
    referredStudentId: { type: String, index: true },
    referredName: { type: String, required: true },
    referredPhone: { type: String, required: true },

    status: { type: String, enum: REFERRAL_STATUSES, default: 'pending', index: true },
    rewardAmountRupees: { type: Number, default: 0 },
    rewardNotes: String,
    rewardedAt: Date,
  },
  { timestamps: true },
);

referralSchema.index({ referralCode: 1, referredPhone: 1 });
referralSchema.index({ createdAt: -1 });

export const ReferralProgramModel = defineTenantModel('ReferralProgram', referralProgramSchema);
export const ReferralModel = defineTenantModel('Referral', referralSchema);

