import { Schema } from 'mongoose';
import { defineTenantModel } from '../../../../shared/infra/tenantDb.js';

/** One document per organisation (key = 'default'). */
const settingsSchema = new Schema(
  {
    key: { type: String, default: 'default' },
    orgSlug: { type: String, trim: true, lowercase: true },
    siteTitle: { type: String, trim: true, maxlength: 120, default: '' },
    tagline: { type: String, trim: true, maxlength: 200 },
    logoUrl: { type: String, trim: true, maxlength: 400 },
    themeColor: { type: String, default: '#1d4ed8' },
    contact: { phone: String, email: String, whatsapp: String },
    /** empty = every active college is shown */
    enabledColleges: { type: [String], default: [] },
    leadFormEnabled: { type: Boolean, default: true },
    consentText: { type: String, maxlength: 400, default: 'I agree to be contacted by phone, SMS, email or WhatsApp about admissions.' },
  },
  { timestamps: true },
);
settingsSchema.index({ key: 1 }, { unique: true });

const pageSchema = new Schema(
  {
    collegeId: { type: String, required: true },
    metaTitle: { type: String, trim: true, maxlength: 120 },
    metaDescription: { type: String, trim: true, maxlength: 300 },
    heroText: { type: String, trim: true, maxlength: 500 },
    faqs: [{ _id: false, q: { type: String, required: true, maxlength: 300 }, a: { type: String, required: true, maxlength: 2000 } }],
    published: { type: Boolean, default: true },
  },
  { timestamps: true },
);
pageSchema.index({ collegeId: 1 }, { unique: true });

export const SeoSettingsModel = defineTenantModel('SeoSettings', settingsSchema);
export const CollegePageModel = defineTenantModel('CollegePage', pageSchema);
