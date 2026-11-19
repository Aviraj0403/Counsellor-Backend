import { Router } from 'express';
import { z } from 'zod';
import type { Guards } from '../../../../contracts/guards.js';
import { validate } from '../../../../shared/http/validate.js';
import { objectId, paging } from '../../../../shared/http/schemas.js';
import { ASSIGNMENTS, HHMM, MODES, STATUSES } from '../domain/appointment.domain.js';
import * as svc from '../application/appointment.service.js';

const id = z.object({ id: objectId });
const flag = z.enum(['1', 'true', '0', 'false']).transform((v) => v === '1' || v === 'true');
const hhmm = z.string().regex(HHMM, 'Times must look like 09:30.');
const answers = z.record(z.string().max(40), z.string().max(500)).optional();

const typeBody = z.object({
  name: z.string().trim().min(2).max(120),
  description: z.string().max(1000).optional(),
  mode: z.enum(MODES),
  durationMin: z.number().int().min(5).max(480),
  bufferBeforeMin: z.number().int().min(0).max(240).optional(),
  bufferAfterMin: z.number().int().min(0).max(240).optional(),
  minNoticeHours: z.number().min(0).max(720).optional(),
  maxAdvanceDays: z.number().int().min(1).max(365).optional(),
  slotStepMin: z.number().int().min(5).max(240).optional(),
  assignment: z.enum(ASSIGNMENTS).optional(),
  counsellorIds: z.array(objectId).max(50).optional(),
  intakeQuestions: z.array(z.object({ key: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/, 'Use letters, digits and _ only.'), label: z.string().min(1).max(160), required: z.boolean().optional() })).max(20).optional(),
  cancellationNoticeHours: z.number().min(0).max(720).optional(),
  policyText: z.string().max(1000).optional(),
  reminders: z.array(z.object({ offsetMin: z.number().int().min(1).max(14 * 24 * 60), channel: z.literal('whatsapp').optional() })).max(5).optional(),
  publicBookable: z.boolean().optional(),
  active: z.boolean().optional(),
  locationOrLink: z.string().max(400).optional(),
});

const A = (g: Guards) => ({ read: g.requirePermission('appointments:read'), write: g.requirePermission('appointments:write'), manage: g.requirePermission('appointments:manage') });

export const appointmentRoutes = (g: Guards): Router => {
  const r = Router();
  const p = A(g);
  const wrap = (fn: (req: any) => Promise<unknown>, status = 200) => async (req: any, res: any, next: any) => {
    try {
      res.status(status).json(await fn(req));
    } catch (e) {
      next(e);
    }
  };

  r.get('/summary', p.read, wrap((req) => svc.summary(req.principal)));

  r.get('/slots', p.read, validate({ query: z.object({ typeId: objectId, from: z.coerce.date(), to: z.coerce.date(), counsellorId: objectId.optional() }) }), wrap((req) => svc.staffSlots(req.principal, req.valid.query)));

  // ---- appointment types
  r.get('/types', p.read, validate({ query: z.object({ includeInactive: flag.optional() }) }), wrap((req) => svc.listTypes(req.principal, req.valid.query)));
  r.post('/types', p.manage, validate({ body: typeBody }), wrap((req) => svc.createType(req.principal, req.valid.body), 201));
  r.get('/types/:id', p.read, validate({ params: id }), wrap((req) => svc.getType(req.principal, req.valid.params.id)));
  r.patch('/types/:id', p.manage, validate({ params: id, body: typeBody.partial() }), wrap((req) => svc.updateType(req.principal, req.valid.params.id, req.valid.body)));
  r.delete('/types/:id', p.manage, validate({ params: id }), wrap((req) => svc.deactivateType(req.principal, req.valid.params.id)));

  // ---- availability
  const counsellor = z.object({ counsellorId: objectId });
  r.get('/hours/:counsellorId', p.read, validate({ params: counsellor }), wrap((req) => svc.getHours(req.principal, req.valid.params.counsellorId)));
  r.put(
    '/hours/:counsellorId',
    p.manage,
    validate({ params: counsellor, body: z.object({ weekly: z.array(z.object({ day: z.number().int().min(0).max(6), ranges: z.array(z.object({ start: hhmm, end: hhmm })).max(6) })).max(7) }) }),
    wrap((req) => svc.setHours(req.principal, req.valid.params.counsellorId, req.valid.body.weekly)),
  );
  r.get('/time-off', p.read, validate({ query: z.object({ counsellorId: objectId.optional() }) }), wrap((req) => svc.listTimeOff(req.principal, req.valid.query)));
  r.post('/time-off', p.manage, validate({ body: z.object({ counsellorId: objectId, from: z.coerce.date(), to: z.coerce.date(), reason: z.string().max(200).optional() }) }), wrap((req) => svc.addTimeOff(req.principal, req.valid.body), 201));
  r.delete('/time-off/:id', p.manage, validate({ params: id }), wrap((req) => svc.removeTimeOff(req.principal, req.valid.params.id)));

  // ---- waiting list
  r.get('/waitlist', p.read, validate({ query: paging.extend({ status: z.enum(['waiting', 'offered', 'booked', 'expired']).optional(), typeId: objectId.optional() }) }), wrap((req) => svc.listWaitlist(req.principal, req.valid.query)));
  r.post(
    '/waitlist',
    p.write,
    validate({ body: z.object({ typeId: objectId, name: z.string().trim().min(2).max(120), phone: z.string().min(6).max(20), preferredFrom: z.coerce.date().optional(), preferredTo: z.coerce.date().optional() }) }),
    wrap((req) => svc.addWaitlist(req.principal, req.valid.body), 201),
  );
  r.post('/waitlist/:id/expire', p.write, validate({ params: id }), wrap((req) => svc.expireWaitlist(req.principal, req.valid.params.id)));

  // ---- appointments
  r.post(
    '/',
    p.write,
    validate({
      body: z.object({
        typeId: objectId,
        start: z.coerce.date(),
        leadId: objectId.optional(),
        studentId: objectId.optional(),
        name: z.string().trim().min(2).max(120).optional(),
        phone: z.string().min(6).max(20).optional(),
        email: z.string().email().max(160).optional(),
        answers,
        counsellorId: objectId.optional(),
        notes: z.string().max(2000).optional(),
        consentGiven: z.boolean().optional(),
      }),
    }),
    wrap((req) => svc.staffBook(req.principal, req.valid.body), 201),
  );
  r.get(
    '/',
    p.read,
    validate({ query: paging.extend({ from: z.coerce.date().optional(), to: z.coerce.date().optional(), status: z.enum(STATUSES).optional(), typeId: objectId.optional(), counsellorId: objectId.optional(), mine: flag.optional() }) }),
    wrap((req) => svc.listAppointments(req.principal, req.valid.query)),
  );
  r.get('/:id', p.read, validate({ params: id }), wrap((req) => svc.getAppointment(req.principal, req.valid.params.id)));
  r.post('/:id/reschedule', p.write, validate({ params: id, body: z.object({ start: z.coerce.date(), counsellorId: objectId.optional() }) }), wrap((req) => svc.rescheduleAppointment(req.principal, req.valid.params.id, req.valid.body)));
  r.post('/:id/cancel', p.write, validate({ params: id, body: z.object({ reason: z.string().trim().min(2).max(500) }) }), wrap((req) => svc.cancelAppointment(req.principal, req.valid.params.id, req.valid.body.reason)));
  r.post('/:id/confirm', p.write, validate({ params: id }), wrap((req) => svc.confirmAppointment(req.principal, req.valid.params.id)));
  r.post('/:id/complete', p.write, validate({ params: id, body: z.object({ notes: z.string().max(2000).optional() }) }), wrap((req) => svc.completeAppointment(req.principal, req.valid.params.id, req.valid.body.notes)));
  r.post('/:id/no-show', p.write, validate({ params: id }), wrap((req) => svc.markNoShow(req.principal, req.valid.params.id)));

  return r;
};
