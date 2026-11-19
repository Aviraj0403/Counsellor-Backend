import mongoose, { Schema } from 'mongoose';
import { defineTenantModel, tenantDbName } from '../../../../shared/infra/tenantDb.js';

const keySchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    prefix: { type: String, required: true }, // harmless display part
    hash: { type: String, required: true }, // SHA-256 of the full key; the key itself is never stored
    scopes: { type: [String], default: [] },
    collegeId: String,
    createdBy: String,
    lastUsedAt: Date,
    revokedAt: Date,
  },
  { timestamps: true },
);
keySchema.index({ hash: 1 }, { unique: true });
export const ApiKeyModel = defineTenantModel('ApiKey', keySchema);

const webhookSchema = new Schema(
  {
    url: { type: String, required: true },
    events: { type: [String], default: [] },
    secretEnc: { type: String, required: true }, // AES-256-GCM; shown once at creation, never returned again
    active: { type: Boolean, default: true },
    failureCount: { type: Number, default: 0 },
    createdBy: String,
  },
  { timestamps: true },
);
export const WebhookModel = defineTenantModel('Webhook', webhookSchema);

const deliverySchema = new Schema(
  {
    webhookId: { type: String, required: true },
    event: { type: String, required: true },
    eventId: { type: String, required: true },
    body: { type: String, required: true }, // the exact JSON that is signed and sent (ids and minimal fields only)
    status: { type: String, enum: ['retrying', 'delivered', 'failed'], default: 'retrying' },
    attempts: { type: Number, default: 0 },
    responseCode: Number,
    error: String,
    nextAttemptAt: Date,
    lastAttemptAt: Date,
    at: { type: Date, default: Date.now },
  },
  { timestamps: false },
);
deliverySchema.index({ at: -1 });
deliverySchema.index({ status: 1, nextAttemptAt: 1 });
export const WebhookDeliveryModel = defineTenantModel('WebhookDelivery', deliverySchema);

/** Ids of every organisation database that exists (for retrying across all organisations from a scheduler). */
export const listTenantIds = async (): Promise<string[]> => {
  const prefix = tenantDbName('0'.repeat(24)).slice(0, -24); // naming stays in shared/infra/tenantDb
  const dbs = await mongoose.connection.getClient().db().admin().listDatabases();
  return dbs.databases.map((d) => d.name).filter((n) => n.startsWith(prefix) && /^[0-9a-f]{24}$/i.test(n.slice(prefix.length))).map((n) => n.slice(prefix.length));
};
