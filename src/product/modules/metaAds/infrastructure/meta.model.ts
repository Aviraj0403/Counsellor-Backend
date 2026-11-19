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
