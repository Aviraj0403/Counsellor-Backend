import { subscribe } from '../../../../shared/kernel/events.js';
import { registerContributor } from '../../../../shared/kernel/hooks.js';
import { randomToken } from '../../../../shared/infra/crypto.js';
import { audit } from '../../audit/index.js';
import { AppointmentModel, AppointmentTypeModel, WaitlistModel } from '../infrastructure/appointment.model.js';
import { hashToken } from './appointment.core.js';

/**
 * A slot was freed: offer it to the first matching person on the waiting list (oldest first, preferred window respected).
 * "Offered" is a status staff act on (they see it in the waiting list); nothing is sent automatically.
 */
export const offerFreedSlot = async (tenantId: string, typeId: string, start: Date, counsellorId: string, now = new Date()) => {
  if (start.getTime() <= now.getTime()) return null;
  const Waitlist = WaitlistModel(tenantId);
  const waiting = await Waitlist.find({ typeId, status: 'waiting' }).sort({ createdAt: 1 }).lean<any[]>();
  for (const w of waiting) {
    if (w.preferredFrom && start < new Date(w.preferredFrom)) continue;
    if (w.preferredTo && start > new Date(w.preferredTo)) continue;
    const claimed = await Waitlist.findOneAndUpdate(
      { _id: w._id, status: 'waiting' },
      { $set: { status: 'offered', offeredStart: start, offeredCounsellorId: counsellorId, offeredAt: now } },
      { new: true },
    ).lean<any>();
    if (!claimed) continue; // someone else got there first
    await audit(tenantId, { action: 'appointment.waitlist_offered', entity: 'waitlist', entityId: String(w._id), meta: { typeId, start: start.toISOString(), counsellorId } });
    return claimed;
  }
  return null;
};

/** Reacts to appointment and student events. Registered once at start-up from src/app/events.ts. */
export const registerEvents = (): void => {
  subscribe('appointment.cancelled', async (e) => {
    await offerFreedSlot(e.tenantId, e.typeId, new Date(e.start), e.counsellorId);
  });
  subscribe('appointment.rescheduled', async (e) => {
    await offerFreedSlot(e.tenantId, e.typeId, new Date(e.previousStart), e.previousCounsellorId);
  });
  // DPDP: when a student is erased, their appointments keep only counts (who, when, which type), no personal details.
  subscribe('student.erased', async (e) => {
    await AppointmentModel(e.tenantId).updateMany(
      { 'who.studentId': e.studentId },
      { $set: { 'who.name': 'Erased student', 'who.phone': 'erased', answers: {}, notes: '', manageTokenHash: hashToken(randomToken(24)) }, $unset: { 'who.email': '', 'who.leadId': '' } },
    );
  });
};

/** Contributes a section to the student data export. */
export const registerHooks = (): void => {
  registerContributor('student.export', async ({ tenantId, studentId }) => {
    const rows = await AppointmentModel(tenantId).find({ 'who.studentId': studentId }).sort({ start: -1 }).select('-manageTokenHash').lean<any[]>();
    const types = new Map((await AppointmentTypeModel(tenantId).find().select('name').lean<any[]>()).map((t) => [String(t._id), t.name as string]));
    return {
      section: 'appointments',
      data: rows.map((a) => ({ id: String(a._id), type: types.get(a.typeId) ?? a.typeId, start: a.start, end: a.end, status: a.status, source: a.source, answers: a.answers, notes: a.notes, cancelReason: a.cancelReason })),
    };
  });
};
