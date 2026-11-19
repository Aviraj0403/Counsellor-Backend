import { Schema } from 'mongoose';
import { defineTenantModel } from '../../../../shared/infra/tenantDb.js';
import { ACTIVITY_KINDS, ENTITY_TYPES, TASK_STATUSES } from '../domain/followup.domain.js';

const taskSchema = new Schema(
  {
    entityType: { type: String, enum: ENTITY_TYPES, required: true },
    entityId: { type: String, required: true },
    title: { type: String, required: true, trim: true, maxlength: 160 },
    notes: { type: String, trim: true, maxlength: 1000 },
    dueAt: { type: Date, required: true },
    assignedTo: { type: String, required: true },
    status: { type: String, enum: TASK_STATUSES, default: 'open' },
    completedAt: Date,
    outcome: { type: String, trim: true, maxlength: 500 },
    createdBy: String,
  },
  { timestamps: true },
);
taskSchema.index({ assignedTo: 1, status: 1, dueAt: 1 });
taskSchema.index({ entityType: 1, entityId: 1, status: 1 });

const activitySchema = new Schema(
  {
    entityType: { type: String, enum: ENTITY_TYPES, required: true },
    entityId: { type: String, required: true },
    kind: { type: String, enum: ACTIVITY_KINDS, required: true },
    direction: { type: String, enum: ['in', 'out'] },
    summary: { type: String, required: true, trim: true, maxlength: 1000 },
    outcome: { type: String, trim: true, maxlength: 500 },
    durationSec: Number,
    at: { type: Date, default: Date.now },
    by: String,
  },
  { timestamps: true },
);
activitySchema.index({ entityType: 1, entityId: 1, at: -1 });

export const TaskModel = defineTenantModel('FollowupTask', taskSchema);
export const ActivityModel = defineTenantModel('FollowupActivity', activitySchema);
