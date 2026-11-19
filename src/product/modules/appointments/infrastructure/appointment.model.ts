import { Schema } from 'mongoose';
import { defineTenantModel } from '../../../../shared/infra/tenantDb.js';
import { ASSIGNMENTS, MODES, SOURCES, STATUSES } from '../domain/appointment.domain.js';

const typeSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    description: { type: String, trim: true, maxlength: 1000 },
    mode: { type: String, enum: MODES, required: true },
    durationMin: { type: Number, required: true, min: 5, max: 480 },
    bufferBeforeMin: { type: Number, default: 0, min: 0, max: 240 },
    bufferAfterMin: { type: Number, default: 0, min: 0, max: 240 },
    minNoticeHours: { type: Number, default: 2, min: 0, max: 720 },
    maxAdvanceDays: { type: Number, default: 30, min: 1, max: 365 },
    slotStepMin: { type: Number, default: 15, min: 5, max: 240 },
    capacity: { type: Number, default: 1 },
    assignment: { type: String, enum: ASSIGNMENTS, default: 'specific' },
    counsellorIds: { type: [String], default: [] },
    intakeQuestions: [{ _id: false, key: { type: String, required: true, maxlength: 40 }, label: { type: String, required: true, maxlength: 160 }, required: { type: Boolean, default: false } }],
    cancellationNoticeHours: { type: Number, default: 4, min: 0, max: 720 },
    policyText: { type: String, trim: true, maxlength: 1000 },
    reminders: [{ _id: false, offsetMin: { type: Number, required: true, min: 1, max: 14 * 24 * 60 }, channel: { type: String, enum: ['whatsapp'], default: 'whatsapp' } }],
    publicBookable: { type: Boolean, default: false },
    active: { type: Boolean, default: true },
    locationOrLink: { type: String, trim: true, maxlength: 400 },
  },
  { timestamps: true },
);

const hoursSchema = new Schema(
  {
    counsellorId: { type: String, required: true },
    timezone: { type: String, default: 'Asia/Kolkata' },
    weekly: [{ _id: false, day: { type: Number, min: 0, max: 6, required: true }, ranges: [{ _id: false, start: String, end: String }] }],
  },
  { timestamps: true },
);
hoursSchema.index({ counsellorId: 1 }, { unique: true });

const timeOffSchema = new Schema(
  {
    counsellorId: { type: String, required: true },
    from: { type: Date, required: true },
    to: { type: Date, required: true },
    reason: { type: String, trim: true, maxlength: 200 },
  },
  { timestamps: true },
);
timeOffSchema.index({ counsellorId: 1, from: 1 });

const appointmentSchema = new Schema(
  {
    typeId: { type: String, required: true },
    counsellorId: { type: String, required: true },
    start: { type: Date, required: true },
    end: { type: Date, required: true },
    bufferBeforeMin: { type: Number, default: 0 },
    bufferAfterMin: { type: Number, default: 0 },
    status: { type: String, enum: STATUSES, default: 'booked' },
    /** true while booked/confirmed: the unique index below keys on it (simple equality works in every MongoDB version) */
    active: { type: Boolean, default: true },
    who: {
      leadId: String,
      studentId: String,
      name: { type: String, required: true, trim: true, maxlength: 120 },
      phone: { type: String, required: true },
      email: { type: String, trim: true, lowercase: true, maxlength: 160 },
    },
    answers: { type: Schema.Types.Mixed, default: {} },
    source: { type: String, enum: SOURCES, required: true },
    consent: { given: Boolean, at: Date },
    cancelReason: { type: String, maxlength: 500 },
    cancelledBy: String,
    rescheduledFrom: String,
    notes: { type: String, maxlength: 2000 },
    reminderState: [{ _id: false, offsetMin: Number, sentAt: Date }],
    manageTokenHash: { type: String, required: true },
    createdBy: String,
  },
  { timestamps: true },
);
// Two active appointments can never share a counsellor and a start time, even when two requests race.
appointmentSchema.index({ counsellorId: 1, start: 1 }, { unique: true, partialFilterExpression: { active: true } });
appointmentSchema.index({ counsellorId: 1, start: 1, status: 1 });
appointmentSchema.index({ start: 1, status: 1 });
appointmentSchema.index({ manageTokenHash: 1 });
appointmentSchema.index({ 'who.studentId': 1 }, { sparse: true });

const waitlistSchema = new Schema(
  {
    typeId: { type: String, required: true },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    phone: { type: String, required: true },
    preferredFrom: Date,
    preferredTo: Date,
    status: { type: String, enum: ['waiting', 'offered', 'booked', 'expired'], default: 'waiting' },
    offeredStart: Date,
    offeredCounsellorId: String,
    offeredAt: Date,
    createdBy: String,
  },
  { timestamps: true },
);
waitlistSchema.index({ typeId: 1, status: 1, createdAt: 1 });

export const AppointmentTypeModel = defineTenantModel('AppointmentType', typeSchema);
export const WorkingHoursModel = defineTenantModel('AppointmentWorkingHours', hoursSchema);
export const TimeOffModel = defineTenantModel('AppointmentTimeOff', timeOffSchema);
export const AppointmentModel = defineTenantModel('Appointment', appointmentSchema);
export const WaitlistModel = defineTenantModel('AppointmentWaitlist', waitlistSchema);
