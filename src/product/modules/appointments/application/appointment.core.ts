import { getPlatform } from '../../../../contracts/registry.js';
import type { Principal } from '../../../../contracts/port.js';
import { badRequest, conflict, forbidden, notFound } from '../../../../shared/kernel/errors.js';
import { publish } from '../../../../shared/kernel/events.js';
import { normalizePhone } from '../../../../shared/kernel/phone.js';
import { randomToken, sha256Hex } from '../../../../shared/infra/crypto.js';
import { audit } from '../../audit/index.js';
import { createLead, findLeadById } from '../../leads/index.js';
import { systemPrincipal } from '../../../../contracts/system.js';
import {
  ACTIVE_STATUSES, computeSlots, guardianProblem, initialReminderState, missingAnswers, pickRoundRobin, validateTransition,
  type AppointmentSource, type AppointmentStatus,
} from '../domain/appointment.domain.js';
import { AppointmentModel, AppointmentTypeModel, TimeOffModel, WaitlistModel, WorkingHoursModel } from '../infrastructure/appointment.model.js';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

export const isCounsellor = (p?: Principal | null) => p?.role === 'counsellor';
export const hashToken = (t: string) => sha256Hex(t);
const clean = <T extends { manageTokenHash?: unknown }>(doc: T): Omit<T, 'manageTokenHash'> => {
  const { manageTokenHash: _h, ...rest } = doc;
  return rest;
};
export const publicShape = (doc: any) => clean(doc.toObject ? doc.toObject() : doc);

export const loadType = async (tenantId: string, id: string) => {
  const t = await AppointmentTypeModel(tenantId).findById(id).lean<any>();
  if (!t) throw notFound('Appointment type');
  return t;
};

/** Counsellors of a type that actually exist and are active staff right now. */
const poolOf = async (tenantId: string, type: any, only?: string): Promise<string[]> => {
  let ids: string[] = type.counsellorIds ?? [];
  if (only) ids = ids.filter((i) => i === only);
  if (ids.length === 0) return [];
  const team = new Set((await getPlatform().listTeam(tenantId)).map((m) => m.id));
  return ids.filter((i) => team.has(i));
};

const bookedNext7Days = async (tenantId: string, ids: string[], now: Date): Promise<Map<string, number>> => {
  const rows = await AppointmentModel(tenantId).aggregate([
    { $match: { counsellorId: { $in: ids }, active: true, start: { $gte: now, $lt: new Date(now.getTime() + 7 * DAY) } } },
    { $group: { _id: '$counsellorId', n: { $sum: 1 } } },
  ]);
  return new Map(rows.map((r: any) => [String(r._id), r.n as number]));
};

export interface FreeSlot { start: Date; end: Date; counsellorId: string }

/**
 * Free slots of a type in [from, to). 'round_robin': one slot per start time, given to the least-booked free counsellor.
 * 'specific': every counsellor of the type is listed with their own slots (pass counsellorId to ask for one person).
 */
export const slotsFor = async (tenantId: string, type: any, a: { from: Date; to: Date; counsellorId?: string; now?: Date; excludeId?: string }): Promise<FreeSlot[]> => {
  const now = a.now ?? new Date();
  const pool = await poolOf(tenantId, type, a.counsellorId);
  if (pool.length === 0) return [];
  const reach = DAY; // buffers are at most 4 h, so one day on each side catches every neighbour
  const lo = new Date(a.from.getTime() - reach);
  const hi = new Date(a.to.getTime() + reach);
  const [hoursDocs, offDocs, busyDocs] = await Promise.all([
    WorkingHoursModel(tenantId).find({ counsellorId: { $in: pool } }).lean<any[]>(),
    TimeOffModel(tenantId).find({ counsellorId: { $in: pool }, from: { $lt: hi }, to: { $gt: lo } }).lean<any[]>(),
    AppointmentModel(tenantId)
      .find({ counsellorId: { $in: pool }, active: true, start: { $lt: hi }, end: { $gt: lo }, ...(a.excludeId ? { _id: { $ne: a.excludeId } } : {}) })
      .select('counsellorId start end bufferBeforeMin bufferAfterMin')
      .lean<any[]>(),
  ]);
  const all: FreeSlot[] = [];
  for (const id of pool) {
    const hours = hoursDocs.find((h) => h.counsellorId === id)?.weekly ?? [];
    const slots = computeSlots({
      type,
      hours,
      timeOff: offDocs.filter((o) => o.counsellorId === id),
      existing: busyDocs.filter((b) => b.counsellorId === id),
      now,
      from: a.from,
      to: a.to,
    });
    for (const s of slots) all.push({ ...s, counsellorId: id });
  }
  if (type.assignment !== 'round_robin') return all.sort((x, y) => x.start.getTime() - y.start.getTime() || (x.counsellorId < y.counsellorId ? -1 : 1));
  const load = await bookedNext7Days(tenantId, pool, now);
  const byStart = new Map<number, FreeSlot[]>();
  for (const s of all) byStart.set(s.start.getTime(), [...(byStart.get(s.start.getTime()) ?? []), s]);
  const out: FreeSlot[] = [];
  for (const [, group] of [...byStart.entries()].sort((x, y) => x[0] - y[0])) {
    const pick = pickRoundRobin(group.map((g) => ({ counsellorId: g.counsellorId, booked: load.get(g.counsellorId) ?? 0 })));
    out.push(group.find((g) => g.counsellorId === pick)!);
  }
  return out;
};

export const validateRange = (from: Date, to: Date) => {
  if (!(to.getTime() > from.getTime())) throw badRequest('The end of the date range must be after its start.');
  if (to.getTime() - from.getTime() > 35 * DAY) throw badRequest('Ask for at most 35 days of slots at a time.');
};

export interface CreateOptions {
  now?: Date;
  counsellorId?: string;
  excludeId?: string;
  rescheduledFrom?: string;
  actorId?: string;
}

interface NewAppointment {
  type: any;
  start: Date;
  who: { leadId?: string; studentId?: string; name: string; phone: string; email?: string };
  answers: Record<string, string>;
  source: AppointmentSource;
  consent?: { given: boolean; at?: Date };
  notes?: string;
}

/** Picks the counsellor, re-checks the slot against live data, inserts, and settles a race deterministically. */
export const createAppointment = async (tenantId: string, n: NewAppointment, o: CreateOptions = {}) => {
  const now = o.now ?? new Date();
  const { type, start } = n;
  const free = await slotsFor(tenantId, type, { from: start, to: new Date(start.getTime() + 1), counsellorId: o.counsellorId, now, excludeId: o.excludeId });
  const candidates = free.filter((s) => s.start.getTime() === start.getTime());
  if (candidates.length === 0) throw conflict('That time is not available any more. Please pick another slot.');
  const load = await bookedNext7Days(tenantId, candidates.map((c) => c.counsellorId), now);
  const counsellorId = pickRoundRobin(candidates.map((c) => ({ counsellorId: c.counsellorId, booked: load.get(c.counsellorId) ?? 0 })))!;
  const end = new Date(start.getTime() + type.durationMin * MIN);
  const token = randomToken(24);
  const Appointment = AppointmentModel(tenantId);
  await Appointment.init(); // wait for the unique index: it is what makes a double booking impossible

  let doc: any;
  try {
    doc = await Appointment.create({
      typeId: String(type._id),
      counsellorId,
      start,
      end,
      bufferBeforeMin: type.bufferBeforeMin,
      bufferAfterMin: type.bufferAfterMin,
      status: 'booked',
      active: true,
      who: n.who,
      answers: n.answers,
      source: n.source,
      consent: n.consent,
      notes: n.notes,
      rescheduledFrom: o.rescheduledFrom,
      reminderState: initialReminderState((type.reminders ?? []).map((r: any) => r.offsetMin), start, now),
      manageTokenHash: hashToken(token),
      createdBy: o.actorId,
    });
  } catch (err: any) {
    if (err?.code === 11000) throw conflict('That time was just taken by someone else. Please pick another slot.');
    throw err;
  }

  // Overlapping starts (for example 10:00 and 10:15 of a 60 minute type) are not covered by the unique index. If two requests raced,
  // the one created later (higher id) steps aside, so exactly one survives.
  const clash = await Appointment.findOne({
    counsellorId,
    active: true,
    _id: { $ne: doc._id, ...(o.excludeId ? { $nin: [o.excludeId] } : {}) },
    start: { $lt: new Date(end.getTime() + type.bufferAfterMin * MIN) },
    end: { $gt: new Date(start.getTime() - type.bufferBeforeMin * MIN) },
  }).select('_id').lean<any>();
  if (clash && String(clash._id) < String(doc._id)) {
    await Appointment.deleteOne({ _id: doc._id });
    throw conflict('That time was just taken by someone else. Please pick another slot.');
  }
  return { doc, token };
};

export interface BookInput {
  typeId: string;
  start: Date;
  name: string;
  phone: string;
  email?: string;
  answers?: Record<string, string>;
  leadId?: string;
  studentId?: string;
  source: AppointmentSource;
  consentGiven: boolean;
  notes?: string;
}

/** The one booking path for staff, the public page, the bot and the portal. */
export const bookCore = async (tenantId: string, input: BookInput, o: CreateOptions & { actor?: Principal } = {}) => {
  const type = await loadType(tenantId, input.typeId);
  if (!type.active) throw badRequest('This appointment type is not open for booking.');
  if (input.source !== 'staff' && !type.publicBookable) throw badRequest('This appointment type cannot be booked online.');
  if (input.source !== 'staff' && input.consentGiven !== true) throw badRequest('We need your consent to contact you about this appointment.');
  const phone = normalizePhone(input.phone);
  if (!phone) throw badRequest('Enter a valid 10-digit Indian mobile number.');
  const answers = Object.fromEntries(Object.entries(input.answers ?? {}).map(([k, v]) => [k.slice(0, 40), String(v).slice(0, 500)]));
  const missing = missingAnswers(type.intakeQuestions ?? [], answers);
  if (missing.length) throw badRequest(`Please answer: ${missing.join(', ')}.`);
  const minor = guardianProblem(answers);
  if (minor) throw badRequest(minor);

  let counsellorId = o.counsellorId;
  const actor = o.actor;
  if (isCounsellor(actor)) {
    if (counsellorId && counsellorId !== actor!.userId) throw forbidden('You can only book into your own calendar.');
    counsellorId = actor!.userId;
  }
  if (counsellorId && !(type.counsellorIds ?? []).includes(counsellorId)) throw badRequest('That counsellor does not take this type of appointment.');

  let leadId = input.leadId;
  if (leadId) {
    const lead = await findLeadById(tenantId, leadId);
    if (!lead) throw notFound('Lead');
    if (isCounsellor(actor) && lead.assignedTo !== actor!.userId) throw forbidden('You can only book appointments for leads assigned to you.');
  }

  // Check the slot BEFORE creating a lead, so a taken slot never leaves a stray lead behind.
  const start = input.start;
  const free = await slotsFor(tenantId, type, { from: start, to: new Date(start.getTime() + 1), counsellorId, now: o.now });
  if (!free.some((s) => s.start.getTime() === start.getTime())) throw conflict('That time is not available. Please pick another slot.');

  if (!leadId && input.source !== 'staff') {
    const made = await createLead(systemPrincipal(tenantId, 'appointments'), {
      name: input.name,
      phone,
      email: input.email,
      source: { channel: 'appointment' },
      consent: { given: true, source: 'appointment' },
      autoAssign: true,
    });
    leadId = String(made.lead._id);
  }

  const { doc, token } = await createAppointment(
    tenantId,
    {
      type,
      start,
      who: { leadId, studentId: input.studentId, name: input.name.trim(), phone, email: input.email },
      answers,
      source: input.source,
      consent: input.consentGiven ? { given: true, at: new Date() } : undefined,
      notes: input.notes,
    },
    { ...o, counsellorId, actorId: actor?.userId },
  );

  // A waiting-list entry for this person and type is fulfilled by booking.
  await WaitlistModel(tenantId).updateMany({ typeId: String(type._id), phone, status: { $in: ['waiting', 'offered'] } }, { $set: { status: 'booked' } });
  await audit(tenantId, { action: 'appointment.booked', entity: 'appointment', entityId: String(doc._id), meta: { source: input.source, typeId: String(type._id), counsellorId: doc.counsellorId, start: doc.start.toISOString(), leadId } });
  await publish('appointment.booked', { tenantId, appointmentId: String(doc._id), typeId: String(type._id), counsellorId: doc.counsellorId, start: doc.start.toISOString(), source: input.source, leadId, actorId: actor?.userId });
  return { doc, token };
};

/** Status change shared by staff actions and the booker's own cancel link. */
export const transitionCore = async (
  tenantId: string,
  appt: any,
  to: AppointmentStatus,
  extra: { cancelReason?: string; cancelledBy?: string; notes?: string; actorId?: string },
) => {
  if (!validateTransition(appt.status, to)) throw badRequest(`An appointment that is "${appt.status}" cannot become "${to}".`);
  appt.status = to;
  appt.active = (ACTIVE_STATUSES as readonly string[]).includes(to);
  if (extra.cancelReason) appt.cancelReason = extra.cancelReason;
  if (extra.cancelledBy) appt.cancelledBy = extra.cancelledBy;
  if (extra.notes !== undefined) appt.notes = extra.notes;
  await appt.save();
  const base = { tenantId, appointmentId: String(appt._id), typeId: appt.typeId, counsellorId: appt.counsellorId, leadId: appt.who?.leadId as string | undefined };
  await audit(tenantId, { action: `appointment.${to}`, entity: 'appointment', entityId: String(appt._id), meta: { by: extra.cancelledBy ?? extra.actorId, reason: extra.cancelReason } });
  if (to === 'cancelled') await publish('appointment.cancelled', { ...base, start: appt.start.toISOString(), cancelledBy: extra.cancelledBy ?? 'staff', actorId: extra.actorId });
  else if (to === 'completed') await publish('appointment.completed', { ...base, actorId: extra.actorId });
  else if (to === 'no_show') await publish('appointment.no_show', { ...base, actorId: extra.actorId });
  return appt;
};

/** Moves an appointment to a new time: books the new one first, then retires the old one. */
export const rescheduleCore = async (tenantId: string, appt: any, newStart: Date, o: CreateOptions & { actor?: Principal; byBooker?: boolean } = {}) => {
  if (!validateTransition(appt.status, 'rescheduled')) throw badRequest(`An appointment that is "${appt.status}" cannot be moved.`);
  if (newStart.getTime() === appt.start.getTime() && (!o.counsellorId || o.counsellorId === appt.counsellorId)) throw badRequest('That is the same time as the current appointment.');
  const type = await loadType(tenantId, appt.typeId);
  const counsellorId = isCounsellor(o.actor) ? o.actor!.userId : (o.counsellorId ?? appt.counsellorId);
  const { doc, token } = await createAppointment(
    tenantId,
    { type, start: newStart, who: { ...appt.who.toObject?.() ?? appt.who }, answers: appt.answers ?? {}, source: appt.source, consent: appt.consent?.given ? { given: true, at: appt.consent.at } : undefined, notes: appt.notes },
    { ...o, counsellorId, excludeId: String(appt._id), rescheduledFrom: String(appt._id), actorId: o.actor?.userId },
  );
  appt.status = 'rescheduled';
  appt.active = false;
  await appt.save();
  await audit(tenantId, { action: 'appointment.rescheduled', entity: 'appointment', entityId: String(doc._id), meta: { from: String(appt._id), previousStart: appt.start.toISOString(), start: doc.start.toISOString(), by: o.byBooker ? 'booker' : o.actor?.userId } });
  await publish('appointment.rescheduled', {
    tenantId, appointmentId: String(doc._id), previousAppointmentId: String(appt._id), typeId: appt.typeId, counsellorId: doc.counsellorId,
    start: doc.start.toISOString(), previousStart: appt.start.toISOString(), previousCounsellorId: appt.counsellorId, leadId: appt.who?.leadId, actorId: o.actor?.userId,
  });
  return { doc, token };
};
