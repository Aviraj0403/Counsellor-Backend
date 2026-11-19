import { Schema } from 'mongoose';
import { defineTenantModel } from '../../../../shared/infra/tenantDb.js';

const configSchema = new Schema(
  {
    key: { type: String, default: 'main' }, // one document per organisation
    pixelId: { type: String, trim: true, default: '' },
    pageId: { type: String, trim: true },
    accessTokenEnc: String, // AES-256-GCM ciphertext (encryptString). Never returned by the API.
    verifyToken: { type: String, required: true },
    testEventCode: { type: String, trim: true },
    eventMap: { type: Schema.Types.Mixed },
    enabled: { type: Boolean, default: false },
    // ---- insights sync (ad accounts, version, status of the last runs)
    adAccountIds: { type: [String], default: [] }, // "act_123"
    apiVersion: String, // empty = the server default (META_GRAPH_VERSION)
    tokenHint: String, // last 4 characters only
    lastSyncAt: Date,
    lastSuccessAt: Date, // unset again when the ad accounts change, so the next sync backfills
    lastError: String,
    lastErrorCode: String,
    consecutiveFailures: { type: Number, default: 0 },
    lastSyncRows: { type: Number, default: 0 },
    currency: String,
    currencyMismatch: { type: Boolean, default: false },
  },
  { timestamps: true },
);
configSchema.index({ key: 1 }, { unique: true });
export const MetaConfigModel = defineTenantModel('MetaConfig', configSchema);

const eventSchema = new Schema(
  {
    kind: { type: String, enum: ['conversion', 'test', 'lead_ad'], required: true },
    leadId: String,
    eventName: String,
    eventId: String,
    status: { type: String, enum: ['sent', 'failed', 'skipped'], required: true },
    attempts: { type: Number, default: 0 },
    httpStatus: Number,
    error: String,
    at: { type: Date, default: Date.now },
  },
  { timestamps: false },
);
eventSchema.index({ at: -1 });
eventSchema.index({ eventId: 1, status: 1 });
export const MetaEventModel = defineTenantModel('MetaEvent', eventSchema);

/** One row per day and campaign. spend = integer minor units of `currency` (paise when INR). */
const insightSchema = new Schema({
  date: { type: String, required: true, match: /^d{4}-d{2}-d{2}$/ },
  campaignId: { type: String, required: true },
  campaignName: { type: String, default: '' },
  accountId: String,
  spend: { type: Number, default: 0 },
  currency: { type: String, default: 'INR' },
  currencyMismatch: { type: Boolean, default: false },
  impressions: { type: Number, default: 0 },
  reach: { type: Number, default: 0 },
  clicks: { type: Number, default: 0 },
  leads: { type: Number, default: 0 },
  syncedAt: { type: Date, default: Date.now },
});
insightSchema.index({ date: 1, campaignId: 1 }, { unique: true });
export const MetaInsightDailyModel = defineTenantModel('MetaInsightDaily', insightSchema);

/** Which campaign/ad a lead that came through the lead-ads webhook belongs to. One row per Meta lead (leadgenId). */
const leadLinkSchema = new Schema({
  leadgenId: { type: String, required: true },
  leadId: { type: String, required: true },
  campaignId: String,
  campaignName: String,
  adsetId: String,
  adId: String,
  formId: String,
  at: { type: Date, default: Date.now },
});
leadLinkSchema.index({ leadgenId: 1 }, { unique: true });
leadLinkSchema.index({ at: -1 });
export const MetaLeadLinkModel = defineTenantModel('MetaLeadLink', leadLinkSchema);

/** Alerts raised by the sync. One open alert per code; `clearedAt` is set when the condition goes away. */
const alertSchema = new Schema({
  code: { type: String, required: true },
  severity: { type: String, enum: ['warning', 'critical'], required: true },
  title: String,
  detail: String,
  raisedAt: { type: Date, default: Date.now },
  clearedAt: Date,
});
alertSchema.index({ code: 1, clearedAt: 1 });
export const MetaAlertModel = defineTenantModel('MetaAlert', alertSchema);
