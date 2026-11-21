import { Schema } from 'mongoose';
import { defineTenantModel } from '../../../../shared/infra/tenantDb.js';

const partnerDirectorySchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    type: { type: String, enum: ['coaching_institute', 'junior_college', 'school', 'polytechnic'], required: true },
    city: { type: String, required: true, trim: true },
    state: { type: String, trim: true },
    address: { type: String, trim: true },
    phone: { type: String, trim: true },
    email: { type: String, lowercase: true, trim: true },
    website: { type: String, trim: true },
    contactPerson: { type: String, trim: true },
    designation: { type: String, trim: true },
    estStudentsCount: { type: Number, default: 0 },
    status: {
      type: String,
      enum: ['identified', 'contacted', 'meeting_scheduled', 'partnered', 'declined'],
      default: 'identified',
    },
    notes: { type: String, trim: true },
    source: { type: String, default: 'directory' },
    lastOutreachAt: Date,
  },
  { timestamps: true }
);

partnerDirectorySchema.index({ city: 1, type: 1, status: 1 });
partnerDirectorySchema.index({ name: 1 });

export const PartnerDirectoryModel = defineTenantModel('PartnerDirectory', partnerDirectorySchema);

