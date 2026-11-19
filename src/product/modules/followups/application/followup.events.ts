import { subscribe } from '../../../../shared/kernel/events.js';
import { CONTACT_TASK_TITLE, contactDueAt, describeLeadCreated, describeStageChange } from '../domain/followup.domain.js';
import { TaskModel } from '../infrastructure/followup.model.js';
import { logSystemActivity } from './followup.service.js';

/** Reacts to lead events. Registered once at start-up from src/app/events.ts. */
export const registerEvents = (): void => {
  subscribe('lead.created', async (e) => {
    await logSystemActivity(e.tenantId, 'lead', e.leadId, describeLeadCreated(e.channel), e.actorId);
  });

  subscribe('lead.stage_changed', async (e) => {
    await logSystemActivity(e.tenantId, 'lead', e.leadId, describeStageChange(e.from, e.to), e.actorId);
  });

  subscribe('lead.assigned', async (e) => {
    const Task = TaskModel(e.tenantId);
    const existing = await Task.exists({ entityType: 'lead', entityId: e.leadId, assignedTo: e.assigneeId, status: 'open', title: CONTACT_TASK_TITLE });
    if (existing) return;
    await Task.create({
      entityType: 'lead',
      entityId: e.leadId,
      title: CONTACT_TASK_TITLE,
      dueAt: contactDueAt(new Date()),
      assignedTo: e.assigneeId,
      createdBy: e.actorId,
    });
  });
};
