import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/** Appointments: staff and public booking, race safety, waitlist, reminders job, scope and isolation. Steps share state and run in order. */
let mongod: MongoMemoryServer;
let app: import('express').Express;

const PW = 'Str0ng-Passw0rd!';
const JOBS = 'jobs-secret-0123456789';
const api = () => request(app);
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const login = async (email: string) => (await api().post('/api/v1/auth/login').send({ email, password: PW })).body.token as string;
const H = 3_600_000;

const S = {
  super: '', tenantA: '', tenantB: '', tenantOff: '',
  owner: '', ownerB: '', ownerOff: '', asha: '', ravi: '', marketing: '',
  ashaId: '', raviId: '', carolId: '', daveId: '',
  typeA: '', typeRR: '', typeHidden: '',
  lead: '', leadOther: '',
  apptStaff: '', apptPublic: { id: '', token: '' }, startStaff: '',
  waitId: '',
};
const events: any[] = [];

const type = (token: string, body: object) => api().post('/api/v1/appointments/types').set(auth(token)).send(body);
const slots = async (typeId: string, o: { token?: string; fromH?: number; spanH?: number; counsellorId?: string } = {}) => {
  const from = new Date(Date.now() + (o.fromH ?? 25) * H);
  const to = new Date(from.getTime() + (o.spanH ?? 48) * H);
  const q = new URLSearchParams({ typeId, from: from.toISOString(), to: to.toISOString(), ...(o.counsellorId ? { counsellorId: o.counsellorId } : {}) });
  const r = await api().get(`/api/v1/appointments/slots?${q}`).set(auth(o.token ?? S.owner));
  expect(r.status).toBe(200);
  return r.body.items as { start: string; end: string; counsellorId: string }[];
};
const pub = (slug = 'alpha') => `/public/${slug}/appointments`;
const phone = (n: number) => `98765${String(10000 + n)}`;
const book = (body: object, slug = 'alpha') => api().post(`${pub(slug)}/book`).send(body);
const modelsOf = async () => await import('../../src/product/modules/appointments/infrastructure/appointment.model.js');

beforeAll(async () => {
  process.env.JOBS_SECRET = JOBS; // read when the app first loads config
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri(), { dbName: 'cp_master' });
  const { hashPassword } = await import('../../src/core/modules/identity/infrastructure/security.js');
  const { User } = await import('../../src/core/modules/identity/infrastructure/user.model.js');
  app = (await import('../../src/app/app.js')).buildApp();
  const { subscribe } = await import('../../src/shared/kernel/events.js');
  subscribe('appointment.reminder_due', (e) => void events.push(e));
  await User.create({ email: 'super@p.test', name: 'Super', passwordHash: await hashPassword(PW), role: 'superadmin', tenantId: null });
  S.super = await login('super@p.test');
  const mk = async (name: string, slug: string, email: string, modules: Record<string, boolean>) => {
    const id = (await api().post('/api/v1/platform/tenants').set(auth(S.super)).send({ name, slug, ownerName: 'Owner', ownerEmail: email, ownerPassword: PW })).body.tenantId as string;
    expect((await api().patch(`/api/v1/platform/tenants/${id}/modules`).set(auth(S.super)).send({ modules })).status).toBe(200);
    return id;
  };
  S.tenantA = await mk('Alpha', 'alpha', 'owner@alpha.test', { appointments: true });
  S.tenantB = await mk('Beta', 'beta', 'owner@beta.test', { appointments: true });
  S.tenantOff = await mk('Off', 'off', 'owner@off.test', {});
  S.owner = await login('owner@alpha.test');
  S.ownerB = await login('owner@beta.test');
  S.ownerOff = await login('owner@off.test');
  const add = async (name: string, email: string, role: string) => (await api().post('/api/v1/team').set(auth(S.owner)).send({ name, email, password: PW, role })).body.id as string;
  S.ashaId = await add('Asha Counsellor', 'asha@alpha.test', 'counsellor');
  S.raviId = await add('Ravi Counsellor', 'ravi@alpha.test', 'counsellor');
  S.carolId = await add('Carol Counsellor', 'carol@alpha.test', 'counsellor');
  S.daveId = await add('Dave Counsellor', 'dave@alpha.test', 'counsellor');
  await add('Mohit Marketing', 'mohit@alpha.test', 'marketing');
  S.asha = await login('asha@alpha.test');
  S.ravi = await login('ravi@alpha.test');
  S.marketing = await login('mohit@alpha.test');
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod?.stop();
});

describe('1. access: module switch and permissions', () => {
  it('module off => 403 MODULE_NOT_ENABLED', async () => {
    const r = await api().get('/api/v1/appointments/types').set(auth(S.ownerOff));
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('MODULE_NOT_ENABLED');
  });
  it('no login => 401, a role without appointment permissions => 403', async () => {
    expect((await api().get('/api/v1/appointments')).status).toBe(401);
    expect((await api().get('/api/v1/appointments').set(auth(S.marketing))).status).toBe(403);
    expect((await api().post('/api/v1/appointments').set(auth(S.marketing)).send({})).status).toBe(403);
  });
  it('a counsellor can read and book but not manage types, hours or time off', async () => {
    expect((await type(S.asha, { name: 'Nope', mode: 'phone', durationMin: 30 })).status).toBe(403);
    expect((await api().put(`/api/v1/appointments/hours/${S.ashaId}`).set(auth(S.asha)).send({ weekly: [] })).status).toBe(403);
    expect((await api().post('/api/v1/appointments/time-off').set(auth(S.asha)).send({ counsellorId: S.ashaId, from: new Date().toISOString(), to: new Date(Date.now() + H).toISOString() })).status).toBe(403);
    expect((await api().get('/api/v1/appointments/types').set(auth(S.asha))).status).toBe(200);
  });
});

describe('2. appointment types and availability', () => {
  it('validates a type and checks the counsellors belong to the team', async () => {
    expect((await type(S.owner, { name: 'x', mode: 'phone', durationMin: 1 })).status).toBe(400);
    expect((await type(S.owner, { name: 'Bad mode', mode: 'fax', durationMin: 30 })).status).toBe(400);
    const stranger = await type(S.owner, { name: 'Stranger', mode: 'phone', durationMin: 30, counsellorIds: ['aaaaaaaaaaaaaaaaaaaaaaaa'] });
    expect(stranger.status).toBe(400);
    expect(stranger.body.error.message).toMatch(/not an active member/);
  });

  it('creates the three types used below', async () => {
    const a = await type(S.owner, {
      name: 'Career call', mode: 'phone', durationMin: 30, slotStepMin: 30, assignment: 'specific', counsellorIds: [S.ashaId], publicBookable: true,
      cancellationNoticeHours: 4, policyText: 'Please cancel 4 hours before.', locationOrLink: 'We will call you',
      intakeQuestions: [{ key: 'course', label: 'Course of interest', required: true }, { key: 'age', label: 'Age' }],
      reminders: [{ offsetMin: 1440 }, { offsetMin: 120 }],
    });
    expect(a.status).toBe(201);
    S.typeA = a.body._id;
    expect(a.body.minNoticeHours).toBe(2);
    expect(a.body.maxAdvanceDays).toBe(30);
    const rr = await type(S.owner, { name: 'Campus tour', mode: 'in_person', durationMin: 60, slotStepMin: 60, assignment: 'round_robin', counsellorIds: [S.carolId, S.daveId], publicBookable: true });
    expect(rr.status).toBe(201);
    S.typeRR = rr.body._id;
    const hidden = await type(S.owner, { name: 'Internal review', mode: 'video', durationMin: 30, counsellorIds: [S.raviId], publicBookable: false });
    S.typeHidden = hidden.body._id;
    expect(hidden.status).toBe(201);
  });

  it('no slots before working hours exist, then weekly hours make them (validated)', async () => {
    expect(await slots(S.typeA)).toEqual([]);
    const bad = await api().put(`/api/v1/appointments/hours/${S.ashaId}`).set(auth(S.owner)).send({ weekly: [{ day: 1, ranges: [{ start: '11:00', end: '10:00' }] }] });
    expect(bad.status).toBe(400);
    expect((await api().put(`/api/v1/appointments/hours/${S.ashaId}`).set(auth(S.owner)).send({ weekly: [{ day: 1, ranges: [{ start: '9am', end: '10:00' }] }] })).status).toBe(400);
    const week = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, ranges: [{ start: '09:00', end: '18:00' }] }));
    for (const id of [S.ashaId, S.raviId, S.carolId, S.daveId]) {
      const r = await api().put(`/api/v1/appointments/hours/${id}`).set(auth(S.owner)).send({ weekly: week });
      expect(r.status).toBe(200);
      expect(r.body.timezone).toBe('Asia/Kolkata');
    }
    expect((await slots(S.typeA)).length).toBeGreaterThan(20);
  });

  it('a counsellor sees only their own hours', async () => {
    expect((await api().get(`/api/v1/appointments/hours/${S.ashaId}`).set(auth(S.asha))).body.weekly).toHaveLength(7);
    expect((await api().get(`/api/v1/appointments/hours/${S.raviId}`).set(auth(S.asha))).status).toBe(403);
  });

  it('slots validate the range and respect time off', async () => {
    const q = (from: Date, to: Date) => api().get(`/api/v1/appointments/slots?typeId=${S.typeA}&from=${from.toISOString()}&to=${to.toISOString()}`).set(auth(S.owner));
    expect((await q(new Date(Date.now() + H), new Date(Date.now()))).status).toBe(400);
    expect((await q(new Date(), new Date(Date.now() + 40 * 24 * H))).status).toBe(400);
    const before = await slots(S.typeA);
    const first = before[0]!;
    const off = await api().post('/api/v1/appointments/time-off').set(auth(S.owner)).send({ counsellorId: S.ashaId, from: new Date(new Date(first.start).getTime() - 60_000).toISOString(), to: new Date(new Date(first.end).getTime() + 60_000).toISOString(), reason: 'Dentist' });
    expect(off.status).toBe(201);
    expect((await slots(S.typeA)).some((s) => s.start === first.start)).toBe(false);
    expect((await api().get(`/api/v1/appointments/time-off?counsellorId=${S.ashaId}`).set(auth(S.owner))).body.items).toHaveLength(1);
    expect((await api().post('/api/v1/appointments/time-off').set(auth(S.owner)).send({ counsellorId: S.ashaId, from: '2026-12-02T10:00:00Z', to: '2026-12-02T09:00:00Z' })).status).toBe(400);
    expect((await api().delete(`/api/v1/appointments/time-off/${off.body._id}`).set(auth(S.owner))).status).toBe(200);
    expect((await slots(S.typeA)).some((s) => s.start === first.start)).toBe(true);
  });
});

describe('3. staff booking, counsellor scope, audit', () => {
  it('books for a lead; refuses a missing required answer and a taken slot', async () => {
    const lead = await api().post('/api/v1/leads').set(auth(S.owner)).send({ name: 'Rahul Sharma', phone: '9876500001', source: { channel: 'walk_in' }, consent: { given: true, source: 'walk_in' } });
    S.lead = lead.body.lead._id;
    S.leadOther = (await api().post('/api/v1/leads').set(auth(S.owner)).send({ name: 'Meena Rao', phone: '9876500002', source: { channel: 'walk_in' }, consent: { given: true, source: 'walk_in' } })).body.lead._id;
    const s = (await slots(S.typeA))[2]!;
    S.startStaff = s.start;
    expect((await api().post('/api/v1/appointments').set(auth(S.owner)).send({ typeId: S.typeA, start: s.start, leadId: S.lead })).status).toBe(400); // required intake answer missing
    expect((await api().post('/api/v1/appointments').set(auth(S.owner)).send({ typeId: S.typeA, start: s.start })).status).toBe(400); // neither lead nor name+phone
    expect((await api().post('/api/v1/appointments').set(auth(S.owner)).send({ typeId: 'nope', start: s.start, leadId: S.lead })).status).toBe(400);
    const ok = await api().post('/api/v1/appointments').set(auth(S.owner)).send({ typeId: S.typeA, start: s.start, leadId: S.lead, answers: { course: 'BBA' } });
    expect(ok.status).toBe(201);
    S.apptStaff = ok.body._id;
    expect(ok.body).toMatchObject({ status: 'booked', source: 'staff', counsellorId: S.ashaId });
    expect(ok.body.who).toMatchObject({ name: 'Rahul Sharma', phone: '+919876500001', leadId: S.lead });
    expect(ok.body.manageTokenHash).toBeUndefined();
    expect(ok.body.reminderState.map((r: any) => r.offsetMin).sort((a: number, b: number) => a - b)).toEqual([120, 1440]);
    const again = await api().post('/api/v1/appointments').set(auth(S.owner)).send({ typeId: S.typeA, start: s.start, leadId: S.leadOther, answers: { course: 'BBA' } });
    expect(again.status).toBe(409);
    expect((await slots(S.typeA)).some((x) => x.start === s.start)).toBe(false);
  });

  it('refuses a start that is not an offered slot (off-grid, past)', async () => {
    const s = (await slots(S.typeA))[0]!;
    const off = new Date(new Date(s.start).getTime() + 7 * 60_000).toISOString();
    const body = (start: string) => ({ typeId: S.typeA, start, name: 'Odd Time', phone: '9876500003', answers: { course: 'MBA' } });
    expect((await api().post('/api/v1/appointments').set(auth(S.owner)).send(body(off))).status).toBe(409);
    expect((await api().post('/api/v1/appointments').set(auth(S.owner)).send(body(new Date(Date.now() - 24 * H).toISOString()))).status).toBe(409);
  });

  it('a counsellor only sees and touches their own calendar', async () => {
    const mine = await api().get('/api/v1/appointments').set(auth(S.asha));
    expect(mine.body.items.map((i: any) => i._id)).toContain(S.apptStaff);
    expect(mine.body.items[0].typeName).toBe('Career call');
    expect((await api().get('/api/v1/appointments').set(auth(S.ravi))).body.items).toHaveLength(0);
    expect((await api().get(`/api/v1/appointments/${S.apptStaff}`).set(auth(S.ravi))).status).toBe(404);
    expect((await api().post(`/api/v1/appointments/${S.apptStaff}/cancel`).set(auth(S.ravi)).send({ reason: 'not mine' })).status).toBe(404);
    expect((await api().get(`/api/v1/appointments/${S.apptStaff}`).set(auth(S.asha))).body.allowedNext).toContain('cancelled');
    // slots for a counsellor are always their own
    expect((await slots(S.typeA, { token: S.ravi })).length).toBe(0);
    // a counsellor cannot book for a lead that is not theirs, but can for their own lead
    const s = (await slots(S.typeA, { token: S.asha }))[0]!;
    expect((await api().post('/api/v1/appointments').set(auth(S.asha)).send({ typeId: S.typeA, start: s.start, leadId: S.lead, answers: { course: 'BBA' } })).status).toBe(403);
    const own = await api().post('/api/v1/leads').set(auth(S.asha)).send({ name: 'Own Lead', phone: '9876500004', source: { channel: 'walk_in' }, consent: { given: true } });
    const booked = await api().post('/api/v1/appointments').set(auth(S.asha)).send({ typeId: S.typeA, start: s.start, leadId: own.body.lead._id, answers: { course: 'BCA' } });
    expect(booked.status).toBe(201);
    expect(booked.body.counsellorId).toBe(S.ashaId);
    expect((await api().post(`/api/v1/appointments/${booked.body._id}/cancel`).set(auth(S.asha)).send({ reason: 'test cleanup' })).status).toBe(200);
  });

  it('writes audit rows', async () => {
    const text = JSON.stringify((await api().get('/api/v1/audit?limit=100').set(auth(S.owner))).body);
    for (const a of ['appointment_type.created', 'appointment.hours_updated', 'appointment.time_off_added', 'appointment.booked']) expect(text).toContain(a);
  });
});

describe('4. public booking: consent, lead, manage link', () => {
  it('lists only bookable types and slots without counsellor details', async () => {
    const t = await api().get(`${pub()}/types`);
    expect(t.status).toBe(200);
    expect(t.body.items.map((i: any) => i.name).sort()).toEqual(['Campus tour', 'Career call']);
    const a = t.body.items.find((i: any) => i.name === 'Career call');
    expect(a.policyText).toContain('4 hours');
    expect(a.locationOrLink).toBeUndefined();
    const from = new Date(Date.now() + 25 * H).toISOString();
    const to = new Date(Date.now() + 73 * H).toISOString();
    const sl = await api().get(`${pub()}/slots?typeId=${S.typeA}&from=${from}&to=${to}`);
    expect(sl.status).toBe(200);
    expect(sl.body.items.length).toBeGreaterThan(10);
    expect(Object.keys(sl.body.items[0]).sort()).toEqual(['end', 'start']);
    expect((await api().get(`${pub()}/slots?typeId=${S.typeHidden}&from=${from}&to=${to}`)).status).toBe(404);
    expect((await api().get(`${pub()}/slots?typeId=bad&from=${from}&to=${to}`)).status).toBe(400);
  });

  it('refuses booking without consent, a hidden type, a bad phone, a minor without guardian', async () => {
    const s = (await slots(S.typeA))[5]!;
    const base = { typeId: S.typeA, start: s.start, name: 'Priya Nair', phone: phone(1), answers: { course: 'BBA' } };
    const noConsent = await book(base);
    expect(noConsent.status).toBe(400);
    expect(noConsent.body.error.code).toBe('CONSENT_REQUIRED');
    expect((await book({ ...base, consentGiven: false })).body.error.code).toBe('CONSENT_REQUIRED');
    expect((await book({ ...base, typeId: S.typeHidden, consentGiven: true })).status).toBe(400);
    expect((await book({ ...base, phone: '12345', consentGiven: true })).status).toBe(400);
    expect((await book({ ...base, answers: {}, consentGiven: true })).body.error.message).toMatch(/Course of interest/);
    const minor = await book({ ...base, answers: { course: 'BBA', age: '16' }, consentGiven: true });
    expect(minor.status).toBe(400);
    expect(minor.body.error.message).toMatch(/under 18/);
    expect((await book({ ...base, answers: { course: 'BBA', age: '16', guardianName: 'Mr Nair', guardianPhone: '9876500009' }, consentGiven: true })).status).toBe(201);
  });

  it('books, creates a lead (channel appointment, consent stored) and returns a manage link', async () => {
    const s = (await slots(S.typeA))[6]!;
    const r = await book({ typeId: S.typeA, start: s.start, name: 'Priya Nair', phone: phone(2), email: 'priya@x.test', answers: { course: 'MBA' }, consentGiven: true });
    expect(r.status).toBe(201);
    expect(r.body.manageToken).toMatch(/^[a-f0-9]{48}$/);
    expect(r.body.manageUrl).toBe(`http://api.test/public/alpha/appointments/manage/${r.body.manageToken}`);
    expect(r.body.policyText).toContain('4 hours');
    expect(r.body.locationOrLink).toBe('We will call you');
    expect(r.body.counsellorId).toBeUndefined();
    S.apptPublic = { id: r.body.id, token: r.body.manageToken };
    const leads = (await api().get(`/api/v1/leads?search=${phone(2)}`).set(auth(S.owner))).body.items;
    expect(leads).toHaveLength(1);
    expect(leads[0].source.channel).toBe('appointment');
    expect(leads[0].consent.given).toBe(true);
    const doc = (await api().get(`/api/v1/appointments/${r.body.id}`).set(auth(S.owner))).body;
    expect(doc).toMatchObject({ source: 'public', who: expect.objectContaining({ leadId: leads[0]._id, email: 'priya@x.test' }) });
    expect(doc.consent.given).toBe(true);
    expect(JSON.stringify(doc)).not.toContain(S.apptPublic.token); // only a hash is stored (and it is not returned)
    const stored = await (await modelsOf()).AppointmentModel(S.tenantA).findById(r.body.id).lean<any>();
    expect(stored.manageTokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(stored.manageTokenHash).not.toBe(S.apptPublic.token);
  });

  it('three people racing for the same slot: exactly one wins, the others get 409', async () => {
    const s = (await slots(S.typeA))[8]!;
    const mk = (n: number) => book({ typeId: S.typeA, start: s.start, name: `Racer ${n}`, phone: phone(10 + n), answers: { course: 'BBA' }, consentGiven: true });
    const results = await Promise.all([mk(1), mk(2), mk(3)]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409]);
    const loser = results.find((r) => r.status === 409)!;
    expect(loser.body.error.message).toMatch(/taken|not available/);
    const count = await (await modelsOf()).AppointmentModel(S.tenantA).countDocuments({ counsellorId: S.ashaId, start: new Date(s.start), active: true });
    expect(count).toBe(1);
  });

  it('a staff booking and a public booking racing for the same slot: one 201, one 409', async () => {
    const s = (await slots(S.typeA))[12]!;
    const [a, b] = await Promise.all([
      api().post('/api/v1/appointments').set(auth(S.owner)).send({ typeId: S.typeA, start: s.start, name: 'Staff Racer', phone: phone(30), answers: { course: 'BBA' } }),
      book({ typeId: S.typeA, start: s.start, name: 'Public Racer', phone: phone(31), answers: { course: 'BBA' }, consentGiven: true }),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
  });
});

describe('5. manage link: view, cancel, reschedule, window', () => {
  it('views the appointment; bad and unknown tokens', async () => {
    const v = await api().get(`${pub()}/manage/${S.apptPublic.token}`);
    expect(v.status).toBe(200);
    expect(v.body).toMatchObject({ typeName: 'Career call', status: 'booked', canChange: true, cancellationNoticeHours: 4 });
    expect(v.body.counsellorId).toBeUndefined();
    expect((await api().get(`${pub()}/manage/not-a-token`)).status).toBe(400);
    expect((await api().get(`${pub()}/manage/${'a'.repeat(48)}`)).status).toBe(404);
    expect((await api().get(`${pub('beta')}/manage/${S.apptPublic.token}`)).status).toBe(404); // another organisation cannot resolve it
  });

  it('reschedules with the link: new time, new token, old link shows rescheduled', async () => {
    const s = (await slots(S.typeA))[20]!;
    const r = await api().post(`${pub()}/manage/${S.apptPublic.token}`).send({ action: 'reschedule', start: s.start });
    expect(r.status).toBe(200);
    expect(r.body.start).toBe(s.start);
    expect(r.body.manageToken).not.toBe(S.apptPublic.token);
    expect((await api().get(`${pub()}/manage/${S.apptPublic.token}`)).body.status).toBe('rescheduled');
    expect((await api().post(`${pub()}/manage/${S.apptPublic.token}`).send({ action: 'cancel' })).status).toBe(400);
    S.apptPublic.token = r.body.manageToken;
    S.apptPublic.id = r.body.id;
    expect((await api().post(`${pub()}/manage/${S.apptPublic.token}`).send({ action: 'reschedule', start: new Date(Date.now() - H).toISOString() })).status).toBe(409);
    expect((await api().post(`${pub()}/manage/${S.apptPublic.token}`).send({ action: 'explode' })).status).toBe(400);
  });

  it('inside the cancellation window the booker is refused with the policy; outside it cancel works once', async () => {
    const { AppointmentModel } = await modelsOf();
    await AppointmentModel(S.tenantA).updateOne({ _id: S.apptPublic.id }, { $set: { start: new Date(Date.now() + 2 * H), end: new Date(Date.now() + 2.5 * H) } });
    const late = await api().post(`${pub()}/manage/${S.apptPublic.token}`).send({ action: 'cancel' });
    expect(late.status).toBe(400);
    expect(late.body.error.message).toMatch(/4 hour/);
    expect((await api().post(`${pub()}/manage/${S.apptPublic.token}`).send({ action: 'reschedule', start: new Date(Date.now() + 60 * H).toISOString() })).status).toBe(400);
    const v = await api().get(`${pub()}/manage/${S.apptPublic.token}`);
    expect(v.body.canChange).toBe(false);
    await AppointmentModel(S.tenantA).updateOne({ _id: S.apptPublic.id }, { $set: { start: new Date(Date.now() + 30 * H), end: new Date(Date.now() + 30.5 * H) } });
    const ok = await api().post(`${pub()}/manage/${S.apptPublic.token}`).send({ action: 'cancel', reason: 'Change of plan' });
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('cancelled');
    expect((await api().post(`${pub()}/manage/${S.apptPublic.token}`).send({ action: 'cancel' })).status).toBe(400);
    const doc = (await api().get(`/api/v1/appointments/${S.apptPublic.id}`).set(auth(S.owner))).body;
    expect(doc).toMatchObject({ status: 'cancelled', cancelledBy: 'booker', cancelReason: 'Change of plan' });
  });

  it('unknown and module-off organisations give 404', async () => {
    expect((await api().get('/public/nobody/appointments/types')).status).toBe(404);
    expect((await api().get('/public/off/appointments/types')).status).toBe(404);
    expect((await api().post('/public/off/appointments/book').send({})).status).toBe(404);
  });
});

describe('6. staff actions, waitlist offer, transitions', () => {
  it('waiting list: add, validate, de-duplicate', async () => {
    const add = (body: object) => api().post('/api/v1/appointments/waitlist').set(auth(S.owner)).send(body);
    expect((await add({ typeId: S.typeA, name: 'Wait Er', phone: '123' })).status).toBe(400);
    const r = await add({ typeId: S.typeA, name: 'Wait Er', phone: phone(50) });
    expect(r.status).toBe(201);
    S.waitId = r.body._id;
    expect(r.body.status).toBe('waiting');
    expect((await add({ typeId: S.typeA, name: 'Wait Er', phone: phone(50) })).body.duplicate).toBe(true);
    expect((await api().get('/api/v1/appointments/waitlist?status=waiting').set(auth(S.owner))).body.total).toBe(1);
    expect((await api().get('/api/v1/appointments/waitlist').set(auth(S.marketing))).status).toBe(403);
  });

  it('cancelling needs a reason, frees the slot and offers it to the first waiting person', async () => {
    expect((await api().post(`/api/v1/appointments/${S.apptStaff}/cancel`).set(auth(S.owner)).send({})).status).toBe(400);
    const r = await api().post(`/api/v1/appointments/${S.apptStaff}/cancel`).set(auth(S.owner)).send({ reason: 'Counsellor unwell' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: 'cancelled', cancelReason: 'Counsellor unwell', cancelledBy: expect.stringMatching(/^staff:/) });
    expect((await api().post(`/api/v1/appointments/${S.apptStaff}/cancel`).set(auth(S.owner)).send({ reason: 'again' })).status).toBe(400);
    const w = (await api().get('/api/v1/appointments/waitlist').set(auth(S.owner))).body.items.find((i: any) => i._id === S.waitId);
    expect(w.status).toBe('offered');
    expect(new Date(w.offeredStart).toISOString()).toBe(new Date(S.startStaff).toISOString());
    expect(w.offeredCounsellorId).toBe(S.ashaId);
    expect((await slots(S.typeA)).some((s) => s.start === S.startStaff)).toBe(true); // slot is bookable again
    const audit = JSON.stringify((await api().get('/api/v1/audit?limit=100').set(auth(S.owner))).body);
    expect(audit).toContain('appointment.cancelled');
    expect(audit).toContain('appointment.waitlist_offered');
  });

  it('booking by the waiting person fulfils their entry', async () => {
    const r = await book({ typeId: S.typeA, start: S.startStaff, name: 'Wait Er', phone: phone(50), answers: { course: 'BCA' }, consentGiven: true });
    expect(r.status).toBe(201);
    const w = (await api().get('/api/v1/appointments/waitlist?status=booked').set(auth(S.owner))).body.items;
    expect(w.map((i: any) => i._id)).toContain(S.waitId);
  });

  it('staff reschedule retires the old appointment; confirm, complete and no-show follow the status rules', async () => {
    const [s1, s2] = (await slots(S.typeA, { fromH: 49 })).slice(0, 2) as [any, any];
    const a = await api().post('/api/v1/appointments').set(auth(S.owner)).send({ typeId: S.typeA, start: s1.start, leadId: S.leadOther, answers: { course: 'BBA' } });
    expect(a.status).toBe(201);
    const moved = await api().post(`/api/v1/appointments/${a.body._id}/reschedule`).set(auth(S.owner)).send({ start: s2.start });
    expect(moved.status).toBe(200);
    expect(moved.body._id).not.toBe(a.body._id);
    expect(moved.body.rescheduledFrom).toBe(a.body._id);
    expect((await api().get(`/api/v1/appointments/${a.body._id}`).set(auth(S.owner))).body.status).toBe('rescheduled');
    expect((await api().post(`/api/v1/appointments/${a.body._id}/reschedule`).set(auth(S.owner)).send({ start: s1.start })).status).toBe(400);
    expect((await api().post(`/api/v1/appointments/${moved.body._id}/reschedule`).set(auth(S.owner)).send({ start: s2.start })).status).toBe(400); // same time
    expect((await slots(S.typeA, { fromH: 49 })).some((s) => s.start === s1.start)).toBe(true); // the old slot is free again

    const id = moved.body._id;
    expect((await api().post(`/api/v1/appointments/${id}/confirm`).set(auth(S.owner))).body.status).toBe('confirmed');
    expect((await api().post(`/api/v1/appointments/${id}/no-show`).set(auth(S.owner))).status).toBe(400); // has not started yet
    expect((await api().post(`/api/v1/appointments/${id}/complete`).set(auth(S.owner)).send({})).status).toBe(400);
    const { AppointmentModel } = await modelsOf();
    await AppointmentModel(S.tenantA).updateOne({ _id: id }, { $set: { start: new Date(Date.now() - 3 * H), end: new Date(Date.now() - 2.5 * H) } });
    const ns = await api().post(`/api/v1/appointments/${id}/no-show`).set(auth(S.owner));
    expect(ns.status).toBe(200);
    expect(ns.body.status).toBe('no_show');
    expect((await api().post(`/api/v1/appointments/${id}/complete`).set(auth(S.owner)).send({})).status).toBe(400); // terminal
    expect((await api().post(`/api/v1/appointments/${id}/confirm`).set(auth(S.owner))).status).toBe(400);
  });

  it('completing records notes', async () => {
    const s = (await slots(S.typeA, { fromH: 73 }))[0]!;
    const a = await api().post('/api/v1/appointments').set(auth(S.owner)).send({ typeId: S.typeA, start: s.start, name: 'Done Person', phone: phone(60), answers: { course: 'BBA' } });
    const { AppointmentModel } = await modelsOf();
    await AppointmentModel(S.tenantA).updateOne({ _id: a.body._id }, { $set: { start: new Date(Date.now() - 2 * H), end: new Date(Date.now() - 1.5 * H) } });
    const c = await api().post(`/api/v1/appointments/${a.body._id}/complete`).set(auth(S.owner)).send({ notes: 'Shortlisted 3 colleges' });
    expect(c.status).toBe(200);
    expect(c.body).toMatchObject({ status: 'completed', notes: 'Shortlisted 3 colleges' });
  });

  it('list filters and summary', async () => {
    const all = await api().get('/api/v1/appointments?limit=100').set(auth(S.owner));
    expect(all.body.total).toBeGreaterThan(5);
    const cancelled = await api().get('/api/v1/appointments?status=cancelled').set(auth(S.owner));
    expect(cancelled.body.items.every((i: any) => i.status === 'cancelled')).toBe(true);
    expect((await api().get('/api/v1/appointments?status=bogus').set(auth(S.owner))).status).toBe(400);
    const sum = (await api().get('/api/v1/appointments/summary').set(auth(S.owner))).body;
    expect(sum.upcoming7Days).toBeGreaterThan(0);
    expect(sum.last30Days).toMatchObject({ completed: 1, noShow: 1, noShowRate: 0.5 });
    expect(sum.today).toHaveProperty('total');
  });
});

describe('7. round-robin assignment', () => {
  it('spreads bookings: ties go to the lowest id, then the other counsellor', async () => {
    const sl = await slots(S.typeRR, { fromH: 25, spanH: 72 });
    expect(new Set(sl.map((s) => s.start)).size).toBe(sl.length); // one slot per start time
    const [lowId, highId] = [S.carolId, S.daveId].sort() as [string, string];
    expect(sl[0]!.counsellorId).toBe(lowId); // offered with the counsellor who would get it
    const first = await api().post('/api/v1/appointments').set(auth(S.owner)).send({ typeId: S.typeRR, start: sl[0]!.start, name: 'Tourist 1', phone: phone(71) });
    expect(first.body.counsellorId).toBe(lowId);
    const sl2 = await slots(S.typeRR, { fromH: 25, spanH: 72 });
    expect(sl2.find((s) => s.start === sl[2]!.start)!.counsellorId).toBe(highId);
    const second = (await book({ typeId: S.typeRR, start: sl[2]!.start, name: 'Tourist 2', phone: phone(72), consentGiven: true })).body;
    const fromDb = await (await modelsOf()).AppointmentModel(S.tenantA).findById(second.id).lean<any>();
    expect(fromDb.counsellorId).toBe(highId);
    // the same start as the first booking is still bookable by the other counsellor once, then it is gone
    const sameStart = sl[0]!.start;
    const third = await api().post('/api/v1/appointments').set(auth(S.owner)).send({ typeId: S.typeRR, start: sameStart, name: 'Tourist 3', phone: phone(73) });
    expect(third.status).toBe(201);
    expect(third.body.counsellorId).toBe(highId);
    expect((await api().post('/api/v1/appointments').set(auth(S.owner)).send({ typeId: S.typeRR, start: sameStart, name: 'Tourist 4', phone: phone(74) })).status).toBe(409);
  });
});

describe('8. the contract used by the bot', () => {
  it('listBookableTypes, getAvailableSlots, bookAppointment', async () => {
    const api2 = await import('../../src/product/modules/appointments/index.js');
    const types = await api2.listBookableTypes(S.tenantA);
    expect(types.map((t) => t.name).sort()).toEqual(['Campus tour', 'Career call']);
    expect(types[0]).toEqual({ id: expect.any(String), name: expect.any(String), mode: expect.any(String), durationMin: expect.any(Number) });
    const from = new Date(Date.now() + 100 * H);
    const to = new Date(from.getTime() + 24 * H);
    const free = await api2.getAvailableSlots(S.tenantA, { typeId: S.typeA, from, to });
    expect(free[0]!.start).toBeInstanceOf(Date);
    expect(free[0]!.counsellorId).toBe(S.ashaId);
    await expect(api2.getAvailableSlots(S.tenantA, { typeId: S.typeHidden, from, to })).rejects.toThrow(/cannot be booked online/);
    await expect(api2.bookAppointment(S.tenantA, { typeId: S.typeA, start: free[0]!.start, name: 'Bot Person', phone: phone(80), answers: { course: 'BBA' }, source: 'bot', consentGiven: false })).rejects.toThrow(/consent/);
    const b = await api2.bookAppointment(S.tenantA, { typeId: S.typeA, start: free[0]!.start, name: 'Bot Person', phone: phone(80), answers: { course: 'BBA' }, source: 'bot', consentGiven: true });
    expect(b).toMatchObject({ id: expect.any(String), counsellorId: S.ashaId, manageToken: expect.stringMatching(/^[a-f0-9]{48}$/) });
    expect(b.start).toEqual(free[0]!.start);
    expect(b.end.getTime() - b.start.getTime()).toBe(30 * 60_000);
    await expect(api2.bookAppointment(S.tenantA, { typeId: S.typeA, start: free[0]!.start, name: 'Bot Two', phone: phone(81), answers: { course: 'BBA' }, source: 'bot', consentGiven: true })).rejects.toMatchObject({ status: 409 });
    const stored = (await api().get(`/api/v1/appointments/${b.id}`).set(auth(S.owner))).body;
    expect(stored.source).toBe('bot');
    expect(JSON.stringify((await api().get('/api/v1/audit?limit=100').set(auth(S.owner))).body)).toContain(b.id);
  });
});

describe('9. reminders job', () => {
  const run = (secret?: string) => api().post('/public/appointments/jobs/run-reminders').set(secret ? { 'x-jobs-secret': secret } : {}).send({});

  it('refuses without or with a wrong secret', async () => {
    expect((await run()).status).toBe(401);
    expect((await run('wrong-secret-wrong-secret')).status).toBe(401);
  });

  it('sends each due reminder once; a second run, or a cancelled appointment, sends nothing', async () => {
    const { AppointmentModel } = await modelsOf();
    const A = AppointmentModel(S.tenantA);
    const s = (await slots(S.typeA, { fromH: 120 }))[0]!;
    const a = await api().post('/api/v1/appointments').set(auth(S.owner)).send({ typeId: S.typeA, start: s.start, name: 'Remind Me', phone: phone(90), answers: { course: 'BBA' } });
    const c = await api().post('/api/v1/appointments').set(auth(S.owner)).send({ typeId: S.typeA, start: (await slots(S.typeA, { fromH: 120 }))[0]!.start, name: 'Cancel Me', phone: phone(91), answers: { course: 'BBA' } });
    const soon = (m: number) => ({ start: new Date(Date.now() + m * 60_000), end: new Date(Date.now() + (m + 30) * 60_000) });
    await A.updateOne({ _id: a.body._id }, { $set: soon(180) }); // 24 h reminder is due, the 2 h one is not yet
    await A.updateOne({ _id: c.body._id }, { $set: soon(100) });
    await api().post(`/api/v1/appointments/${c.body._id}/cancel`).set(auth(S.owner)).send({ reason: 'no longer needed' });
    events.length = 0;
    const before = await A.find({ active: true, start: { $gt: new Date() } }).lean<any[]>();
    const expected = before.reduce((n, x) => n + (x.reminderState ?? []).filter((r: any) => !r.sentAt && x.start.getTime() - r.offsetMin * 60_000 <= Date.now()).length, 0);
    expect(expected).toBeGreaterThanOrEqual(1);

    const first = await run(JOBS);
    expect(first.status).toBe(200);
    expect(first.body.tenants).toBe(2); // Alpha and Beta have the module on; Off does not
    expect(first.body.reminders).toBe(expected);
    const mine = events.filter((e) => e.appointmentId === a.body._id);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ tenantId: S.tenantA, offsetMin: 1440, typeId: S.typeA });
    expect(events.some((e) => e.appointmentId === c.body._id)).toBe(false); // cancelled: no reminder

    const second = await run(JOBS);
    expect(second.body.reminders).toBe(0);
    expect(events.filter((e) => e.appointmentId === a.body._id)).toHaveLength(1);

    // time moves on: the 2 h reminder becomes due, once
    await A.updateOne({ _id: a.body._id }, { $set: soon(90) });
    expect((await run(JOBS)).body.reminders).toBe(1);
    expect((await run(JOBS)).body.reminders).toBe(0);
    expect(events.filter((e) => e.appointmentId === a.body._id).map((e) => e.offsetMin).sort((x, y) => x - y)).toEqual([120, 1440]);
    expect(JSON.stringify((await api().get('/api/v1/audit?limit=100').set(auth(S.owner))).body)).toContain('appointment.reminder_due');
  });
});

describe('10. isolation between organisations', () => {
  it('another organisation sees nothing and cannot use our ids', async () => {
    expect((await api().get('/api/v1/appointments').set(auth(S.ownerB))).body.total).toBe(0);
    expect((await api().get('/api/v1/appointments/types').set(auth(S.ownerB))).body.items).toHaveLength(0);
    expect((await api().get(`/api/v1/appointments/${S.apptStaff}`).set(auth(S.ownerB))).status).toBe(404);
    expect((await api().post(`/api/v1/appointments/${S.apptStaff}/cancel`).set(auth(S.ownerB)).send({ reason: 'not yours' })).status).toBe(404);
    expect((await api().get(`/api/v1/appointments/types/${S.typeA}`).set(auth(S.ownerB))).status).toBe(404);
    const s = (await slots(S.typeA))[0]!;
    expect((await api().post('/api/v1/appointments').set(auth(S.ownerB)).send({ typeId: S.typeA, start: s.start, name: 'Spy Person', phone: phone(95) })).status).toBe(404);
    expect((await api().get(`${pub('beta')}/slots?typeId=${S.typeA}&from=${new Date(Date.now() + 25 * H).toISOString()}&to=${new Date(Date.now() + 49 * H).toISOString()}`)).status).toBe(404);
    expect((await api().get(`${pub('beta')}/types`)).body.items).toHaveLength(0);
    expect((await api().get('/api/v1/appointments/waitlist').set(auth(S.ownerB))).body.total).toBe(0);
  });
});

describe('11. student data: export section and erase', () => {
  it('contributes to the student export and anonymises on student.erased', async () => {
    const studentId = 'bbbbbbbbbbbbbbbbbbbbbbbb';
    const s = (await slots(S.typeA, { fromH: 150 }))[0]!;
    const a = await api().post('/api/v1/appointments').set(auth(S.owner)).send({ typeId: S.typeA, start: s.start, studentId, name: 'Erase Me', phone: phone(99), email: 'erase@x.test', answers: { course: 'BBA' }, notes: 'private note' });
    expect(a.status).toBe(201);
    const { collectSections } = await import('../../src/shared/kernel/hooks.js');
    const sections = await collectSections('student.export', { tenantId: S.tenantA, studentId });
    const mine = sections.find((x) => x.section === 'appointments')!;
    expect((mine.data as any[]).map((x) => x.id)).toEqual([a.body._id]);
    const { publish } = await import('../../src/shared/kernel/events.js');
    await publish('student.erased', { tenantId: S.tenantA, studentId });
    const after = (await api().get(`/api/v1/appointments/${a.body._id}`).set(auth(S.owner))).body;
    expect(after.who).toMatchObject({ name: 'Erased student', phone: 'erased' });
    expect(after.who.email).toBeUndefined();
    expect(after.answers ?? {}).toEqual({});
    expect(after.notes ?? '').toBe('');
    expect(after.status).toBe('booked'); // the record and its counts remain
  });
});
