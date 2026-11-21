import { Schema } from 'mongoose';
import { defineTenantModel } from '../../../../shared/infra/tenantDb.js';

export const FEE_PAYMENT_STATUSES = ['created', 'paid', 'partially_paid', 'expired', 'cancelled', 'failed'] as const;
export type FeePaymentStatus = (typeof FEE_PAYMENT_STATUSES)[number];

const studentFeeLinkSchema = new Schema(
  {
    studentId: { type: String, required: true, index: true },
    applicationId: { type: String, index: true },
    title: { type: String, required: true, trim: true, maxlength: 150 }, // e.g. "Seat Booking Advance / Counselling Registration Fee"
    amountPaise: { type: Number, required: true, min: 100 }, // minimum ₹1
    currency: { type: String, default: 'INR' },
    status: { type: String, enum: FEE_PAYMENT_STATUSES, default: 'created', index: true },
    // Razorpay attributes
    razorpayLinkId: { type: String, index: true },
    shortUrl: String,
    paymentId: String,
    paidAt: Date,
    notes: { type: String, maxlength: 300 },
    createdBy: String,
  },
  { timestamps: true },
);

studentFeeLinkSchema.index({ createdAt: -1 });

export const StudentFeeLinkModel = defineTenantModel('StudentFeeLink', studentFeeLinkSchema);

