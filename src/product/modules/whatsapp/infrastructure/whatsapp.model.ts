import { Schema } from 'mongoose';
import { defineTenantModel } from '../../../../shared/infra/tenantDb.js';
import { MESSAGE_STATUSES, RULE_EVENTS } from '../domain/whatsapp.domain.js';

const templateSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 80 }, // must equal the approved template name at Meta
    language: { type: String, required: true, default: 'en', maxlength: 10 },
    body: { type: String, required: true, maxlength: 1024 },
    purpose: { type: String, trim: true, maxlength: 200 },
    active: { type: Boolean, default: true },
  },
  { timestamps: true },
);
templateSchema.index({ name: 1, language: 1 }, { unique: true });

const messageSchema = new Schema(
  {
    direction: { type: String, enum: ['out', 'in'], default: 'out' },
    leadId: String,
    studentId: String,
    to: { type: String, required: true }, // +91... (for inbound: the sender)
    template: String,
    language: String,
    params: [String],
    text: String, // the filled-in body (or the inbound text)
    status: { type: String, enum: MESSAGE_STATUSES, default: 'queued' },
    providerId: String,
    error: String,
    dedupeKey: String,
    sendAt: Date, // set when an automation rule delays the send
    by: String,
    at: { type: Date, default: Date.now },
  },
  { timestamps: true },
);
messageSchema.index({ leadId: 1, at: -1 });
messageSchema.index({ studentId: 1, at: -1 });
messageSchema.index({ providerId: 1 }, { sparse: true });
messageSchema.index({ dedupeKey: 1, createdAt: -1 });
messageSchema.index({ status: 1, sendAt: 1 });
messageSchema.index({ to: 1 });

const ruleSchema = new Schema(
  {
    event: { type: String, enum: RULE_EVENTS, required: true },
    filter: { type: String, trim: true, maxlength: 60 }, // stage / status / channel; empty = every event
    template: { type: String, required: true },
    language: { type: String, default: 'en' },
    params: [String], // may use {name} {course} {city}
    delayMinutes: { type: Number, default: 0, min: 0, max: 60 * 24 * 30 },
    active: { type: Boolean, default: true },
  },
  { timestamps: true },
);
ruleSchema.index({ event: 1, active: 1 });

export const TemplateModel = defineTenantModel('WhatsappTemplate', templateSchema);
export const MessageModel = defineTenantModel('WhatsappMessage', messageSchema);
export const RuleModel = defineTenantModel('WhatsappRule', ruleSchema);
