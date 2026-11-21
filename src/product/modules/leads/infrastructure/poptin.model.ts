import { Schema } from 'mongoose';
import { defineTenantModel } from '../../../../shared/infra/tenantDb.js';

const poptinConfigSchema = new Schema(
  {
    key: { type: String, default: 'default' },
    enabled: { type: Boolean, default: false },
    headline: { type: String, trim: true, maxlength: 140, default: 'Looking for Direct B.Tech Admission in Top Colleges?' },
    subheadline: { type: String, trim: true, maxlength: 300, default: 'Get free cutoff analysis, college fee comparisons and direct seat guidance from verified expert counsellors.' },
    allowedDomains: { type: [String], default: [] },
    triggers: {
      exitIntent: { type: Boolean, default: true },
      timeDelaySeconds: { type: Number, default: 5, min: 0, max: 300 },
      scrollPercentage: { type: Number, default: 40, min: 0, max: 100 },
    },
    design: {
      themeColor: { type: String, default: '#2563eb' },
      buttonText: { type: String, default: 'Get Free Counselling Call' },
      buttonColor: { type: String, default: '#2563eb' },
      buttonTextColor: { type: String, default: '#ffffff' },
      backgroundColor: { type: String, default: '#ffffff' },
      textColor: { type: String, default: '#0f172a' },
    },
    viewsCount: { type: Number, default: 0 },
    conversionsCount: { type: Number, default: 0 },
  },
  { timestamps: true },
);

poptinConfigSchema.index({ key: 1 }, { unique: true });

export const PoptinConfigModel = defineTenantModel('PoptinConfig', poptinConfigSchema);

