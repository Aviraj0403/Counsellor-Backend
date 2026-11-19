import { getPlatform } from '../../../../contracts/registry.js';
import { logger } from '../../../../shared/infra/logger.js';
import { publish } from '../../../../shared/kernel/events.js';
import { audit } from '../../audit/index.js';
import { reminderDue } from '../domain/appointment.domain.js';
import { AppointmentModel } from '../infrastructure/appointment.model.js';

/** One organisation: publishes `appointment.reminder_due` for every reminder whose time has come. Each reminder is claimed atomically, so it fires once. */
export const runDueRemindersForTenant = async (tenantId: string, now: Date): Promise<number> => {
  const A = AppointmentModel(tenantId);
  const candidates = await A.find({ active: true, start: { $gt: now }, reminderState: { $elemMatch: { sentAt: { $exists: false } } } }).limit(500).lean<any[]>();
  let sent = 0;
  for (const a of candidates) {
    for (const offsetMin of reminderDue({ status: a.status, start: a.start, reminderState: a.reminderState ?? [] }, now)) {
      const claim = await A.updateOne(
        { _id: a._id, active: true, reminderState: { $elemMatch: { offsetMin, sentAt: { $exists: false } } } },
        { $set: { 'reminderState.$.sentAt': now } },
      );
      if (claim.modifiedCount !== 1) continue; // another run already sent it
      sent++;
      await audit(tenantId, { action: 'appointment.reminder_due', entity: 'appointment', entityId: String(a._id), meta: { offsetMin } });
      await publish('appointment.reminder_due', { tenantId, appointmentId: String(a._id), typeId: a.typeId, start: a.start.toISOString(), offsetMin, leadId: a.who?.leadId });
    }
  }
  return sent;
};

/**
 * Idempotent, scheduler-free reminder run for every active organisation that has the module on.
 * Call it from cron/pm2 through POST /public/appointments/jobs/run-reminders (guarded by JOBS_SECRET). Running it twice sends nothing twice.
 */
export const runDueReminders = async (now = new Date()): Promise<{ tenants: number; reminders: number }> => {
  const platform = getPlatform();
  let tenants = 0;
  let reminders = 0;
  for (const t of await platform.listTenants()) {
    if (t.status !== 'active') continue;
    if (!(await platform.enabledModules(t.id))['appointments']) continue;
    tenants++;
    try {
      reminders += await runDueRemindersForTenant(t.id, now);
    } catch (err) {
      logger.error({ err, tenantId: t.id }, 'appointment reminders failed for one organisation');
    }
  }
  return { tenants, reminders };
};
