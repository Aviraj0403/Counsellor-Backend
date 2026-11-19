import { badRequest } from '../../../../shared/kernel/errors.js';
import { AppointmentModel, AppointmentTypeModel } from '../infrastructure/appointment.model.js';
import { bookCore, loadType, slotsFor, validateRange } from './appointment.core.js';

/** Types a student or a bot may book online. */
export const listBookableTypes = async (tenantId: string): Promise<{ id: string; name: string; mode: string; durationMin: number }[]> => {
  const rows = await AppointmentTypeModel(tenantId).find({ active: true, publicBookable: true }).sort({ name: 1 }).select('name mode durationMin').lean<any[]>();
  return rows.map((t) => ({ id: String(t._id), name: t.name as string, mode: t.mode as string, durationMin: t.durationMin as number }));
};

/** Free slots (UTC) of a bookable type. For round-robin types each start appears once, with the counsellor who would get it. */
export const getAvailableSlots = async (
  tenantId: string,
  input: { typeId: string; from: Date; to: Date; counsellorId?: string },
): Promise<{ start: Date; end: Date; counsellorId: string }[]> => {
  validateRange(input.from, input.to);
  const type = await loadType(tenantId, input.typeId);
  if (!type.active || !type.publicBookable) throw badRequest('This appointment type cannot be booked online.');
  return slotsFor(tenantId, type, { from: input.from, to: input.to, counsellorId: input.counsellorId });
};

/** Books a slot. Fails with 409 when the slot was just taken. `manageToken` is shown once: only its hash is stored. */
export const bookAppointment = async (
  tenantId: string,
  input: { typeId: string; start: Date; name: string; phone: string; email?: string; answers?: Record<string, string>; leadId?: string; source: 'staff' | 'public' | 'bot' | 'portal'; consentGiven: boolean },
): Promise<{ id: string; start: Date; end: Date; counsellorId: string; manageToken: string }> => {
  const { doc, token } = await bookCore(tenantId, input);
  return { id: String(doc._id), start: doc.start as Date, end: doc.end as Date, counsellorId: doc.counsellorId as string, manageToken: token };
};

/** COUNT ONLY, for the platform central summary: active (booked or confirmed) appointments that have not started yet. */
export const countUpcomingAppointments = async (tenantId: string): Promise<number> =>
  AppointmentModel(tenantId).countDocuments({ active: true, start: { $gte: new Date() } });
