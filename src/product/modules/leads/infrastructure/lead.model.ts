import { Schema } from 'mongoose';
import { defineTenantModel } from '../../../../shared/infra/tenantDb.js';
import { LEAD_STAGES } from '../domain/lead.domain.js';

const leadSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    phone: { type: String, required: true }, // normalised +91XXXXXXXXXX, unique per organisation
    email: { type: String, lowercase: true, trim: true },
    city: { type: String, trim: true, maxlength: 80 },
    interestedCourse: { type: String, trim: true, maxlength: 120 },
    source: {
      channel: { type: String, required: true }, // meta_ads | google_ads | website | whatsapp | walk_in | import | api
      utmSource: String,
      utmMedium: String,
      utmCampaign: String,
    },
    stage: { type: String, enum: LEAD_STAGES, default: 'new' },
    assignedTo: String,
    // DPDP: record that the student/parent agreed to be contacted, how, and when.
    consent: { given: { type: Boolean, required: true }, source: String, at: Date },
    stageHistory: [{ _id: false, from: String, to: String, by: String, note: String, at: { type: Date, default: Date.now } }],
    createdBy: String,
  },
  { timestamps: true },
);
leadSchema.index({ phone: 1 }, { unique: true });
leadSchema.index({ stage: 1, createdAt: -1 });
leadSchema.index({ assignedTo: 1, stage: 1 });

export const LeadModel = defineTenantModel('Lead', leadSchema);
