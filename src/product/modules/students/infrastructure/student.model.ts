import { Schema } from 'mongoose';
import { defineTenantModel } from '../../../../shared/infra/tenantDb.js';

const studentSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    phone: { type: String }, // normalised +91XXXXXXXXXX; removed when erased
    email: { type: String, lowercase: true, trim: true },
    dob: Date,
    gender: { type: String, enum: ['male', 'female', 'other'] },
    address: { line: String, city: String, state: String, pincode: String },
    guardian: { name: String, phone: String, relation: String },
    academics: [{ _id: false, level: String, board: String, institute: String, year: Number, percentage: Number }],
    testScores: [{ _id: false, test: String, score: Number, year: Number }],
    preferences: { courses: [String], cities: [String], budgetMaxPaise: Number },
    leadId: String,
    assignedTo: String,
    consent: {
      given: { type: Boolean, default: false },
      source: String,
      at: Date,
      guardianConsent: { given: Boolean, at: Date, by: String },
    },
    status: { type: String, enum: ['active', 'erased'], default: 'active' },
    erasedAt: Date,
    createdBy: String,
  },
  { timestamps: true },
);
// Unique per organisation; erased students have no phone and are not part of the index.
studentSchema.index({ phone: 1 }, { unique: true, partialFilterExpression: { phone: { $type: 'string' } } });
// One student per lead (also guards a double click / race).
studentSchema.index({ leadId: 1 }, { unique: true, partialFilterExpression: { leadId: { $type: 'string' } } });
studentSchema.index({ assignedTo: 1, createdAt: -1 });
studentSchema.index({ status: 1, createdAt: -1 });

export const StudentModel = defineTenantModel('Student', studentSchema);
