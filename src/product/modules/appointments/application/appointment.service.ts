import { getPlatform } from '../../../../contracts/registry.js';
import type { Principal } from '../../../../contracts/port.js';
import { badRequest, forbidden, notFound } from '../../../../shared/kernel/errors.js';
import { normalizePhone } from '../../../../shared/kernel/phone.js';
import { audit } from '../../audit/index.js';
import { findLeadById } from '../../leads/index.js';
import { istDayStart, hasStarted, nextStatuses, weeklyProblem, type WeeklyDay } from '../domain/appointment.domain.js';
import { AppointmentModel, AppointmentTypeModel, TimeOffModel, WaitlistModel, WorkingHoursModel } from '../infrastructure/appointment.model.js';
import { bookCore, isCounsellor, loadType, publicShape, rescheduleCore, slotsFor, transitionCore, validateRange, type BookInput } from './appointment.core.js';

const DAY = 24 * 60 * 60_000;
/** A counsellor only sees appointments in their own calendar. */
const visibility = (p: Principal) => (isCounsellor(p) ? { counsellorId: p.userId } : {});

// ---------------------------------------------------------------- appointment types
export interface TypeInput {
  name: string;
  description?: string;
  mode: 'phone' | 'video' | 'in_person';
  durationMin: number;
  bufferBeforeMin?: number;
  bufferAfterMin?: number;
  minNoticeHours?: number;
  maxAdvanceDays?: number;
  slotStepMin?: number;
  assignment?: 'specific' | 'round_robin';
  counsellorIds?: string[];
  intakeQuestions?: { key: string; label: string; required?: boolean }[];
  cancellationNoticeHours?: number;
  policyText?: string;
  reminders?: { offsetMin: number; channel?: 'whatsapp' }[];
  publicBookable?: boolean;
  active?: boolean;
  locationOrLink?: string;
}

const checkCounsellors = async (tenantId: string, ids: string[] | undefined) => {
  if (!ids || ids.length === 0) return;
  const team = new Set((await getPlatform().listTeam(tenantId)).map((m) => m.id));
  const unknown = ids.filter((i) => !team.has(i));
  if (unknown.length) throw badRequest('One of the selected counsellors is not an active member of your team.');
};

export const createType = async (p: Principal, input: TypeInput) => {
  await checkCounsellors(p.tenantId!, input.counsellorIds);
  const t = await AppointmentTypeModel(p.tenantId!).create({ ...input, counsellorIds: [...new Set(input.counsellorIds ?? [])] });
  await audit(p.tenantId!, { action: 'appointment_type.created', entity: 'appointment_type', entityId: String(t._id), meta: { name: input.name } });
  return t.toObject();
};

export const updateType = async (p: Principal, id: string, patch: Partial<TypeInput>) => {
  const Type = AppointmentTypeModel(p.tenantId!);
  const t = await Type.findById(id);
  if (!t) throw notFound('Appointment type');
  await checkCounsellors(p.tenantId!, patch.counsellorIds);
  t.set({ ...patch, ...(patch.counsellorIds ? { counsellorIds: [...new Set(patch.counsellorIds)] } : {}) });
  await t.save();
  await audit(p.tenantId!, { action: 'appointment_type.updated', entity: 'appointment_type', entityId: id, meta: { fields: Object.keys(patch) } });
  return t.toObject();
};

/** Types are never deleted (old appointments point at them): they are switched off. */
export const deactivateType = async (p: Principal, id: string) => updateType(p, id, { active: false });

export const listTypes = async (p: Principal, q: { includeInactive?: boolean }) => {
  const filter: Record<string, unknown> = q.includeInactive ? {} : { active: true };
  if (isCounsellor(p)) filter.counsellorIds = p.userId;
  return { items: await AppointmentTypeModel(p.tenantId!).find(filter).sort({ name: 1 }).lean() };
};

export const getType = async (p: Principal, id: string) => loadType(p.tenantId!, id);

// ---------------------------------------------------------------- working hours and time off
const assertOwnCalendar = (p: Principal, counsellorId: string) => {
  if (isCounsellor(p) && counsellorId !== p.userId) throw forbidden('You can only see your own calendar.');
};

export const getHours = async (p: Principal, counsellorId: string) => {
  assertOwnCalendar(p, counsellorId);
  const doc = await WorkingHoursModel(p.tenantId!).findOne({ counsellorId }).lean<any>();
  return { counsellorId, timezone: 'Asia/Kolkata', weekly: doc?.weekly ?? [] };
};

export const setHours = async (p: Principal, counsellorId: string, weekly: WeeklyDay[]) => {
  const problem = weeklyProblem(weekly);
  if (problem) throw badRequest(problem);
  await checkCounsellors(p.tenantId!, [counsellorId]);
  await WorkingHoursModel(p.tenantId!).updateOne({ counsellorId }, { $set: { weekly, timezone: 'Asia/Kolkata' }, $setOnInsert: { counsellorId } }, { upsert: true });
  await audit(p.tenantId!, { action: 'appointment.hours_updated', entity: 'working_hours', entityId: counsellorId, meta: { days: weekly.length } });
  return getHours(p, counsellorId);
};

export const listTimeOff = async (p: Principal, q: { counsellorId?: string }) => {
  const counsellorId = isCounsellor(p) ? p.userId : q.counsellorId;
  const filter = counsellorId ? { counsellorId } : {};
  return { items: await TimeOffModel(p.tenantId!).find(filter).sort({ from: -1 }).limit(200).lean() };
};

export const addTimeOff = async (p: Principal, input: { counsellorId: string; from: Date; to: Date; reason?: string }) => {
  if (input.to.getTime() <= input.from.getTime()) throw badRequest('Time off must end after it starts.');
  await checkCounsellors(p.tenantId!, [input.counsellorId]);
  const doc = await TimeOffModel(p.tenantId!).create(input);
  await audit(p.tenantId!, { action: 'appointment.time_off_added', entity: 'time_off', entityId: String(doc._id), meta: { counsellorId: input.counsellorId } });
  return doc.toObject();
};

export const removeTimeOff = async (p: Principal, id: string) => {
  const doc = await TimeOffModel(p.tenantId!).findByIdAndDelete(id);
  if (!doc) throw notFound('Time off');
  await audit(p.tenantId!, { action: 'appointment.time_off_removed', entity: 'time_off', entityId: id });
  return { id, deleted: true };
};

// ---------------------------------------------------------------- slots and appointments
export const staffSlots = async (p: Principal, q: { typeId: string; from: Date; to: Date; counsellorId?: string }) => {
  validateRange(q.from, q.to);
  const type = await loadType(p.tenantId!, q.typeId);
  const counsellorId = isCounsellor(p) ? p.userId : q.counsellorId;
  return { items: await slotsFor(p.tenantId!, type, { from: q.from, to: q.to, counsellorId }) };
};

export interface StaffBookInput {
  typeId: string;
  start: Date;
  leadId?: string;
  studentId?: string;
  name?: string;
  phone?: string;
  email?: string;
  answers?: Record<string, string>;
  counsellorId?: string;
  notes?: string;
  consentGiven?: boolean;
}

export const staffBook = async (p: Principal, input: StaffBookInput) => {
  const tenantId = p.tenantId!;
  let { name, phone, email } = input;
  if (input.leadId) {
    const lead = await findLeadById(tenantId, input.leadId);
    if (!lead) throw notFound('Lead');
    name = name ?? lead.name;
    phone = phone ?? lead.phone;
    email = email ?? lead.email;
  }
  if (!name || !phone) throw badRequest('Choose a lead, or enter the name and phone number of the student.');
  const book: BookInput = { typeId: input.typeId, start: input.start, name, phone, email, answers: input.answers, leadId: input.leadId, studentId: input.studentId, source: 'staff', consentGiven: input.consentGiven ?? false, notes: input.notes };
  const { doc } = await bookCore(tenantId, book, { actor: p, counsellorId: input.counsellorId });
  return publicShape(doc);
};

export interface ListQuery {
  page: number;
  limit: number;
  from?: Date;
  to?: Date;
  status?: string;
  typeId?: string;
  counsellorId?: string;
  mine?: boolean;
}

export const listAppointments = async (p: Principal, q: ListQuery) => {
  const filter: Record<string, unknown> = { ...visibility(p) };
  if (!isCounsellor(p)) {
    if (q.mine) filter.counsellorId = p.userId;
    else if (q.counsellorId) filter.counsellorId = q.counsellorId;
  }
  if (q.status) filter.status = q.status;
  if (q.typeId) filter.typeId = q.typeId;
  if (q.from || q.to) filter.start = { ...(q.from ? { $gte: q.from } : {}), ...(q.to ? { $lt: q.to } : {}) };
  const A = AppointmentModel(p.tenantId!);
  const [items, total, types] = await Promise.all([
    A.find(filter).select('-manageTokenHash').sort({ start: 1 }).skip((q.page - 1) * q.limit).limit(q.limit).lean<any[]>(),
    A.countDocuments(filter),
    AppointmentTypeModel(p.tenantId!).find().select('name mode').lean<any[]>(),
  ]);
  const names = new Map(types.map((t) => [String(t._id), t.name as string]));
  return { items: items.map((i) => ({ ...i, typeName: names.get(i.typeId) ?? '' })), total, page: q.page, limit: q.limit };
};

const loadVisible = async (p: Principal, id: string) => {
  const a = await AppointmentModel(p.tenantId!).findOne({ _id: id, ...visibility(p) });
  if (!a) throw notFound('Appointment');
  return a;
};

export const getAppointment = async (p: Principal, id: string) => {
  const a = await loadVisible(p, id);
  const type = await AppointmentTypeModel(p.tenantId!).findById(a.typeId).select('name mode durationMin').lean<any>();
  return { ...publicShape(a), type, allowedNext: nextStatuses(a.status) };
};

export const rescheduleAppointment = async (p: Principal, id: string, input: { start: Date; counsellorId?: string }) => {
  const a = await loadVisible(p, id);
  const { doc } = await rescheduleCore(p.tenantId!, a, input.start, { actor: p, counsellorId: input.counsellorId });
  return publicShape(doc);
};

export const cancelAppointment = async (p: Principal, id: string, reason: string) => {
  const a = await loadVisible(p, id);
  await transitionCore(p.tenantId!, a, 'cancelled', { cancelReason: reason, cancelledBy: `staff:${p.userId}`, actorId: p.userId });
  return publicShape(a);
};

export const confirmAppointment = async (p: Principal, id: string) => {
  const a = await loadVisible(p, id);
  await transitionCore(p.tenantId!, a, 'confirmed', { actorId: p.userId });
  return publicShape(a);
};

export const completeAppointment = async (p: Principal, id: string, notes?: string) => {
  const a = await loadVisible(p, id);
  if (!hasStarted(a.start, new Date())) throw badRequest('This appointment has not started yet, so it cannot be marked completed.');
  await transitionCore(p.tenantId!, a, 'completed', { notes, actorId: p.userId });
  return publicShape(a);
};

export const markNoShow = async (p: Principal, id: string) => {
  const a = await loadVisible(p, id);
  if (!hasStarted(a.start, new Date())) throw badRequest('This appointment has not started yet, so it cannot be marked as a no-show.');
  await transitionCore(p.tenantId!, a, 'no_show', { actorId: p.userId });
  return publicShape(a);
};

// ---------------------------------------------------------------- waitlist
export const addWaitlist = async (p: Principal, input: { typeId: string; name: string; phone: string; preferredFrom?: Date; preferredTo?: Date }) => {
  await loadType(p.tenantId!, input.typeId);
  const phone = normalizePhone(input.phone);
  if (!phone) throw badRequest('Enter a valid 10-digit Indian mobile number.');
  if (input.preferredFrom && input.preferredTo && input.preferredTo <= input.preferredFrom) throw badRequest('The preferred end must be after its start.');
  const dup = await WaitlistModel(p.tenantId!).findOne({ typeId: input.typeId, phone, status: { $in: ['waiting', 'offered'] } }).lean<any>();
  if (dup) return { ...dup, duplicate: true };
  const w = await WaitlistModel(p.tenantId!).create({ ...input, phone, createdBy: p.userId });
  await audit(p.tenantId!, { action: 'appointment.waitlist_added', entity: 'waitlist', entityId: String(w._id), meta: { typeId: input.typeId } });
  return w.toObject();
};

export const listWaitlist = async (p: Principal, q: { status?: string; typeId?: string; page: number; limit: number }) => {
  const filter: Record<string, unknown> = {};
  if (q.status) filter.status = q.status;
  if (q.typeId) filter.typeId = q.typeId;
  const W = WaitlistModel(p.tenantId!);
  const [items, total] = await Promise.all([W.find(filter).sort({ createdAt: 1 }).skip((q.page - 1) * q.limit).limit(q.limit).lean(), W.countDocuments(filter)]);
  return { items, total, page: q.page, limit: q.limit };
};

export const expireWaitlist = async (p: Principal, id: string) => {
  const w = await WaitlistModel(p.tenantId!).findOneAndUpdate({ _id: id, status: { $in: ['waiting', 'offered'] } }, { $set: { status: 'expired' } }, { new: true }).lean<any>();
  if (!w) throw notFound('Waiting-list entry');
  await audit(p.tenantId!, { action: 'appointment.waitlist_expired', entity: 'waitlist', entityId: id });
  return w;
};

// ---------------------------------------------------------------- summary
export const summary = async (p: Principal, now = new Date()) => {
  const A = AppointmentModel(p.tenantId!);
  const scope = visibility(p);
  const day = istDayStart(now);
  const [today, upcoming, finished] = await Promise.all([
    A.aggregate([{ $match: { ...scope, start: { $gte: day, $lt: new Date(day.getTime() + DAY) } } }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
    A.countDocuments({ ...scope, active: true, start: { $gte: now, $lt: new Date(now.getTime() + 7 * DAY) } }),
    A.aggregate([{ $match: { ...scope, status: { $in: ['completed', 'no_show'] }, start: { $gte: new Date(now.getTime() - 30 * DAY), $lt: now } } }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
  ]);
  const todayBy = Object.fromEntries(today.map((r: any) => [r._id, r.n as number]));
  const done = finished.find((r: any) => r._id === 'completed')?.n ?? 0;
  const missed = finished.find((r: any) => r._id === 'no_show')?.n ?? 0;
  return {
    today: { total: Object.values(todayBy).reduce((a: number, b) => a + (b as number), 0), byStatus: todayBy },
    upcoming7Days: upcoming,
    last30Days: { completed: done, noShow: missed, noShowRate: done + missed > 0 ? Math.round((missed / (done + missed)) * 1000) / 1000 : null },
  };
};
