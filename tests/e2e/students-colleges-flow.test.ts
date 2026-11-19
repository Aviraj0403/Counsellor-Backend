import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/** Students + colleges: create, DPDP minor rule, from-lead, scope, export, erase, directory, import, shortlist, isolation. */
let mongod: MongoMemoryServer;
let app: import('express').Express;

const PW = 'Str0ng-Passw0rd!';
const api = () => request(app);
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const login = async (email: string) => (await api().post('/api/v1/auth/login').send({ email, password: PW })).body.token as string;
const S = { super: '', tenant: '', tenantOff: '', tenantB: '', owner: '', ownerOff: '', ownerB: '', counsellor: '', counsellorId: '', marketing: '', lead: '', student: '', collegeId: '', courseId: '' };

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri(), { dbName: 'cp_master' });
  const { hashPassword } = await import('../../src/core/modules/identity/infrastructure/security.js');
  const { User } = await import('../../src/core/modules/identity/infrastructure/user.model.js');
  app = (await import('../../src/app/app.js')).buildApp();
  await User.create({ email: 'super@p.test', name: 'S', passwordHash: await hashPassword(PW), role: 'superadmin', tenantId: null });
  S.super = await login('super@p.test');
  const mk = async (name: string, slug: string, email: string) =>
    (await api().post('/api/v1/platform/tenants').set(auth(S.super)).send({ name, slug, ownerName: 'Owner', ownerEmail: email, ownerPassword: PW })).body.tenantId as string;
  S.tenant = await mk('Alpha Edu', 'alpha-edu', 'owner@alpha.test');
  S.tenantB = await mk('Beta Edu', 'beta-edu', 'owner@beta.test');
  S.tenantOff = await mk('Off Edu', 'off-edu', 'owner@off.test');
  for (const t of [S.tenant, S.tenantB]) {
    const r = await api().patch(`/api/v1/platform/tenants/${t}/modules`).set(auth(S.super)).send({ modules: { students: true, colleges: true } });
    expect(r.status).toBe(200);
  }
  S.owner = await login('owner@alpha.test');
  S.ownerB = await login('owner@beta.test');
  S.ownerOff = await login('owner@off.test');
  const add = async (name: string, email: string, role: string) => (await api().post('/api/v1/team').set(auth(S.owner)).send({ name, email, password: PW, role })).body.id as string;
  S.counsellorId = await add('Asha Counsellor', 'asha@alpha.test', 'counsellor');
  await add('Mohit Marketing', 'mohit@alpha.test', 'marketing');
  S.counsellor = await login('asha@alpha.test');
  S.marketing = await login('mohit@alpha.test');
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod?.stop();
});

const student = (token: string, body: object = {}) =>
  api().post('/api/v1/students').set(auth(token)).send({ name: 'Ravi Kumar', phone: '98765 43210', dob: '2000-01-01', consent: { given: true, source: 'office' }, ...body });

describe('module switch and permissions', () => {
  it('module off => 403 MODULE_NOT_ENABLED', async () => {
    for (const p of ['/students', '/colleges']) {
      const r = await api().get(`/api/v1${p}`).set(auth(S.ownerOff));
      expect(r.status).toBe(403);
      expect(r.body.error.code).toBe('MODULE_NOT_ENABLED');
    }
  });
  it('marketing cannot read students nor write colleges, but can read colleges', async () => {
    expect((await api().get('/api/v1/students').set(auth(S.marketing))).status).toBe(403);
    expect((await api().post('/api/v1/colleges').set(auth(S.marketing)).send({ name: 'X College' })).status).toBe(403);
    expect((await api().get('/api/v1/colleges').set(auth(S.marketing))).status).toBe(200);
  });
});

describe('students', () => {
  it('creates a student with a normalised phone; duplicate phone is 409; bad input is 400', async () => {
    const r = await student(S.owner);
    expect(r.status).toBe(201);
    expect(r.body.phone).toBe('+919876543210');
    S.student = r.body._id;
    expect((await student(S.owner, { phone: '9876543210' })).status).toBe(409);
    expect((await student(S.owner, { phone: '123' })).status).toBe(400);
    expect((await student(S.owner, { name: 'A', phone: '9000000009' })).status).toBe(400);
  });

  it('DPDP: a minor needs guardian consent', async () => {
    const dob = new Date(Date.now() - 15 * 365.25 * 86400000).toISOString().slice(0, 10);
    const no = await student(S.owner, { phone: '9000000001', dob });
    expect(no.status).toBe(400);
    expect(no.body.error.message).toMatch(/under 18/);
    const yes = await student(S.owner, { phone: '9000000001', dob, consent: { given: true, guardianConsent: { given: true, by: 'Mother' } } });
    expect(yes.status).toBe(201);
    expect(yes.body.consent.guardianConsent.given).toBe(true);
    // cannot move an adult to a minor dob without guardian consent
    const patch = await api().patch(`/api/v1/students/${S.student}`).set(auth(S.owner)).send({ dob });
    expect(patch.status).toBe(400);
  });

  it('creates from a lead once; second attempt is 409; publishes via audit', async () => {
    const lead = await api().post('/api/v1/leads').set(auth(S.owner)).send({ name: 'Priya Singh', phone: '9123456780', city: 'Pune', interestedCourse: 'MBA', source: { channel: 'website' }, consent: { given: true, source: 'web_form' } });
    S.lead = lead.body.lead._id;
    const r = await api().post(`/api/v1/students/from-lead/${S.lead}`).set(auth(S.owner)).send({});
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ name: 'Priya Singh', phone: '+919123456780', leadId: S.lead });
    expect(r.body.address.city).toBe('Pune');
    expect(r.body.preferences.courses).toEqual(['MBA']);
    expect(r.body.consent.given).toBe(true);
    expect((await api().post(`/api/v1/students/from-lead/${S.lead}`).set(auth(S.owner)).send({})).status).toBe(409);
    expect((await api().post(`/api/v1/students/from-lead/${'a'.repeat(24)}`).set(auth(S.owner)).send({})).status).toBe(404);
  });

  it('update works; search and paging work', async () => {
    const u = await api().patch(`/api/v1/students/${S.student}`).set(auth(S.owner)).send({ academics: [{ level: '12th', board: 'CBSE', year: 2018, percentage: 82 }], preferences: { courses: ['B.Tech'], budgetMaxPaise: 200000000 } });
    expect(u.status).toBe(200);
    expect(u.body.academics[0].percentage).toBe(82);
    const list = (await api().get('/api/v1/students?search=ravi&limit=1').set(auth(S.owner))).body;
    expect(list.total).toBe(2); // two students named Ravi (the minor from the DPDP test)
    expect(list.items).toHaveLength(1);
    expect((await api().get('/api/v1/students?search=98765').set(auth(S.owner))).body.total).toBe(1);
  });

  it('a counsellor only sees students assigned to them', async () => {
    expect((await api().get('/api/v1/students').set(auth(S.counsellor))).body.total).toBe(0);
    expect((await api().get(`/api/v1/students/${S.student}`).set(auth(S.counsellor))).status).toBe(404);
    await api().patch(`/api/v1/students/${S.student}`).set(auth(S.owner)).send({ assignedTo: S.counsellorId });
    expect((await api().get('/api/v1/students').set(auth(S.counsellor))).body.total).toBe(1);
    const own = await student(S.counsellor, { name: 'Counsellor Made', phone: '9000000002' });
    expect(own.body.assignedTo).toBe(S.counsellorId);
    expect((await api().get('/api/v1/students/' + S.student + '/export').set(auth(S.counsellor))).status).toBe(403);
  });

  it('organisations are isolated; same phone allowed in another organisation', async () => {
    expect((await api().get('/api/v1/students').set(auth(S.ownerB))).body.total).toBe(0);
    expect((await api().get(`/api/v1/students/${S.student}`).set(auth(S.ownerB))).status).toBe(404);
    expect((await student(S.ownerB)).status).toBe(201);
  });

  it('export returns the student and sections and is audited', async () => {
    const r = await api().get(`/api/v1/students/${S.student}/export`).set(auth(S.owner));
    expect(r.status).toBe(200);
    expect(r.body.student._id).toBe(S.student);
    expect(Array.isArray(r.body.sections)).toBe(true);
    expect(r.body.exportedAt).toBeTruthy();
    const audit = (await api().get(`/api/v1/audit?entityId=${S.student}`).set(auth(S.owner))).body.items.map((a: any) => a.action);
    expect(audit).toEqual(expect.arrayContaining(['student.created', 'student.updated', 'student.exported']));
  });

  it('erase needs permission, typed confirmation and a reason; anonymises; is irreversible', async () => {
    expect((await api().post(`/api/v1/students/${S.student}/erase`).set(auth(S.counsellor)).send({ confirm: 'ERASE', reason: 'request' })).status).toBe(403);
    expect((await api().post(`/api/v1/students/${S.student}/erase`).set(auth(S.owner)).send({ confirm: 'erase', reason: 'request' })).status).toBe(400);
    expect((await api().post(`/api/v1/students/${S.student}/erase`).set(auth(S.owner)).send({ confirm: 'ERASE' })).status).toBe(400);
    const ok = await api().post(`/api/v1/students/${S.student}/erase`).set(auth(S.owner)).send({ confirm: 'ERASE', reason: 'Parent request' });
    expect(ok.status).toBe(200);
    expect(ok.body.counts.academics).toBe(1);
    const d = (await api().get(`/api/v1/students/${S.student}`).set(auth(S.owner))).body;
    expect(d).toMatchObject({ name: 'Erased student', status: 'erased' });
    expect(d.phone).toBeUndefined();
    expect(d.academics).toBeUndefined();
    expect(d.dob).toBeUndefined();
    expect((await api().post(`/api/v1/students/${S.student}/erase`).set(auth(S.owner)).send({ confirm: 'ERASE', reason: 'again' })).status).toBe(409);
    expect((await api().patch(`/api/v1/students/${S.student}`).set(auth(S.owner)).send({ name: 'Back Again' })).status).toBe(409);
    const hidden = (await api().get('/api/v1/students?limit=100').set(auth(S.owner))).body.items.map((s: any) => s._id);
    expect(hidden).not.toContain(S.student);
    const shown = (await api().get('/api/v1/students?includeErased=1&limit=100').set(auth(S.owner))).body.items.map((s: any) => s._id);
    expect(shown).toContain(S.student);
    // the phone is free again
    expect((await student(S.owner, { name: 'New Owner Of Number' })).status).toBe(201);
    const audit = (await api().get(`/api/v1/audit?entityId=${S.student}`).set(auth(S.owner))).body.items.map((a: any) => a.action);
    expect(audit).toContain('student.erased');
  });
});

describe('colleges', () => {
  it('creates a college; slug is unique; validation', async () => {
    const r = await api().post('/api/v1/colleges').set(auth(S.owner)).send({ name: 'Delta Institute', city: 'Pune', state: 'Maharashtra', type: 'institute', requiredDocuments: [{ type: 'marksheet', label: '12th marksheet', mandatory: true }] });
    expect(r.status).toBe(201);
    expect(r.body.slug).toBe('delta-institute-pune');
    S.collegeId = r.body._id;
    expect((await api().post('/api/v1/colleges').set(auth(S.owner)).send({ name: 'Delta Institute', city: 'Pune' })).status).toBe(409);
    expect((await api().post('/api/v1/colleges').set(auth(S.owner)).send({ name: 'X' })).status).toBe(400);
    expect((await api().post('/api/v1/colleges').set(auth(S.owner)).send({ name: 'Bad Site', website: 'nope' })).status).toBe(400);
  });

  it('courses: create, duplicate 409, bad fee 400, update, deactivate', async () => {
    const body = { name: 'MBA', level: 'pg', annualFeePaise: 150000000, durationMonths: 24, intakes: [{ month: 8, year: 2099, deadline: '2099-06-01' }], eligibility: { minPercentage: 50 } };
    const r = await api().post(`/api/v1/colleges/${S.collegeId}/courses`).set(auth(S.owner)).send(body);
    expect(r.status).toBe(201);
    S.courseId = r.body._id;
    expect((await api().post(`/api/v1/colleges/${S.collegeId}/courses`).set(auth(S.owner)).send(body)).status).toBe(409);
    expect((await api().post(`/api/v1/colleges/${S.collegeId}/courses`).set(auth(S.owner)).send({ ...body, name: 'BBA', annualFeePaise: 1.5 })).status).toBe(400);
    expect((await api().post(`/api/v1/colleges/${'a'.repeat(24)}/courses`).set(auth(S.owner)).send(body)).status).toBe(404);
    const u = await api().patch(`/api/v1/colleges/${S.collegeId}/courses/${S.courseId}`).set(auth(S.owner)).send({ annualFeePaise: 140000000 });
    expect(u.body.annualFeePaise).toBe(140000000);
    await api().post(`/api/v1/colleges/${S.collegeId}/courses`).set(auth(S.owner)).send({ ...body, name: 'Old Course' }).then(async (c) => {
      const d = await api().delete(`/api/v1/colleges/${S.collegeId}/courses/${c.body._id}`).set(auth(S.owner));
      expect(d.body.active).toBe(false);
    });
    const detail = (await api().get(`/api/v1/colleges/${S.collegeId}`).set(auth(S.owner))).body;
    expect(detail.courses).toHaveLength(2);
  });

  it('filters by city, type, level, course name and fee range', async () => {
    const q = async (s: string) => (await api().get(`/api/v1/colleges?${s}`).set(auth(S.owner))).body.total as number;
    expect(await q('city=pune')).toBe(1);
    expect(await q('city=delhi')).toBe(0);
    expect(await q('type=institute')).toBe(1);
    expect(await q('type=university')).toBe(0);
    expect(await q('level=pg&course=mba')).toBe(1);
    expect(await q('level=ug')).toBe(0);
    expect(await q('feeMinPaise=100000000&feeMaxPaise=200000000')).toBe(1);
    expect(await q('feeMaxPaise=1000')).toBe(0);
    expect(await q('intakeYear=2099')).toBe(1);
  });

  it('bulk import validates per row, upserts by slug and is idempotent', async () => {
    const rows = [
      { name: 'Gamma University', city: 'Delhi', state: 'Delhi', type: 'university', courseName: 'B.Tech CS', level: 'ug', annualFeeRupees: 180000 },
      { name: 'Delta Institute', city: 'Pune', courseName: 'BBA', level: 'ug', annualFeeRupees: '90,000' },
      { city: 'Nowhere' },
      { name: 'Broken Fee', city: 'Pune', courseName: 'MCA', level: 'pg' },
    ];
    const r1 = await api().post('/api/v1/colleges/import').set(auth(S.owner)).send({ rows });
    expect(r1.status).toBe(200);
    expect(r1.body).toMatchObject({ total: 4, collegesCreated: 1, collegesUpdated: 1, coursesCreated: 2 });
    expect(r1.body.invalid.map((x: any) => x.row)).toEqual([3, 4]);
    const r2 = await api().post('/api/v1/colleges/import').set(auth(S.owner)).send({ rows: rows.slice(0, 2) });
    expect(r2.body).toMatchObject({ collegesCreated: 0, collegesUpdated: 2, coursesCreated: 0, coursesUpdated: 2 });
    expect((await api().post('/api/v1/colleges/import').set(auth(S.owner)).send({ rows: [] })).status).toBe(400);
    expect((await api().post('/api/v1/colleges/import').set(auth(S.counsellor)).send({ rows })).status).toBe(403);
  });

  it('shortlist ranks eligible courses', async () => {
    const r = await api().post('/api/v1/colleges/shortlist').set(auth(S.owner)).send({ percentage: 70, level: 'pg', budgetMaxPaise: 200000000, cities: ['Pune'] });
    expect(r.status).toBe(200);
    expect(r.body.items.map((m: any) => m.courseName)).toEqual(['MBA']);
    const none = await api().post('/api/v1/colleges/shortlist').set(auth(S.owner)).send({ percentage: 40, level: 'pg' });
    expect(none.body.total).toBe(0);
    expect((await api().post('/api/v1/colleges/shortlist').set(auth(S.owner)).send({ percentage: 120, level: 'pg' })).status).toBe(400);
    // counsellors may shortlist (colleges:read)
    expect((await api().post('/api/v1/colleges/shortlist').set(auth(S.counsellor)).send({ percentage: 70, level: 'ug' })).status).toBe(200);
  });

  it('deactivated colleges drop out of the shortlist; other organisations see nothing; audit rows exist', async () => {
    await api().delete(`/api/v1/colleges/${S.collegeId}`).set(auth(S.owner));
    const r = await api().post('/api/v1/colleges/shortlist').set(auth(S.owner)).send({ percentage: 70, level: 'pg' });
    expect(r.body.total).toBe(0);
    expect((await api().get('/api/v1/colleges').set(auth(S.ownerB))).body.total).toBe(0);
    expect((await api().get(`/api/v1/colleges/${S.collegeId}`).set(auth(S.ownerB))).status).toBe(404);
    const audit = (await api().get('/api/v1/audit?limit=100').set(auth(S.owner))).body.items.map((a: any) => a.action);
    expect(audit).toEqual(expect.arrayContaining(['college.created', 'course.created', 'college.imported', 'college.deactivated']));
  });

  it('public API: getRequiredDocuments falls back to the college list', async () => {
    const { getRequiredDocuments, getCourse } = await import('../../src/product/modules/colleges/index.js');
    const docs = await getRequiredDocuments(S.tenant, S.collegeId, S.courseId);
    expect(docs).toEqual([{ type: 'marksheet', label: '12th marksheet', mandatory: true }]);
    expect((await getCourse(S.tenant, S.courseId))?.name).toBe('MBA');
  });
});
