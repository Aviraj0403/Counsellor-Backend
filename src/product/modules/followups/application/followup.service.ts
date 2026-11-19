import type { Principal } from '../../../../contracts/port.js';
import { badRequest, forbidden, notFound } from '../../../../shared/kernel/errors.js';
import { audit } from '../../audit/index.js';
import { findLeadById } from '../../leads/index.js';
import { ActivityModel, TaskModel } from '../infrastructure/followup.model.js';
import { dueRange, startOfDay, type DueFilter, type EntityType } from '../domain/followup.domain.js';

const isCounsellor = (p: Principal) => p.role === 'counsellor';
/** A counsellor only sees and edits their own tasks. */
const visibility = (p: Principal) => (isCounsellor(p) ? { assignedTo: p.userId } : {});

/** A counsellor may only touch the timeline of a lead assigned to them. */
const assertEntityAccess = async (p: Principal, entityType: EntityType, entityId: string) => {
  if (!isCounsellor(p)) return;
  if (entityType === 'lead') {
    const lead = await findLeadById(p.tenantId!, entityId);
    if (!lead || lead.assignedTo !== p.userId) throw forbidden('You can only use follow-ups on leads assigned to you.');
  }
};

export interface TaskInput {
  entityType: EntityType;
  entityId: string;
  title: string;
  notes?: string;
  dueAt: Date;
  assignedTo?: string;
}

export const createTask = async (p: Principal, input: TaskInput) => {
  await assertEntityAccess(p, input.entityType, input.entityId);
  const assignedTo = isCounsellor(p) ? p.userId : (input.assignedTo ?? p.userId);
  const task = await TaskModel(p.tenantId!).create({ ...input, assignedTo, createdBy: p.userId });
  await audit(p.tenantId!, { action: 'followup.task_created', entity: 'followup_task', entityId: String(task._id), meta: { entityType: input.entityType, entityId: input.entityId, assignedTo } });
  return task.toObject();
};

export interface TaskQuery {
  page: number;
  limit: number;
  mine?: boolean;
  status?: 'open' | 'done' | 'cancelled';
  due?: DueFilter;
  entityType?: EntityType;
  entityId?: string;
  assignedTo?: string;
}

export const listTasks = async (p: Principal, q: TaskQuery, now = new Date()) => {
  const filter: Record<string, unknown> = { ...visibility(p) };
  if (q.mine && !isCounsellor(p)) filter.assignedTo = p.userId;
  if (q.assignedTo && !isCounsellor(p) && !q.mine) filter.assignedTo = q.assignedTo;
  if (q.status) filter.status = q.status;
  if (q.entityType) filter.entityType = q.entityType;
  if (q.entityId) filter.entityId = q.entityId;
  if (q.due) {
    filter.dueAt = dueRange(q.due, now);
    if (!q.status) filter.status = 'open';
  }
  const Task = TaskModel(p.tenantId!);
  const [items, total] = await Promise.all([
    Task.find(filter).sort({ dueAt: 1 }).skip((q.page - 1) * q.limit).limit(q.limit).lean(),
    Task.countDocuments(filter),
  ]);
  return { items, total, page: q.page, limit: q.limit };
};

const loadTask = async (p: Principal, id: string) => {
  const task = await TaskModel(p.tenantId!).findOne({ _id: id, ...visibility(p) });
  if (!task) throw notFound('Task');
  return task;
};

export const updateTask = async (p: Principal, id: string, patch: { title?: string; notes?: string; dueAt?: Date; assignedTo?: string; status?: 'open' | 'cancelled' }) => {
  const task = await loadTask(p, id);
  if (task.status === 'done') throw badRequest('A completed task cannot be changed.');
  if (patch.title !== undefined) task.title = patch.title;
  if (patch.notes !== undefined) task.notes = patch.notes;
  if (patch.dueAt !== undefined) task.dueAt = patch.dueAt;
  if (patch.assignedTo !== undefined && !isCounsellor(p)) task.assignedTo = patch.assignedTo;
  if (patch.status !== undefined) task.status = patch.status;
  await task.save();
  await audit(p.tenantId!, { action: 'followup.task_updated', entity: 'followup_task', entityId: id, meta: { fields: Object.keys(patch) } });
  return task.toObject();
};

export const completeTask = async (p: Principal, id: string, outcome?: string) => {
  const task = await loadTask(p, id);
  if (task.status !== 'open') throw badRequest(`This task is already ${task.status}.`);
  task.status = 'done';
  task.completedAt = new Date();
  if (outcome) task.outcome = outcome;
  await task.save();
  await audit(p.tenantId!, { action: 'followup.task_completed', entity: 'followup_task', entityId: id, meta: { outcome } });
  return task.toObject();
};

export const deleteTask = async (p: Principal, id: string) => {
  const task = await loadTask(p, id);
  await task.deleteOne();
  await audit(p.tenantId!, { action: 'followup.task_deleted', entity: 'followup_task', entityId: id });
  return { id, deleted: true };
};

export interface ActivityInput {
  entityType: EntityType;
  entityId: string;
  kind: 'call' | 'whatsapp' | 'email' | 'meeting' | 'note';
  direction?: 'in' | 'out';
  summary: string;
  outcome?: string;
  durationSec?: number;
  at?: Date;
}

export const logActivity = async (p: Principal, input: ActivityInput) => {
  await assertEntityAccess(p, input.entityType, input.entityId);
  const activity = await ActivityModel(p.tenantId!).create({ ...input, at: input.at ?? new Date(), by: p.userId });
  await audit(p.tenantId!, { action: 'followup.activity_logged', entity: 'followup_activity', entityId: String(activity._id), meta: { kind: input.kind, entityType: input.entityType, entityId: input.entityId } });
  return activity.toObject();
};

/** Written by the system itself (event reactions): no principal, no audit row per event. */
export const logSystemActivity = async (tenantId: string, entityType: EntityType, entityId: string, summary: string, by?: string) =>
  ActivityModel(tenantId).create({ entityType, entityId, kind: 'system', summary, at: new Date(), by });

export const listActivities = async (p: Principal, q: { entityType: EntityType; entityId: string; page: number; limit: number }) => {
  await assertEntityAccess(p, q.entityType, q.entityId);
  const filter = { entityType: q.entityType, entityId: q.entityId };
  const Activity = ActivityModel(p.tenantId!);
  const [items, total] = await Promise.all([
    Activity.find(filter).sort({ at: -1, _id: -1 }).skip((q.page - 1) * q.limit).limit(q.limit).lean(),
    Activity.countDocuments(filter),
  ]);
  return { items, total, page: q.page, limit: q.limit };
};

/** My open tasks, due today (still open, due before the end of today) and overdue. */
export const taskSummary = async (p: Principal, now = new Date()) => {
  const Task = TaskModel(p.tenantId!);
  const mine = { assignedTo: p.userId, status: 'open' };
  const day = startOfDay(now);
  const endOfToday = new Date(day.getTime() + 24 * 60 * 60 * 1000);
  const [open, dueToday, overdue] = await Promise.all([
    Task.countDocuments(mine),
    Task.countDocuments({ ...mine, dueAt: { $gte: day, $lt: endOfToday } }),
    Task.countDocuments({ ...mine, dueAt: { $lt: now } }),
  ]);
  return { open, dueToday, overdue };
};
