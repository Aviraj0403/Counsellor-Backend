// PUBLIC API of the `appointments` module.
import { registerConfigStatus } from '../../../shared/kernel/configStatus.js';
import { registerHooks as registerAppointmentGuards } from './application/appointment.events.js';
import { configStatus } from './application/config.status.js';

// The three functions below are the contract the `bots` module codes against. Keep their signatures stable.
export { listBookableTypes, getAvailableSlots, bookAppointment } from './application/appointment.api.js';
export { registerEvents } from './application/appointment.events.js';
export { configStatus } from './application/config.status.js';
export { runDueReminders } from './application/appointment.reminders.js';
export { appointmentRoutes } from './http/appointment.routes.js';
export { appointmentPublicRoutes } from './http/appointment.public.routes.js';

export const registerHooks = (): void => {
  registerAppointmentGuards();
  registerConfigStatus('appointments', configStatus);
};
