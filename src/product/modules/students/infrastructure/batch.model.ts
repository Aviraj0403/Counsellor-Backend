import { Schema } from 'mongoose';
import { defineTenantModel } from '../../../../shared/infra/tenantDb.js';

export const BATCH_STATUSES = ['active', 'completed', 'archived'] as const;
export type BatchStatus = (typeof BATCH_STATUSES)[number];

export const ATTENDANCE_STATUSES = ['present', 'absent', 'late', 'excused'] as const;
export type AttendanceStatus = (typeof ATTENDANCE_STATUSES)[number];

const batchSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 }, // e.g. "2026 B.Tech JEE Main Advanced FastTrack", "MHT-CET Round 1 Batch A"
    academicYear: { type: String, required: true, trim: true, maxlength: 20 }, // e.g. "2026-2027"
    courseStream: { type: String, trim: true, maxlength: 100 }, // e.g. "Engineering / B.Tech"
    counsellorId: { type: String, index: true }, // assigned batch mentor/counsellor
    studentIds: [{ type: String, index: true }], // enrolled students in this batch
    capacity: { type: Number, default: 50, min: 1 },
    startDate: Date,
    endDate: Date,
    status: { type: String, enum: BATCH_STATUSES, default: 'active', index: true },
    notes: String,
    createdBy: String,
  },
  { timestamps: true },
);

batchSchema.index({ academicYear: 1, status: 1 });
batchSchema.index({ counsellorId: 1, status: 1 });

const sessionSchema = new Schema(
  {
    batchId: { type: String, required: true, index: true },
    title: { type: String, required: true, trim: true, maxlength: 150 }, // e.g. "CAP Round 1 College Option Form Filling Workshop"
    description: String,
    sessionDate: { type: Date, required: true, index: true },
    startTime: { type: String, required: true }, // "10:00 AM"
    endTime: { type: String, required: true }, // "11:30 AM"
    venue: { type: String, default: 'Conference Hall / Online Zoom' },
    mentorId: String,
    status: { type: String, enum: ['scheduled', 'ongoing', 'completed', 'cancelled'], default: 'scheduled' },
    attendance: [
      {
        _id: false,
        studentId: { type: String, required: true },
        status: { type: String, enum: ATTENDANCE_STATUSES, default: 'present' },
        markedAt: { type: Date, default: Date.now },
        notes: String,
      },
    ],
    createdBy: String,
  },
  { timestamps: true },
);

sessionSchema.index({ batchId: 1, sessionDate: 1 });

export const BatchModel = defineTenantModel('StudentBatch', batchSchema);
export const SessionModel = defineTenantModel('BatchSession', sessionSchema);

