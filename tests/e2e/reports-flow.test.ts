import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/** Reports: exact numbers seeded through the real endpoints, permissions, range, isolation, no PII. */
let mongod: MongoMemoryServer;
let app: import('express').Express;

const PW = 'Str0ng-Passw0rd!';
const api = () => request(app);
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const login = async (email: string) => (await api().post('/api/v1/auth/login').send({ email, password: PW })).body.token as string;
const S = { super: '', tenant: '', tenantB: '', tenantOff: '', owner: '', ownerB: '', ownerOff: '', counsellor: '', counsellorId: '', marketing: '', accounts: '', collegeId: '', courseId: '', appId: '', accrualId: '' };
const REPORTS = ['funnel', 'sources', 'counsellors', 'applications', 'revenue'];
const get = (token: string, path: string) => api().get(`/api/v1/reports/${path}`).set(auth(token));

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
    const r = await api().patch(`/api/v1/platform/tenants/${t}/modules`).set(auth(S.super)).send({ modules: { students: true, colleges: true, applications: true, ledger: true, commissions: true, reports: true } });
    if (r.status !== 200) throw new Error(JSON.stringify(r.body));
  }
  S.owner = await login('owner@alpha.test');
  S.ownerB = await login('owner@beta.test');
  S.ownerOff = await login('owner@off.test');
  const add = async (name: string, email: string, role: string) => (await api().post('/api/v1/team').set(auth(S.owner)).send({ name, email, password: PW, role })).body.id as string;
  S.counsellorId = await add('Asha Counsellor', 'asha@alpha.test', 'counsellor');
  await add('Mina Marketing', 'mina@alpha.test', 'marketing');
  await add('Anil Accounts', 'anil@alpha.test', 'accounts');
  S.counsellor = await login('asha@alpha.test');
  S.marketing = await login('mina@alpha.test');
  S.accounts = await login('anil@alpha.test');

  // leads: website x2 (one admitted, one contacted), meta_ads x2 (one lost, one new)
  const lead = async (name: string, phone: string, channel: string) =>
    (await api().post('/api/v1/leads').set(auth(S.owner)).send({ name, phone, source: { channel }, consent: { given: true } })).body.lead._id as string;
  const l1 = await lead('Ravi Kumar', '9876500001', 'website');
  const l2 = await lead('Sita Devi', '9876500002', 'website');
  const l3 = await lead('Mohan Lal', '9876500003', 'meta_ads');
  await lead('Geeta Rani', '9876500004', 'meta_ads');
  const stage = async (id: string, stages: string[]) => {
    for (const s of stages) expect((await api().patch(`/api/v1/leads/${id}/stage`).set(auth(S.owner)).send({ stage: s })).status).toBe(200);
  };
  await stage(l1, ['contacted', 'qualified', 'counselling_done', 'application_started', 'admitted']);
  await stage(l2, ['contacted']);
  await stage(l3, ['lost']);

  // students, college, course, rule, two applications
  const st = async (phone: string, extra: object = {}) =>
    (await api().post('/api/v1/students').set(auth(S.owner)).send({ name: 'Ravi Kumar', phone, dob: '2000-01-01', consent: { given: true }, ...extra })).body._id as string;
  const s1 = await st('9876543210', { assignedTo: S.counsellorId });
  const s2 = await st('9876543211');
  S.collegeId = (await api().post('/api/v1/colleges').set(auth(S.owner)).send({ name: 'Delta Institute', city: 'Pune' })).body._id;
  S.courseId = (await api().post(`/api/v1/colleges/${S.collegeId}/courses`).set(auth(S.owner)).send({ name: 'MBA', level: 'pg', annualFeePaise: 150000000, durationMonths: 24, intakes: [{ month: 8, year: 2099 }] })).body._id;
  expect((await api().post('/api/v1/commissions/rules').set(auth(S.owner)).send({ collegeId: S.collegeId, mode: 'percent_of_fee', percentBps: 1000, trigger: 'fee_paid', counsellorShareBps: 4000 })).status).toBe(201);
  const mkApp = async (studentId: string) => (await api().post('/api/v1/applications').set(auth(S.owner)).send({ studentId, collegeId: S.collegeId, courseId: S.courseId, intake: { month: 8, year: 2099 } })).body._id as string;
  S.appId = await mkApp(s1);
  await mkApp(s2);
  for (const to of ['documents_pending', 'ready_to_submit', 'submitted', 'under_review', 'offered', 'accepted']) await api().post(`/api/v1/applications/${S.appId}/status`).set(auth(S.owner)).send({ to });
  expect((await api().post(`/api/v1/applications/${S.appId}/status`).set(auth(S.owner)).send({ to: 'fee_paid', feePaidPaise: 100000001 })).status).toBe(200);
  S.accrualId = (await api().get('/api/v1/commissions').set(auth(S.owner))).body.items[0]._id;
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod?.stop();
});

describe('switch and permissions', () => {
  it('module off => 403 MODULE_NOT_ENABLED on every report', async () => {
    for (const p of REPORTS) {
      const r = await get(S.ownerOff, p);
      expect(r.status).toBe(403);
      expect(r.body.error.code).toBe('MODULE_NOT_ENABLED');
    }
  });
  it('counsellor has no reports:read => 403; owner, marketing and accounts can read', async () => {
    for (const p of REPORTS) {
      expect((await get(S.counsellor, p)).status).toBe(403);
      expect((await get(S.marketing, p)).status).toBe(200);
      expect((await get(S.accounts, p)).status).toBe(200);
      expect((await get(S.owner, p)).status).toBe(200);
    }
    expect((await api().get('/api/v1/reports/funnel')).status).toBe(401);
  });
  it('validates the date range', async () => {
    expect((await get(S.owner, 'revenue?from=nope')).status).toBe(400);
    expect((await get(S.owner, 'revenue?from=2026-02-31')).status).toBe(400);
    expect((await get(S.owner, 'revenue?from=2026-12-01&to=2026-01-01')).status).toBe(400);
  });
});

describe('exact numbers', () => {
  it('funnel', async () => {
    const f = (await get(S.owner, 'funnel')).body;
    expect(f).toMatchObject({ total: 4, lost: 1, admitted: 1, conversionPct: 25 });
    expect(f.steps.map((s: any) => [s.stage, s.count, s.reached])).toEqual([
      ['new', 1, 4],
      ['contacted', 1, 2],
      ['qualified', 0, 1],
      ['counselling_done', 0, 1],
      ['application_started', 0, 1],
      ['admitted', 1, 1],
    ]);
  });
  it('sources', async () => {
    const items = (await get(S.marketing, 'sources')).body.items;
    expect(items).toEqual([
      { channel: 'meta_ads', leads: 2, contacted: 1, admitted: 0, lost: 1, conversionPct: 0, contactedPct: 50 },
      { channel: 'website', leads: 2, contacted: 2, admitted: 1, lost: 0, conversionPct: 50, contactedPct: 100 },
    ]);
  });
  it('counsellors', async () => {
    const items = (await get(S.owner, 'counsellors')).body.items;
    expect(items).toEqual(
      expect.arrayContaining([
        { counsellorId: S.counsellorId, name: 'Asha Counsellor', applications: 1, sharePct: 50 },
        { counsellorId: 'unassigned', name: 'Unassigned', applications: 1, sharePct: 50 },
      ]),
    );
    expect(items).toHaveLength(2);
  });
  it('applications by status and college', async () => {
    const a = (await get(S.owner, 'applications')).body;
    expect(a.byStatus).toEqual({
      total: 2,
      items: [
        { status: 'draft', count: 1, sharePct: 50 },
        { status: 'fee_paid', count: 1, sharePct: 50 },
      ],
    });
    expect(a.byCollege).toEqual([{ id: S.collegeId, name: 'Delta Institute', applications: 2, sharePct: 100 }]);
  });
  it('revenue, with and without a range, and after a collection', async () => {
    const all = (await get(S.accounts, 'revenue')).body;
    expect(all).toMatchObject({ accruedPaise: 10000000, collectedPaise: 0, counsellorSharePaise: 4000000, organisationSharePaise: 6000000, paidOutPaise: 0, outstandingPaise: 10000000, collectionPct: 0 });
    const inRange = (await get(S.accounts, 'revenue?from=2000-01-01&to=2999-12-31')).body;
    expect(inRange.accruedPaise).toBe(10000000);
    expect(inRange.from).toBe('2000-01-01');
    const past = (await get(S.accounts, 'revenue?from=2000-01-01&to=2000-12-31')).body;
    expect(past).toMatchObject({ accruedPaise: 0, collectedPaise: 0, outstandingPaise: 0, collectionPct: 0 });
    const future = (await get(S.accounts, 'revenue?from=2999-01-01')).body;
    expect(future.accruedPaise).toBe(0);

    expect((await api().post(`/api/v1/commissions/${S.accrualId}/collect`).set(auth(S.accounts)).send({ reference: 'CHQ-1' })).status).toBe(200);
    expect((await api().post('/api/v1/commissions/payouts').set(auth(S.accounts)).send({ counsellorId: S.counsellorId, amountPaise: 1000000, reference: 'UTR-1' })).status).toBe(201);
    const after = (await get(S.accounts, 'revenue')).body;
    expect(after).toMatchObject({ accruedPaise: 10000000, collectedPaise: 10000000, paidOutPaise: 1000000, outstandingPaise: 0, collectionPct: 100 });
    expect((await get(S.accounts, 'revenue?from=2000-01-01&to=2000-12-31')).body.collectedPaise).toBe(0);
  });
});

describe('isolation and privacy', () => {
  it('another organisation with the module on sees only its own (empty) numbers', async () => {
    expect((await get(S.ownerB, 'funnel')).body).toMatchObject({ total: 0, admitted: 0, conversionPct: 0 });
    expect((await get(S.ownerB, 'sources')).body.items).toEqual([]);
    expect((await get(S.ownerB, 'counsellors')).body.items).toEqual([]);
    expect((await get(S.ownerB, 'applications')).body.byStatus).toEqual({ total: 0, items: [] });
    expect((await get(S.ownerB, 'revenue')).body).toMatchObject({ accruedPaise: 0, collectedPaise: 0, paidOutPaise: 0, collectionPct: 0 });
  });
  it('no raw PII in any response', async () => {
    const dump = JSON.stringify(await Promise.all(REPORTS.map(async (p) => (await get(S.owner, p)).body)));
    for (const secret of ['Ravi', 'Sita', 'Mohan', 'Geeta', '9876', 'owner@alpha.test', '@alpha.test', '+91', 'Mina', 'Anil']) expect(dump).not.toContain(secret);
    expect(dump).not.toMatch(/NaN|Infinity/);
  });
});
