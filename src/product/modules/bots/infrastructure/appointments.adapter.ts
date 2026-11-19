import { bookAppointment, getAvailableSlots, listBookableTypes } from '../../appointments/index.js';
import type { AppointmentsPort } from './ports.js';

/** Production adapter over the appointments module's public API (the contract in BUILD_PLAN_APPOINTMENTS_BOT.md). */
export const appointmentsAdapter: AppointmentsPort = { listBookableTypes, getAvailableSlots, bookAppointment };
