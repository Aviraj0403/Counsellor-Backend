import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/** Platform "Central data": superadmin-only, per-organisation databases merged on read, masked, documents metadata only, audited. */
let mongod: MongoMemoryServer;
let app: import('express').Express;
const PW = 'Str0ng-Passw0rd!';
const api = () => request(app);
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const login = async (email: string) => (await api().post('/api/v1/auth/login').send({ email, password: PW })).body.token as string;
const C = '/api/v1/platform/central';
const S = { super: '', ops: '', ownerA: '', ownerB: '', a: '', b: '', c: '', counsellorA: '', studentA: '', studentB: '' };
const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.from('SECRET-MARKSHEET-CONTENT '.repeat(10))]);
const get = (path: string, token = S.super) => api().get(`${C}${path}`).set(auth(token));

const lead = (t: string, name: string, phone: string, extra: object = {}) =>
  api().post('/api/v1/leads').set(auth(t)).send({ name, phone, source: { channel: 'website' }, consent: { given: true, source: 'web' }, ...extra });

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri(), { dbName: 'cp_master' });
  const { MemoryFileStore, setFileStore } = await import('../../src/shared/infra/fileStore.js');
  setFileStore(new MemoryFileStore());
  const { hashPassword } = await import('../../src/core/modules/identity/infrastructure/security.js');
  const { User } = await import('../../src/core/modules/identity/infrastructure/user.model.js');
  app = (await import('../../src/app/app.js')).buildApp();
  await User.create({ email: 'super@p.test', name: 'Super', passwordHash: await hashPassword(PW), role: 'superadmin', tenantId: null });
  await User.create({ email: 'ops@p.test', name: 'Ops', passwordHash: await hashPassword(PW), role: 'platform_ops', tenantId: null });
  S.super = await login('super@p.test');
  S.ops = await login('ops@p.test');
  const mk = async (name: string, slug: string, email: string) =>
    (await api().post('/api/v1/platform/tenants').set(auth(S.super)).send({ name, slug, ownerName: 'Owner', ownerEmail: email, ownerPassword: PW })).body.tenantId as string;
  S.a = await mk('Alpha Central', 'alpha-central', 'owner@alpha-c.test');
  S.b = await mk('Beta Central', 'beta-central', 'owner@beta-c.test');
  S.c = await mk('Gamma Basic', 'gamma-basic', 'owner@gamma-c.test'); // leads only: students, applications, documents stay OFF
  const on = { students: true, colleges: true, applications: true, documents: true, appointments: true };
  for (const t of [S.a, S.b]) expect((await api().patch(`/api/v1/platform/tenants/${t}/modules`).set(auth(S.super)).send({ modules: on })).status).toBe(200);
  expect((await api().patch(`/api/v1/platform/tenants/${S.a}`).set(auth(S.super)).send({ logoUrl: 'https://cdn.example.com/alpha.png' })).status).toBe(200);
  S.ownerA = await login('owner@alpha-c.test');
  S.ownerB = await login('owner@beta-c.test');
  const ownerC = await login('owner@gamma-c.test');
  S.counsellorA = (await api().post('/api/v1/team').set(auth(S.ownerA)).send({ name: 'Asha Counsellor', email: 'asha@alpha-c.test', password: PW, role: 'counsellor' })).body.id;

  // organisation A: 3 leads (one assigned), 2 students, 1 application, 2 documents
  expect((await lead(S.ownerA, 'Ravi Kumar', '9811100001', { email: 'ravi.kumar@gmail.com' })).status).toBe(201);
  expect((await lead(S.ownerA, 'Priya Singh', '9811100002')).status).toBe(201);
  expect((await lead(S.ownerA, 'Anil Mehta', '9811100003')).status).toBe(201);
  const stud = (t: string, name: string, phone: string, extra: object = {}) => api().post('/api/v1/students').set(auth(t)).send({ name, phone, dob: '2000-01-01', consent: { given: true }, ...extra });
  S.studentA = (await stud(S.ownerA, 'Ravi Kumar', '9822200001', { email: 'ravi.student@gmail.com', assignedTo: S.counsellorA })).body._id;
  expect((await stud(S.ownerA, 'Sita Rao', '9822200002')).status).toBe(201);
  const col = await api().post('/api/v1/colleges').set(auth(S.ownerA)).send({ name: 'Delta Institute', city: 'Pune' });
  const course = await api().post(`/api/v1/colleges/${col.body._id}/courses`).set(auth(S.ownerA)).send({ name: 'MBA', level: 'pg', annualFeePaise: 150000000, durationMonths: 24, intakes: [{ month: 8, year: 2099 }] });
  expect((await api().post('/api/v1/applications').set(auth(S.ownerA)).send({ studentId: S.studentA, collegeId: col.body._id, courseId: course.body._id, intake: { month: 8, year: 2099 } })).status).toBe(201);
  for (const type of ['marksheet', 'id']) {
    const r = await api().post('/api/v1/documents').query({ studentId: S.studentA, type }).set(auth(S.ownerA)).set('x-file-name', 'ravi-kumar-aadhaar.pdf').set('content-type', 'application/octet-stream').send(PDF);
    expect(r.status).toBe(201);
  }
  // organisation B: 2 leads, 1 student
  expect((await lead(S.ownerB, 'Beta Lead One', '9833300001')).status).toBe(201);
  expect((await lead(S.ownerB, 'Beta Lead Two', '9833300002', { stage: 'new' })).status).toBe(201);
  S.studentB = (await stud(S.ownerB, 'Beta Student', '9844400001')).body._id;
  // organisation C: 1 lead (its other modules are off)
  expect((await lead(ownerC, 'Gamma Lead', '9855500001')).status).toBe(201);
});

afterAll(async () => {
  const { setFileStore } = await import('../../src/shared/infra/fileStore.js');
  setFileStore(null);
  await mongoose.disconnect();
  await mongod?.stop();
});

describe('who may use it', () => {
  it('only the superadmin: platform_ops, organisation staff and anonymous callers are refused', async () => {
    for (const p of ['/summary', '/leads', '/students', '/applications', '/documents']) {
      expect((await get(p, S.ops)).status).toBe(403);
      expect((await get(p, S.ownerA)).status).toBe(403);
      expect((await api().get(`${C}${p}`)).status).toBe(401);
    }
  });
});

describe('summary', () => {
  it('counts per organisation and totals, only for modules that are on', async () => {
    const r = await get('/summary');
    expect(r.status).toBe(200);
    const by = Object.fromEntries(r.body.organisations.map((o: any) => [o.organisation.id, o]));
    expect(by[S.a]).toMatchObject({ leads: 3, students: 2, applications: { total: 1 }, documents: { total: 2, byStatus: { pending_review: 2 } }, appointmentsUpcoming: 0 });
    expect(by[S.a].organisation).toMatchObject({ name: 'Alpha Central', slug: 'alpha-central', logoUrl: 'https://cdn.example.com/alpha.png', status: 'active' });
    expect(by[S.b]).toMatchObject({ leads: 2, students: 1, applications: { total: 0 }, documents: { total: 0 } });
    // organisation C: only leads is on => the other counts are null, never queried
    expect(by[S.c]).toMatchObject({ leads: 1, students: null, applications: null, documents: null, appointmentsUpcoming: null });
    expect(r.body.totals).toMatchObject({ leads: 6, students: 3, applications: 1, documents: 2, appointmentsUpcoming: 0 });
    expect(r.body.truncated).toBe(false);
  });
});

describe('listings', () => {
  it('leads from both organisations carry organisation info; phones and emails are masked', async () => {
    const r = await get('/leads?limit=50');
    expect(r.status).toBe(200);
    expect(r.body.total).toBe(6);
    expect(r.body.items).toHaveLength(6);
    const ravi = r.body.items.find((i: any) => i.name === 'Ravi Kumar');
    expect(ravi.organisation).toEqual({ id: S.a, name: 'Alpha Central', slug: 'alpha-central', logoUrl: 'https://cdn.example.com/alpha.png', status: 'active' });
    expect(ravi.phone).toBe('+91 ••••• ••001');
    expect(ravi.email).toBe('r•••@gmail.com');
    expect(r.body.items.find((i: any) => i.name === 'Beta Lead One').organisation.id).toBe(S.b);
    const text = JSON.stringify(r.body);
    expect(text).not.toContain('9811100001');
    expect(text).not.toContain('ravi.kumar@gmail.com');
  });

  it('students and applications list across organisations with masked contact data', async () => {
    const s = await get('/students');
    expect(s.body.items.map((i: any) => i.name).sort()).toEqual(['Beta Student', 'Ravi Kumar', 'Sita Rao']);
    expect(s.body.items.find((i: any) => i.name === 'Ravi Kumar')).toMatchObject({ phone: '+91 ••••• ••001', counsellor: { id: S.counsellorA, name: 'Asha Counsellor' } });
    expect(JSON.stringify(s.body)).not.toContain('9822200001');
    const a = await get('/applications');
    expect(a.body.items).toHaveLength(1);
    expect(a.body.items[0]).toMatchObject({ studentName: 'Ravi Kumar', collegeName: 'Delta Institute', courseName: 'MBA', status: 'draft', organisation: { id: S.a } });
  });

  it('documents are metadata only: no file name, link, hash, storage key or content', async () => {
    const r = await get('/documents');
    expect(r.status).toBe(200);
    expect(r.body.items).toHaveLength(2);
    for (const d of r.body.items) {
      expect(Object.keys(d).sort()).toEqual(['applicationId', 'id', 'organisation', 'status', 'studentId', 'studentName', 'type', 'uploadedAt']);
      expect(d).toMatchObject({ status: 'pending_review', studentName: 'Ravi Kumar', studentId: S.studentA, organisation: { id: S.a } });
    }
    const text = JSON.stringify(r.body);
    for (const banned of ['fileName', 'mimeType', 'sha256', 'storageKey', 'url"', 'link', 'token', 'ravi-kumar-aadhaar', 'SECRET-MARKSHEET']) expect(text).not.toContain(banned);
    // the organisation's logo is the only URL anywhere in the answer
    expect(text.match(/https?:\/\//g)?.length ?? 0).toBe(r.body.items.length);
  });

  it('an organisation with the module switched off is never read, in listings or counts', async () => {
    // organisation C has students/applications/documents off: no rows from it, and the response says it was skipped
    for (const p of ['/students', '/applications', '/documents']) {
      const r = await get(p);
      expect(r.body.items.filter((i: any) => i.organisation.id === S.c)).toEqual([]);
      expect(r.body.organisations.skippedModuleOff).toBe(1);
    }
    const only = await get(`/students?tenantId=${S.c}`);
    expect(only.status).toBe(200);
    expect(only.body).toMatchObject({ items: [], total: 0, organisations: { read: 0 } });
    // switching a module off removes the organisation straight away
    expect((await api().patch(`/api/v1/platform/tenants/${S.b}/modules`).set(auth(S.super)).send({ modules: { documents: false } })).status).toBe(200);
    expect((await get('/documents')).body.organisations.skippedModuleOff).toBe(2);
    expect((await api().patch(`/api/v1/platform/tenants/${S.b}/modules`).set(auth(S.super)).send({ modules: { documents: true } })).status).toBe(200);
  });

  it('suspended organisations are included and flagged', async () => {
    expect((await api().patch(`/api/v1/platform/tenants/${S.b}/status`).set(auth(S.super)).send({ status: 'suspended' })).status).toBe(200);
    const r = await get(`/leads?tenantId=${S.b}`);
    expect(r.body.total).toBe(2);
    expect(r.body.items.every((i: any) => i.organisation.status === 'suspended')).toBe(true);
    expect((await api().patch(`/api/v1/platform/tenants/${S.b}/status`).set(auth(S.super)).send({ status: 'active' })).status).toBe(200);
  });
});

describe('filters', () => {
  it('by organisation, status, search (name or phone), counsellor and dates', async () => {
    expect((await get(`/leads?tenantId=${S.a}`)).body.total).toBe(3);
    expect((await get(`/leads?tenantId=${S.b}`)).body.items.every((i: any) => i.organisation.id === S.b)).toBe(true);
    expect((await get('/leads?status=new')).body.total).toBe(6);
    expect((await get('/leads?stage=contacted')).body.total).toBe(0);
    expect((await get('/leads?q=priya')).body.items.map((i: any) => i.name)).toEqual(['Priya Singh']);
    expect((await get('/leads?q=9833300002')).body.items.map((i: any) => i.name)).toEqual(['Beta Lead Two']);
    expect((await get('/students?counsellor=asha')).body.items.map((i: any) => i.name)).toEqual(['Ravi Kumar']);
    expect((await get(`/students?counsellor=${S.counsellorA}`)).body.total).toBe(1);
    expect((await get('/students?counsellor=nobody')).body.total).toBe(0);
    const today = new Date().toISOString().slice(0, 10);
    expect((await get(`/leads?createdFrom=${today}&createdTo=${today}`)).body.total).toBe(6);
    expect((await get('/leads?createdTo=2020-01-01')).body.total).toBe(0);
    // documents: the search matches the student, a status filter matches the review status
    expect((await get('/documents?q=ravi')).body.total).toBe(2);
    expect((await get('/documents?q=nobody')).body.total).toBe(0);
    expect((await get('/documents?status=verified')).body.total).toBe(0);
    expect((await get('/applications?q=ravi')).body.total).toBe(1);
    expect((await get('/applications?status=submitted')).body.total).toBe(0);
  });

  it('bad input is a 400 and an unknown organisation a 404', async () => {
    expect((await get('/leads?limit=51')).status).toBe(400);
    expect((await get('/leads?page=0')).status).toBe(400);
    expect((await get('/leads?tenantId=nope')).status).toBe(400);
    expect((await get('/leads?createdFrom=not-a-date')).status).toBe(400);
    expect((await get(`/leads?tenantId=${'a'.repeat(24)}`)).status).toBe(404);
    expect((await get('/leads?page=11&limit=50')).status).toBe(400); // deeper than 500 rows
  });
});

describe('paging across organisations', () => {
  it('walking every page gives each row once, newest first, with no gaps (more rows than the limit)', async () => {
    // top up to 30+ leads spread over the three organisations, many created within the same millisecond
    const owners = [S.ownerA, S.ownerB];
    const pending: Promise<unknown>[] = [];
    for (let i = 0; i < 24; i++) pending.push(lead(owners[i % 2]!, `Bulk Lead ${i}`, `97000000${String(i).padStart(2, '0')}`));
    await Promise.all(pending);
    const full = await get('/leads?limit=50');
    expect(full.body.total).toBe(30);
    const expected = full.body.items.map((i: any) => i.id);
    expect(new Set(expected).size).toBe(30);

    const limit = 7;
    const seen: string[] = [];
    for (let page = 1; page <= 5; page++) {
      const r = await get(`/leads?page=${page}&limit=${limit}`);
      expect(r.status).toBe(200);
      expect(r.body.total).toBe(30);
      expect(r.body.hasMore).toBe(page * limit < 30);
      seen.push(...r.body.items.map((i: any) => i.id));
    }
    expect(seen).toHaveLength(30);
    expect(new Set(seen).size).toBe(30);
    expect(seen).toEqual(expected); // same order as one big page
    const times = full.body.items.map((i: any) => new Date(i.createdAt).getTime());
    expect(times).toEqual([...times].sort((x, y) => y - x));
    expect((await get(`/leads?page=6&limit=${limit}`)).body.items).toEqual([]);
  });
});

describe('audit and secrets', () => {
  it('every central request writes a central.viewed row with the filters but not the results', async () => {
    await get('/leads?q=priya&status=new');
    await get(`/documents?tenantId=${S.a}`);
    await get('/summary');
    const rows = (await api().get('/api/v1/platform/audit?limit=100').set(auth(S.super))).body.items.filter((i: any) => i.action === 'central.viewed');
    expect(rows.length).toBeGreaterThanOrEqual(3);
    const leadsRow = rows.find((i: any) => i.meta?.resource === 'leads' && i.meta?.filters?.q === 'priya');
    expect(leadsRow.meta.filters).toMatchObject({ q: 'priya', status: 'new', page: 1, limit: 25 });
    expect(leadsRow.actorId).toBeTruthy();
    expect(rows.find((i: any) => i.meta?.resource === 'documents').tenantId).toBe(S.a);
    expect(rows.some((i: any) => i.meta?.resource === 'summary')).toBe(true);
    const text = JSON.stringify(rows);
    expect(text).not.toContain('Priya Singh');
    expect(text).not.toContain('9811100002');
  });

  it('refused callers leave no central.viewed row', async () => {
    const before = (await api().get('/api/v1/platform/audit?limit=100').set(auth(S.super))).body.items.filter((i: any) => i.action === 'central.viewed').length;
    await get('/leads', S.ops);
    const after = (await api().get('/api/v1/platform/audit?limit=100').set(auth(S.super))).body.items.filter((i: any) => i.action === 'central.viewed').length;
    expect(after).toBe(before);
  });

  it('no response carries a secret', async () => {
    const text = JSON.stringify([(await get('/summary')).body, (await get('/leads?limit=50')).body, (await get('/students')).body, (await get('/applications')).body, (await get('/documents')).body]);
    for (const banned of ['passwordHash', 'password', 'secret', 'SECRET', 'storageKey', 'sha256', 'manageToken', 'apiKey', 'accessToken', 'mfa']) expect(text).not.toContain(banned);
  });
});
