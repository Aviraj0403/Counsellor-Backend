import { Schema } from 'mongoose';
import { defineTenantModel } from '../../../../shared/infra/tenantDb.js';

const ruleSchema = new Schema(
  {
    collegeId: { type: String, required: true },
    mode: { type: String, enum: ['percent_of_fee', 'flat', 'none'], required: true },
    percentBps: { type: Number, default: 0 },
    flatPaise: { type: Number, default: 0 },
    trigger: { type: String, enum: ['fee_paid', 'admitted'], default: 'admitted' },
    counsellorShareBps: { type: Number, default: 0 },
    active: { type: Boolean, default: true },
  },
  { timestamps: true },
);
ruleSchema.index({ collegeId: 1 }, { unique: true });
export const CommissionRuleModel = defineTenantModel('CommissionRule', ruleSchema);

const accrualSchema = new Schema(
  {
    applicationId: { type: String, required: true },
    collegeId: { type: String, required: true },
    counsellorId: String,
    totalPaise: { type: Number, required: true },
    counsellorSharePaise: { type: Number, required: true },
    organisationSharePaise: { type: Number, required: true },
    ledgerEntryId: String,
    status: { type: String, enum: ['accrued', 'collected', 'reversed'], default: 'accrued' },
    collectedAt: Date,
    collectReference: String,
    collectEntryId: String,
    reversedAt: Date,
    reverseReason: String,
  },
  { timestamps: true },
);
accrualSchema.index({ applicationId: 1 }, { unique: true }); // accrue once per application
accrualSchema.index({ counsellorId: 1, status: 1 });
accrualSchema.index({ collegeId: 1, status: 1 });
export const AccrualModel = defineTenantModel('CommissionAccrual', accrualSchema);

const payoutSchema = new Schema(
  {
    counsellorId: { type: String, required: true },
    amountPaise: { type: Number, required: true },
    reference: { type: String, required: true },
    ledgerEntryId: String,
    by: String,
  },
  { timestamps: true },
);
payoutSchema.index({ counsellorId: 1, reference: 1 }, { unique: true });
export const PayoutModel = defineTenantModel('CommissionPayout', payoutSchema);
