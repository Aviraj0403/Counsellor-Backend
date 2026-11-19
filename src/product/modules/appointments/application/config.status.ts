import type { ModuleConfigStatus } from '../../../../shared/kernel/configStatus.js';
import { AppointmentTypeModel, WorkingHoursModel } from '../infrastructure/appointment.model.js';

/** Setup only. No appointment, attendee or contact details. */
export const configStatus = async (tenantId: string): Promise<ModuleConfigStatus> => {
  const [types, publicTypes, withHours] = await Promise.all([
    AppointmentTypeModel(tenantId).countDocuments({ active: true }),
    AppointmentTypeModel(tenantId).countDocuments({ active: true, publicBookable: true }),
    WorkingHoursModel(tenantId).countDocuments({ weekly: { $elemMatch: { 'ranges.0': { $exists: true } } } }),
  ]);
  const items = [
    { label: 'Appointment types', value: types },
    { label: 'Counsellors with working hours', value: withHours },
    { label: 'Public booking on', value: publicTypes > 0 },
  ];
  if (types === 0) return { configured: false, health: 'attention', summary: 'Appointments is on but no appointment type exists yet.', items, nextStep: 'Ask the organisation to add an appointment type (for example "Counselling call").' };
  if (withHours === 0) return { configured: false, health: 'attention', summary: 'Appointment types exist but no counsellor has working hours, so there are no slots to book.', items, nextStep: 'Ask the organisation to set working hours for their counsellors.' };
  return { configured: true, health: 'ok', summary: `${types} type(s), ${withHours} counsellor(s) with hours, public booking ${publicTypes > 0 ? 'on' : 'off'}.`, items };
};
