// PUBLIC API of the `appointments` module.
// The three functions below are the contract the `bots` module codes against. Keep their signatures stable.
export { listBookableTypes, getAvailableSlots, bookAppointment } from './application/appointment.api.js';
export { registerEvents, registerHooks } from './application/appointment.events.js';
export { runDueReminders } from './application/appointment.reminders.js';
export { appointmentRoutes } from './http/appointment.routes.js';
export { appointmentPublicRoutes } from './http/appointment.public.routes.js';
