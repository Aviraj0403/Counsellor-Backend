import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/** Applications + commissions: status machine, guards, scope, isolation, audit, events, accrual -> ledger -> payout/collect/reverse. */
let mongod: MongoMemoryServer;
let app: import('express').Express;
let hooks: typeof import('../../src/shared/kernel/hooks.js');

const PW = 'Str0ng-Passw0rd!';
const api = () => request(app);
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const login = async (email: string) => (await api().post('/api/v1/auth/login').send({ email, password: PW })).body.token as string;
const S = { super: '', tenant: '', tenantB: '', tenantOff: '', owner: '', ownerB: '', ownerOff: '', counsellor: '', counsellorId: '', other: '', otherId: '', accounts: '', student: '', student2: '', studentB: '', collegeId: '', courseId: '', course2: '', appId: '', appId2: '', ruleId: '' };
const INTAKE = { month: 8, year: 2099 };

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri(), { dbName: 'cp_master' });
  const { hashPassword } = await import('../../src/core/modules/identity/infrastructure/security.js');
  const { User } = await import('../../src/core/modules/identity/infrastructure/user.model.js');
  hooks = await import('../../src/shared/kernel/hooks.js');
  app = (await import('../../src/app/app.js')).buildApp();
  await User.create({ email: 'super@p.test', name: 'S', passwordHash: await hashPassword(PW), role: 'superadmin', tenantId: null });
  S.super = await login('super@p.test');
  const mk = async (name: string, slug: string, email: string) =>
    (await api().post('/api/v1/platform/tenants').set(auth(S.super)).send({ name, slug, ownerName: 'Owner', ownerEmail: email, ownerPassword: PW })).body.tenantId as string;
  S.tenant = await mk('Alpha Edu', 'alpha-edu', 'owner@alpha.test');
  S.tenantB = await mk('Beta Edu', 'beta-edu', 'owner@beta.test');
  S.tenantOff = await mk('Off Edu', 'off-edu', 'owner@off.test');
  for (const t of [S.tenant, S.tenantB]) {
    const r = await api().patch(`/api/v1/platform/tenants/${t}/modules`).set(auth(S.super)).send({ modules: { students: true, colleges: true, applications: true, ledger: true, commissions: true } });
    expect(r.status).toBe(200);
  }
  S.owner = await login('owner@alpha.test');
  S.ownerB = await login('owner@beta.test');
  S.ownerOff = await login('owner@off.test');
  const add = async (name: string, email: string, role: string) => (await api().post('/api/v1/team').set(auth(S.owner)).send({ name, email, password: PW, role })).body.id as string;
  S.counsellorId = await add('Asha Counsellor', 'asha@alpha.test', 'counsellor');
  S.otherId = await add('Bina Counsellor', 'bina@alpha.test', 'counsellor');
  await add('Anil Accounts', 'anil@alpha.test', 'accounts');
  S.counsellor = await login('asha@alpha.test');
  S.other = await login('bina@alpha.test');
  S.accounts = await login('anil@alpha.test');

  const st = async (token: string, phone: string, extra: object = {}) =>
    (await api().post('/api/v1/students').set(auth(token)).send({ name: 'Ravi Kumar', phone, dob: '2000-01-01', consent: { given: true }, ...extra })).body._id as string;
  S.student = await st(S.owner, '9876543210', { assignedTo: S.counsellorId });
  S.student2 = await st(S.owner, '9876543211');
  S.studentB = await st(S.ownerB, '9876543210');
  const col = await api().post('/api/v1/colleges').set(auth(S.owner)).send({ name: 'Delta Institute', city: 'Pune' });
  S.collegeId = col.body._id;
  const course = (name: string) => api().post(`/api/v1/colleges/${S.collegeId}/courses`).set(auth(S.owner)).send({ name, level: 'pg', annualFeePaise: 150000000, durationMonths: 24, intakes: [{ month: 8, year: 2099 }] });
  S.courseId = (await course('MBA')).body._id;
  S.course2 = (await course('MCA')).body._id;
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod?.stop();
});

const create = (token: string, body: object = {}) =>
  api().post('/api/v1/applications').set(auth(token)).send({ studentId: S.student, collegeId: S.collegeId, courseId: S.courseId, intake: INTAKE, ...body });
const move = (token: string, id: string, to: string, extra: object = {}) => api().post(`/api/v1/applications/${id}/status`).set(auth(token)).send({ to, ...extra });
const auditActions = async (entityId: string) => (await api().get(`/api/v1/audit?entityId=${entityId}`).set(auth(S.owner))).body.items.map((a: any) => a.action);

describe('module switch, permissions, validation', () => {
  it('module off => 403 MODULE_NOT_ENABLED for both', async () => {
    for (const p of ['/applications', '/commissions']) {
      const r = await api().get(`/api/v1${p}`).set(auth(S.ownerOff));
      expect(r.status).toBe(403);
      expect(r.body.error.code).toBe('MODULE_NOT_ENABLED');
    }
  });
  it('accounts can read applications but not create or move them; counsellor cannot manage commissions', async () => {
    expect((await api().get('/api/v1/applications').set(auth(S.accounts))).status).toBe(200);
    expect((await create(S.accounts)).status).toBe(403);
    expect((await api().post('/api/v1/commissions/rules').set(auth(S.counsellor)).send({})).status).toBe(403);
    expect((await api().post('/api/v1/commissions/payouts').set(auth(S.counsellor)).send({})).status).toBe(403);
  });
  it('validates student, college, course and course/college match', async () => {
    expect((await create(S.owner, { studentId: 'a'.repeat(24) })).status).toBe(404);
    expect((await create(S.owner, { collegeId: 'a'.repeat(24) })).status).toBe(404);
    expect((await create(S.owner, { courseId: 'a'.repeat(24) })).status).toBe(400);
    expect((await create(S.owner, { intake: { month: 13, year: 2099 } })).status).toBe(400);
    expect((await create(S.owner, { studentId: 'bad' })).status).toBe(400);
  });
});

describe('applications', () => {
  it('creates a draft once; duplicate student+course+intake is 409; another intake is fine', async () => {
    const r = await create(S.owner);
    expect(r.status).toBe(201);
    expect(r.body.status).toBe('draft');
    expect(r.body.assignedTo).toBe(S.counsellorId); // inherited from the student
    S.appId = r.body._id;
    expect((await create(S.owner)).status).toBe(409);
    expect((await create(S.owner, { intake: { month: 1, year: 2100 } })).status).toBe(201);
  });

  it('status machine: illegal jumps are 409, legal steps work and are recorded', async () => {
    const bad = await move(S.owner, S.appId, 'submitted');
    expect(bad.status).toBe(409);
    expect(bad.body.error.code).toBe('ILLEGAL_TRANSITION');
    expect((await move(S.owner, S.appId, 'admitted')).status).toBe(409);
    for (const to of ['documents_pending', 'ready_to_submit']) expect((await move(S.owner, S.appId, to, { note: 'ok' })).status).toBe(200);
    const d = await api().get(`/api/v1/applications/${S.appId}`).set(auth(S.owner));
    expect(d.body.status).toBe('ready_to_submit');
    expect(d.body.allowedNext).toEqual(['submitted', 'withdrawn']);
    expect(d.body.statusHistory.map((h: any) => h.to)).toEqual(['draft', 'documents_pending', 'ready_to_submit']);
    expect(d.body.studentName).toBe('Ravi Kumar');
    expect(d.body.collegeName).toBe('Delta Institute');
    expect((await move(S.owner, S.appId, 'nonsense')).status).toBe(400);
  });

  it('a registered guard blocks the change with 409 STATUS_BLOCKED and a plain reason', async () => {
    hooks.registerGuard('application.beforeStatusChange', ({ to }) => (to === 'submitted' ? 'Mandatory documents are missing.' : null));
    const r = await move(S.owner, S.appId, 'submitted');
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('STATUS_BLOCKED');
    expect(r.body.error.message).toContain('Mandatory documents are missing.');
    expect((await api().get(`/api/v1/applications/${S.appId}`).set(auth(S.owner))).body.status).toBe('ready_to_submit');
    hooks.clearHooks();
    expect((await move(S.owner, S.appId, 'submitted')).status).toBe(200);
  });

  it('fee paid can only be recorded from accepted; fee/offer edit works', async () => {
    await move(S.owner, S.appId, 'under_review');
    expect((await move(S.owner, S.appId, 'offered', { feePaidPaise: 100 })).status).toBe(400);
    expect((await move(S.owner, S.appId, 'offered')).status).toBe(200);
    const p = await api().patch(`/api/v1/applications/${S.appId}`).set(auth(S.owner)).send({ collegeRef: 'REF-1', notes: 'call back', fee: { tuitionPaise: 150000000 }, offer: { scholarshipPaise: 500000, deadline: '2099-05-01', note: 'merit' } });
    expect(p.status).toBe(200);
    expect(p.body.fee.tuitionPaise).toBe(150000000);
    expect(p.body.offer.scholarshipPaise).toBe(500000);
    expect(p.body.collegeRef).toBe('REF-1');
  });

  it('counsellor data scope: sees only own applications', async () => {
    expect((await api().get('/api/v1/applications').set(auth(S.counsellor))).body.total).toBe(2);
    expect((await api().get('/api/v1/applications').set(auth(S.other))).body.total).toBe(0);
    expect((await api().get(`/api/v1/applications/${S.appId}`).set(auth(S.other))).status).toBe(404);
    expect((await move(S.other, S.appId, 'withdrawn')).status).toBe(404);
    expect((await api().patch(`/api/v1/applications/${S.appId}`).set(auth(S.other)).send({ notes: 'x' })).status).toBe(404);
    expect((await create(S.other, { studentId: S.student2, collegeId: S.collegeId })).status).toBe(404); // not their student
  });

  it('filters work; organisations are isolated', async () => {
    expect((await api().get(`/api/v1/applications?status=offered`).set(auth(S.owner))).body.total).toBe(1);
    expect((await api().get(`/api/v1/applications?studentId=${S.student}&collegeId=${S.collegeId}`).set(auth(S.owner))).body.total).toBe(2);
    expect((await api().get('/api/v1/applications').set(auth(S.ownerB))).body.total).toBe(0);
    expect((await api().get(`/api/v1/applications/${S.appId}`).set(auth(S.ownerB))).status).toBe(404);
    expect((await create(S.ownerB)).status).toBe(404);
  });

  it('audit rows exist; public counts work', async () => {
    expect(await auditActions(S.appId)).toEqual(expect.arrayContaining(['application.created', 'application.status_changed', 'application.updated']));
    const mod = await import('../../src/product/modules/applications/index.js');
    expect(await mod.applicationCountsByStatus(S.tenant)).toMatchObject({ offered: 1, draft: 1 });
    expect(await mod.applicationCountsByCollege(S.tenant)).toEqual({ [S.collegeId]: 2 });
    expect((await mod.applicationCountsByCounsellor(S.tenant))[S.counsellorId]).toBe(2);
    expect((await mod.getApplication(S.tenant, S.appId))?.status).toBe('offered');
    expect(await mod.listApplicationsForStudent(S.tenant, S.student)).toHaveLength(2);
    expect(await mod.listApplicationsForCollege(S.tenant, S.collegeId, { status: 'offered' })).toHaveLength(1);
    expect(await mod.getApplication(S.tenant, 'nope')).toBeNull();
  });

  it('events: application.created and status_changed are published', async () => {
    const ev = await import('../../src/shared/kernel/events.js');
    const seen: string[] = [];
    ev.subscribe('application.created', (p) => void seen.push('created:' + p.applicationId));
    ev.subscribe('application.status_changed', (p) => void seen.push(`${p.from}>${p.to}`));
    const r = await create(S.owner, { studentId: S.student2, intake: { month: 2, year: 2099 } });
    expect(r.status).toBe(201);
    await move(S.owner, r.body._id, 'documents_pending');
    expect(seen).toEqual([`created:${r.body._id}`, 'draft>documents_pending']);
  });
});

describe('commissions: rules', () => {
  it('rules CRUD with validation and one rule per college', async () => {
    const base = { collegeId: S.collegeId, mode: 'percent_of_fee', percentBps: 1000, trigger: 'fee_paid', counsellorShareBps: 4000 };
    expect((await api().post('/api/v1/commissions/rules').set(auth(S.owner)).send({ ...base, percentBps: undefined })).status).toBe(400);
    expect((await api().post('/api/v1/commissions/rules').set(auth(S.owner)).send({ ...base, collegeId: 'a'.repeat(24) })).status).toBe(404);
    const r = await api().post('/api/v1/commissions/rules').set(auth(S.owner)).send(base);
    expect(r.status).toBe(201);
    S.ruleId = r.body._id;
    expect((await api().post('/api/v1/commissions/rules').set(auth(S.owner)).send(base)).status).toBe(409);
    const list = await api().get('/api/v1/commissions/rules').set(auth(S.accounts));
    expect(list.body[0].collegeName).toBe('Delta Institute');
    expect((await api().patch(`/api/v1/commissions/rules/${S.ruleId}`).set(auth(S.owner)).send({ counsellorShareBps: 5000 })).body.counsellorShareBps).toBe(5000);
    expect((await api().get('/api/v1/commissions/rules').set(auth(S.ownerB))).body).toEqual([]);
  });
});

describe('commissions: accrual through the event bus', () => {
  it('accrues only at the trigger status (fee_paid), exactly once, with a balanced ledger', async () => {
    // appId is 'offered' (no accrual so far)
    expect((await api().get('/api/v1/commissions').set(auth(S.owner))).body.total).toBe(0);
    expect((await move(S.owner, S.appId, 'accepted', { feePaidPaise: 1000 })).status).toBe(200); // not the trigger
    expect((await api().get('/api/v1/commissions').set(auth(S.owner))).body.total).toBe(0);
    expect((await move(S.owner, S.appId, 'fee_paid', { feePaidPaise: 100000001 })).status).toBe(200); // 10% of 1,000,000.01 rupees
    const list = (await api().get('/api/v1/commissions').set(auth(S.owner))).body;
    expect(list.total).toBe(1);
    const a = list.items[0];
    expect(a).toMatchObject({ applicationId: S.appId, status: 'accrued', totalPaise: 10000000, counsellorSharePaise: 5000000, organisationSharePaise: 5000000, counsellorId: S.counsellorId, collegeName: 'Delta Institute', counsellorName: 'Asha Counsellor' });
    // admitted afterwards is not the trigger and a replay of the event must not double count
    expect((await move(S.owner, S.appId, 'admitted')).status).toBe(200);
    const mod = await import('../../src/product/modules/commissions/application/commission.service.js');
    expect(await mod.accrueForApplication(S.tenant, S.appId, 'fee_paid')).toBe(false);
    expect((await api().get('/api/v1/commissions').set(auth(S.owner))).body.total).toBe(1);

    const tb = (await api().get('/api/v1/ledger/trial-balance').set(auth(S.owner))).body;
    expect(tb.isBalanced).toBe(true);
    const net = (acc: string) => tb.accounts.find((x: any) => x.account === acc)?.netPaise;
    expect(net(`college:${S.collegeId}`)).toBe(10000000);
    expect(net(`counsellor:${S.counsellorId}`)).toBe(-5000000);
    expect(net('platform:commission_income')).toBe(-5000000);
    expect(await auditActions(a._id)).toContain('commission.accrued');
    S.appId2 = a._id; // accrual id from here on
  });

  it('mode none and a college without rule accrue nothing', async () => {
    const mod = await import('../../src/product/modules/commissions/application/commission.service.js');
    expect(await mod.accrueForApplication(S.tenant, S.appId2, 'admitted')).toBe(false); // wrong id: not an application
    await api().patch(`/api/v1/commissions/rules/${S.ruleId}`).set(auth(S.owner)).send({ mode: 'none' });
    const r = await create(S.owner, { courseId: S.course2 });
    for (const to of ['documents_pending', 'ready_to_submit', 'submitted', 'under_review', 'offered', 'accepted']) await move(S.owner, r.body._id, to);
    await move(S.owner, r.body._id, 'fee_paid', { feePaidPaise: 5000000 });
    expect((await api().get('/api/v1/commissions').set(auth(S.owner))).body.total).toBe(1);
    await api().patch(`/api/v1/commissions/rules/${S.ruleId}`).set(auth(S.owner)).send({ mode: 'percent_of_fee' });
  });
});

describe('commissions: summary, payout, collect, reverse', () => {
  it('summary per counsellor; counsellor role has no access', async () => {
    const s = (await api().get('/api/v1/commissions/summary').set(auth(S.owner))).body.items;
    expect(s).toEqual([expect.objectContaining({ counsellorId: S.counsellorId, accruedPaise: 5000000, paidPaise: 0, payablePaise: 5000000 })]);
    expect((await api().get('/api/v1/commissions/summary').set(auth(S.counsellor))).status).toBe(403); // counsellor role has no commissions:read
    
    
  });

  it('payout cannot exceed payable; partial payouts reduce payable; same reference replays', async () => {
    const pay = (amountPaise: number, reference: string) => api().post('/api/v1/commissions/payouts').set(auth(S.accounts)).send({ counsellorId: S.counsellorId, amountPaise, reference });
    expect((await pay(5000001, 'UTR-X')).status).toBe(409);
    expect((await pay(0, 'UTR-X')).status).toBe(400);
    expect((await pay(2000000, 'UTR-1')).status).toBe(201);
    const again = await pay(2000000, 'UTR-1');
    expect(again.body.replayed).toBe(true);
    expect((await pay(3000001, 'UTR-2')).status).toBe(409);
    const s = (await api().get('/api/v1/commissions/summary').set(auth(S.owner))).body.items[0];
    expect(s).toMatchObject({ paidPaise: 2000000, payablePaise: 3000000 });
    expect((await api().get('/api/v1/ledger/trial-balance').set(auth(S.owner))).body.isBalanced).toBe(true);
  });

  it('collect once (college paid us); then reverse is blocked while the counsellor was paid, allowed otherwise', async () => {
    const id = S.appId2;
    expect((await api().post(`/api/v1/commissions/${id}/collect`).set(auth(S.accounts)).send({ reference: 'CHQ-1' })).body.status).toBe('collected');
    expect((await api().post(`/api/v1/commissions/${id}/collect`).set(auth(S.accounts)).send({ reference: 'CHQ-1' })).status).toBe(409);
    let tb = (await api().get('/api/v1/ledger/trial-balance').set(auth(S.owner))).body;
    expect(tb.accounts.find((x: any) => x.account === `college:${S.collegeId}`)?.netPaise).toBe(0);
    expect(tb.accounts.find((x: any) => x.account === 'bank:main')?.netPaise).toBe(10000000 - 2000000);
    expect((await api().post(`/api/v1/commissions/${id}/reverse`).set(auth(S.accounts)).send({ reason: 'college refund' })).status).toBe(409);
    // pay back is not modelled: pay the remainder out is impossible to undo, so reverse only works with enough payable. Check a 404 and validation.
    expect((await api().post(`/api/v1/commissions/${'a'.repeat(24)}/reverse`).set(auth(S.accounts)).send({ reason: 'college refund' })).status).toBe(404);
    expect((await api().post(`/api/v1/commissions/${id}/reverse`).set(auth(S.accounts)).send({ reason: 'x' })).status).toBe(400);
    tb = (await api().get('/api/v1/ledger/trial-balance').set(auth(S.owner))).body;
    expect(tb.isBalanced).toBe(true);
  });

  it('reverse an unpaid accrual: ledger reversed, balances back to zero, only once', async () => {
    // second application on another course, accrued, nobody paid
    const sa = await create(S.owner, { studentId: S.student2, courseId: S.course2, assignedTo: S.otherId });
    for (const to of ['documents_pending', 'ready_to_submit', 'submitted', 'under_review', 'offered', 'accepted']) await move(S.owner, sa.body._id, to);
    await move(S.owner, sa.body._id, 'fee_paid', { feePaidPaise: 2000000 });
    const acc = (await api().get(`/api/v1/commissions?counsellorId=${S.otherId}`).set(auth(S.owner))).body.items[0];
    expect(acc.totalPaise).toBe(200000);
    expect((await api().post(`/api/v1/commissions/${acc._id}/reverse`).set(auth(S.accounts)).send({ reason: 'student left' })).body.status).toBe('reversed');
    expect((await api().post(`/api/v1/commissions/${acc._id}/reverse`).set(auth(S.accounts)).send({ reason: 'student left' })).status).toBe(409);
    expect((await api().post(`/api/v1/commissions/${acc._id}/collect`).set(auth(S.accounts)).send({ reference: 'CHQ-9' })).status).toBe(409);
    const tb = (await api().get('/api/v1/ledger/trial-balance').set(auth(S.owner))).body;
    expect(tb.isBalanced).toBe(true);
    expect(tb.accounts.find((x: any) => x.account === `counsellor:${S.otherId}`)?.netPaise ?? 0).toBe(0);
    expect(await auditActions(acc._id)).toEqual(expect.arrayContaining(['commission.accrued', 'commission.reversed']));
    const mod = await import('../../src/product/modules/commissions/index.js');
    const t = await mod.commissionTotals(S.tenant);
    expect(t).toMatchObject({ accruedPaise: 10000000, collectedPaise: 10000000, counsellorSharePaise: 5000000, organisationSharePaise: 5000000, paidOutPaise: 2000000 });
  });

  it('organisation isolation: commissions of one organisation are invisible to another', async () => {
    expect((await api().get('/api/v1/commissions').set(auth(S.ownerB))).body.total).toBe(0);
    expect((await api().post(`/api/v1/commissions/${S.appId2}/collect`).set(auth(S.ownerB)).send({ reference: 'CHQ-2' })).status).toBe(404);
  });
});

describe('erasure hook', () => {
  it('student.erased clears free text on applications', async () => {
    const { publish } = await import('../../src/shared/kernel/events.js');
    await publish('student.erased', { tenantId: S.tenant, studentId: S.student });
    const d = await api().get(`/api/v1/applications/${S.appId}`).set(auth(S.owner));
    expect(d.body.notes).toBeUndefined();
    expect(d.body.collegeRef).toBeUndefined();
  });
});
