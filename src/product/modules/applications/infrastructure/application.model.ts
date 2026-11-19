import { Schema } from 'mongoose';
import { defineTenantModel } from '../../../../shared/infra/tenantDb.js';
import { STATUSES } from '../domain/application.domain.js';

const applicationSchema = new Schema(
  {
    studentId: { type: String, required: true },
    collegeId: { type: String, required: true },
    courseId: { type: String, required: true },
    intake: { month: { type: Number, required: true, min: 1, max: 12 }, year: { type: Number, required: true } },
    status: { type: String, enum: STATUSES, default: 'draft' },
    statusHistory: [{ _id: false, from: String, to: String, by: String, at: Date, note: String }],
    assignedTo: String,
    collegeRef: String,
    fee: { applicationFeePaise: Number, tuitionPaise: Number, paidPaise: { type: Number, default: 0 } },
    offer: { scholarshipPaise: Number, deadline: Date, note: String },
    notes: String,
    createdBy: String,
  },
  { timestamps: true },
);
applicationSchema.index({ studentId: 1, courseId: 1, 'intake.year': 1, 'intake.month': 1 }, { unique: true });
applicationSchema.index({ collegeId: 1, status: 1 });
applicationSchema.index({ assignedTo: 1, status: 1 });
applicationSchema.index({ status: 1, createdAt: -1 });

export const ApplicationModel = defineTenantModel('Application', applicationSchema);
