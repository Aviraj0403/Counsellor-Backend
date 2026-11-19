import { Schema } from 'mongoose';
import { defineTenantModel } from '../../../../shared/infra/tenantDb.js';
import { BANDS, CHANNELS, STATUSES } from '../domain/bots.domain.js';

/** One document per organisation (key = 'default'). */
const settingsSchema = new Schema(
  {
    key: { type: String, default: 'default' },
    orgSlug: { type: String, trim: true, lowercase: true },
    enabled: { type: Boolean, default: false },
    name: { type: String, trim: true, maxlength: 60, default: 'Admissions Assistant' },
    greeting: { type: String, trim: true, maxlength: 400, default: 'Hi! I am an AI assistant. I can answer questions about colleges and courses and help you book a counselling call. What are you looking for?' },
    languages: { type: [String], default: ['en', 'hi', 'hinglish'] },
    handoffKeywords: { type: [String], default: [] },
    workingHoursNote: { type: String, trim: true, maxlength: 200, default: '' },
    consentText: { type: String, trim: true, maxlength: 400, default: 'I agree to chat with an AI assistant and to be contacted by this organisation about admissions. My messages are stored for a limited time.' },
    qualificationFields: { type: [String], default: ['course', 'stage', 'percentage', 'budgetBand', 'city', 'timeline'] },
    publicChannelEnabled: { type: Boolean, default: true },
    retentionDays: { type: Number, min: 1, max: 365, default: 90 },
    dailyMessageCap: { type: Number, min: 0, default: 500 },
    /** 0 = no monthly limit */
    monthlyBudgetPaise: { type: Number, min: 0, default: 50000 },
  },
  { timestamps: true },
);
settingsSchema.index({ key: 1 }, { unique: true });

const messageSchema = new Schema(
  {
    role: { type: String, enum: ['user', 'assistant', 'staff'], required: true },
    text: { type: String, default: '', maxlength: 3000 },
    at: { type: Date, default: Date.now },
    toolSummary: { type: String, maxlength: 300 },
  },
  { _id: false },
);

const conversationSchema = new Schema(
  {
    channel: { type: String, enum: CHANNELS, required: true },
    visitorTokenHash: { type: String, required: true },
    leadId: String,
    studentId: String,
    status: { type: String, enum: STATUSES, default: 'open' },
    language: String,
    qualification: {
      course: String,
      stage: String,
      budgetBand: String,
      city: String,
      percentage: Number,
      timeline: String,
    },
    score: { type: Number, default: 0 },
    band: { type: String, enum: BANDS, default: 'cold' },
    scoreReasons: { type: [String], default: [] },
    askedForCounsellor: { type: Boolean, default: false },
    bookedAppointment: { type: Boolean, default: false },
    appointmentId: String,
    guardian: { name: String, phone: String },
    messages: { type: [messageSchema], default: [] },
    handoff: { at: Date, reason: String, assignedTo: String, takenOverBy: String },
    consent: { given: { type: Boolean, default: false }, at: Date },
    minor: { suspected: { type: Boolean, default: false }, guardianConsent: { type: Boolean, default: false }, sinceTurn: Number },
    userTurns: { type: Number, default: 0 },
    tokens: { in: { type: Number, default: 0 }, out: { type: Number, default: 0 } },
    costPaise: { type: Number, default: 0 },
    lastMessageAt: { type: Date, default: Date.now },
    expiresAt: { type: Date, required: true },
    erasedAt: Date,
  },
  { timestamps: true },
);
conversationSchema.index({ visitorTokenHash: 1, channel: 1 });
conversationSchema.index({ status: 1, lastMessageAt: -1 });
conversationSchema.index({ leadId: 1 });
conversationSchema.index({ studentId: 1 });
conversationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 }); // TTL: Mongo deletes expired conversations in the background

/** Daily counters (no personal data): messages, tokens, cost. Survive the purge of conversations. */
const usageSchema = new Schema(
  {
    day: { type: String, required: true },
    messages: { type: Number, default: 0 },
    handoffs: { type: Number, default: 0 },
    leadsCaptured: { type: Number, default: 0 },
    bookings: { type: Number, default: 0 },
    conversations: { type: Number, default: 0 },
    tokensIn: { type: Number, default: 0 },
    tokensOut: { type: Number, default: 0 },
    costPaise: { type: Number, default: 0 },
  },
  { timestamps: true },
);
usageSchema.index({ day: 1 }, { unique: true });

export const BotSettingsModel = defineTenantModel('BotSettings', settingsSchema);
export const ConversationModel = defineTenantModel('BotConversation', conversationSchema);
export const BotUsageModel = defineTenantModel('BotUsage', usageSchema);
