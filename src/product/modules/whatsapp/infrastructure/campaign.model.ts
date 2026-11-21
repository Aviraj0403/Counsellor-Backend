import { Schema } from 'mongoose';
import { defineTenantModel } from '../../../../shared/infra/tenantDb.js';

export const CAMPAIGN_STATUSES = ['draft', 'scheduled', 'processing', 'completed', 'cancelled', 'failed'] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

export const CAMPAIGN_AUDIENCES = ['leads', 'students', 'all'] as const;
export type CampaignAudience = (typeof CAMPAIGN_AUDIENCES)[number];

const broadcastCampaignSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    template: { type: String, required: true, trim: true, maxlength: 80 },
    language: { type: String, default: 'en', maxlength: 10 },
    audience: { type: String, enum: CAMPAIGN_AUDIENCES, default: 'leads' },
    // Filter criteria
    filters: {
      stage: { type: String, trim: true }, // for leads: new, contacted, interested...
      city: { type: String, trim: true },
      course: { type: String, trim: true },
    },
    // Template variable mapping (e.g. ["name", "course", "city"])
    paramMapping: [{ type: String, trim: true }],
    status: { type: String, enum: CAMPAIGN_STATUSES, default: 'draft' },
    scheduledAt: Date,
    startedAt: Date,
    completedAt: Date,
    stats: {
      total: { type: Number, default: 0 },
      sent: { type: Number, default: 0 },
      failed: { type: Number, default: 0 },
      skippedNoConsent: { type: Number, default: 0 },
    },
    failReason: String,
    createdBy: String,
  },
  { timestamps: true },
);

broadcastCampaignSchema.index({ status: 1, scheduledAt: 1 });
broadcastCampaignSchema.index({ createdAt: -1 });

export const BroadcastCampaignModel = defineTenantModel('WhatsappCampaign', broadcastCampaignSchema);

