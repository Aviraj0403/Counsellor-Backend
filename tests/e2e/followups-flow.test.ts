import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/** Follow-ups (tasks + timeline) and the lead import, as one story. Steps share state and run in order. */
let mongod: MongoMemoryServer;
let app: import('express').Express;

const PW = 'Str0ng-Passw0rd!';
const api = () => request(app);
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const login = async (email: string) => (await api().post('/api/v1/auth/login').send({ email, password: PW })).body.token as string;

const S = {
  superToken: '', tenantA: '', tenantB: '',
  owner: '', ownerB: '', counsellorId: '', counsellor: '', counsellor2Id: '', counsellor2: '', marketing: '',
  lead: '', leadOther: '', taskId: '', counsellorTaskId: '',
};

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri(), { dbName: 'cp_master' });
  const { hashPassword } = await import('../../src/core/modules/identity/infrastructure/security.js');
  const { User } = await import('../../src/core/modules/identity/infrastructure/user.model.js');
  app = (await import('../../src/app/app.js')).buildApp();
  await User.create({ email: 'super@platform.test', name: 'Super', passwordHash: await hashPassword(PW), role: 'superadmin', tenantId: null });
  S.superToken = await login('super@platform.test');
  const mk = (name: string, slug: string, email: string) =>
    api().post('/api/v1/platform/tenants').set(auth(S.superToken)).send({ name, slug, ownerName: 'Owner', ownerEmail: email, ownerPassword: PW });
  S.tenantA = (await mk('Alpha', 'alpha', 'owner@alpha.test')).body.tenantId;
  S.tenantB = (await mk('Beta', 'beta', 'owner@beta.test')).body.tenantId;
  S.owner = await login('owner@alpha.test');
  S.ownerB = await login('owner@beta.test');
  const add = (name: string, email: string, role: string) => api().post('/api/v1/team').set(auth(S.owner)).send({ name, email, password: PW, role });
  S.counsellorId = (await add('Asha Counsellor', 'asha@alpha.test', 'counsellor')).body.id;
  S.counsellor2Id = (await add('Ravi Counsellor', 'ravi@alpha.test', 'counsellor')).body.id;
  await add('Mohit Marketing', 'mohit@alpha.test', 'marketing');
  S.counsellor = await login('asha@alpha.test');
  S.counsellor2 = await login('ravi@alpha.test');
  S.marketing = await login('mohit@alpha.test');
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod?.stop();
});

const newLead = (token: string, phone: string, extra: object = {}) =>
  api().post('/api/v1/leads').set(auth(token)).send({ name: 'Rahul Sharma', phone, source: { channel: 'walk_in' }, consent: { given: true, source: 'walk_in' }, ...extra });

describe('1. events create timeline entries and an automatic task', () => {
  it('followups is on by default', async () => {
    const me = (await api().get('/api/v1/me').set(auth(S.owner))).body;
    expect(me.modules.followups).toBe(true);
  });

  it('lead created + assigned + stage change => system activities and a contact task', async () => {
    S.lead = (await newLead(S.owner, '9876543210')).body.lead._id;
    const assign = await api().patch(`/api/v1/leads/${S.lead}/assign`).set(auth(S.owner)).send({ assigneeId: S.counsellorId });
    expect(assign.status).toBe(200);
    // assigning the same person again must not add a second open "Contact new lead" task
    await api().patch(`/api/v1/leads/${S.lead}/assign`).set(auth(S.owner)).send({ assigneeId: S.counsellorId });
    expect((await api().patch(`/api/v1/leads/${S.lead}/stage`).set(auth(S.counsellor)).send({ stage: 'contacted' })).status).toBe(200);

    const tl = (await api().get(`/api/v1/followups/activities?entityType=lead&entityId=${S.lead}`).set(auth(S.owner))).body;
    const texts = tl.items.map((a: any) => a.summary);
    expect(texts).toContain('Lead created via walk_in');
    expect(texts).toContain('Stage changed from new to contacted');
    expect(tl.items.every((a: any) => a.kind === 'system')).toBe(true);

    const tasks = (await api().get(`/api/v1/followups/tasks?entityType=lead&entityId=${S.lead}`).set(auth(S.owner))).body;
    expect(tasks.items).toHaveLength(1);
    expect(tasks.items[0].title).toBe('Contact new lead');
    expect(tasks.items[0].assignedTo).toBe(S.counsellorId);
    const due = new Date(tasks.items[0].dueAt).getTime() - Date.now();
    expect(due).toBeGreaterThan(50 * 60 * 1000);
    expect(due).toBeLessThan(61 * 60 * 1000);
    S.counsellorTaskId = tasks.items[0]._id;
  });
});

describe('2. tasks', () => {
  it('validates input', async () => {
    const bad = await api().post('/api/v1/followups/tasks').set(auth(S.owner)).send({ entityType: 'lead', entityId: 'nope', title: 'x', dueAt: 'tomorrow-ish' });
    expect(bad.status).toBe(400);
  });

  it('creates tasks, filters by due, and the summary counts mine', async () => {
    const mkTask = (title: string, dueAt: Date) =>
      api().post('/api/v1/followups/tasks').set(auth(S.counsellor)).send({ entityType: 'lead', entityId: S.lead, title, dueAt: dueAt.toISOString() });
    const past = await mkTask('Call back (late)', new Date(Date.now() - 3 * 24 * 3600 * 1000));
    expect(past.status).toBe(201);
    expect(past.body.assignedTo).toBe(S.counsellorId); // a counsellor's task is always their own
    S.taskId = past.body._id;
    await mkTask('Next week', new Date(Date.now() + 5 * 24 * 3600 * 1000));

    const overdue = (await api().get('/api/v1/followups/tasks?mine=1&due=overdue').set(auth(S.counsellor))).body;
    expect(overdue.items.map((t: any) => t.title)).toEqual(['Call back (late)']);
    const week = (await api().get('/api/v1/followups/tasks?mine=1&due=week').set(auth(S.counsellor))).body;
    expect(week.items.map((t: any) => t.title)).toContain('Contact new lead');
    expect(week.items.map((t: any) => t.title)).not.toContain('Call back (late)');

    const sum = (await api().get('/api/v1/followups/summary').set(auth(S.counsellor))).body;
    expect(sum.open).toBe(3);
    expect(sum.overdue).toBe(1);
  });

  it('completes with an outcome, only once', async () => {
    const done = await api().post(`/api/v1/followups/tasks/${S.taskId}/complete`).set(auth(S.counsellor)).send({ outcome: 'Spoke, will visit Friday' });
    expect(done.status).toBe(200);
    expect(done.body.status).toBe('done');
    expect(done.body.outcome).toBe('Spoke, will visit Friday');
    expect((await api().post(`/api/v1/followups/tasks/${S.taskId}/complete`).set(auth(S.counsellor)).send({})).status).toBe(400);
    expect((await api().get('/api/v1/followups/summary').set(auth(S.counsellor))).body.overdue).toBe(0);
  });

  it('owner can reassign and cancel; a counsellor cannot touch another counsellor\'s task', async () => {
    expect((await api().patch(`/api/v1/followups/tasks/${S.counsellorTaskId}`).set(auth(S.counsellor2)).send({ title: 'Hijack' })).status).toBe(404);
    expect((await api().post(`/api/v1/followups/tasks/${S.counsellorTaskId}/complete`).set(auth(S.counsellor2)).send({})).status).toBe(404);
    const re = await api().patch(`/api/v1/followups/tasks/${S.counsellorTaskId}`).set(auth(S.owner)).send({ assignedTo: S.counsellor2Id });
    expect(re.body.assignedTo).toBe(S.counsellor2Id);
    const cancel = await api().patch(`/api/v1/followups/tasks/${S.counsellorTaskId}`).set(auth(S.owner)).send({ status: 'cancelled' });
    expect(cancel.body.status).toBe('cancelled');
  });

  it('counsellor sees only own tasks; owner sees all', async () => {
    const c2 = (await api().get('/api/v1/followups/tasks').set(auth(S.counsellor2))).body;
    expect(c2.total).toBe(1);
    const all = (await api().get('/api/v1/followups/tasks').set(auth(S.owner))).body;
    expect(all.total).toBe(3);
  });
});

describe('3. activities (timeline)', () => {
  it('logs a call and a note, newest first; system kind cannot be forged', async () => {
    const call = await api().post('/api/v1/followups/activities').set(auth(S.counsellor)).send({ entityType: 'lead', entityId: S.lead, kind: 'call', direction: 'out', summary: 'Called parent', outcome: 'Interested', durationSec: 120 });
    expect(call.status).toBe(201);
    await api().post('/api/v1/followups/activities').set(auth(S.counsellor)).send({ entityType: 'lead', entityId: S.lead, kind: 'note', summary: 'Wants hostel' });
    expect((await api().post('/api/v1/followups/activities').set(auth(S.counsellor)).send({ entityType: 'lead', entityId: S.lead, kind: 'system', summary: 'fake' })).status).toBe(400);
    const tl = (await api().get(`/api/v1/followups/activities?entityType=lead&entityId=${S.lead}`).set(auth(S.counsellor))).body;
    expect(tl.items[0].summary).toBe('Wants hostel');
    expect(tl.items.map((a: any) => a.kind)).toContain('call');
  });

  it('a counsellor cannot read or write the timeline of a lead that is not theirs', async () => {
    expect((await api().get(`/api/v1/followups/activities?entityType=lead&entityId=${S.lead}`).set(auth(S.counsellor2))).status).toBe(403);
    expect((await api().post('/api/v1/followups/activities').set(auth(S.counsellor2)).send({ entityType: 'lead', entityId: S.lead, kind: 'note', summary: 'peek' })).status).toBe(403);
  });
});

describe('4. permissions, module switch, isolation, audit', () => {
  it('marketing has no follow-up permission', async () => {
    expect((await api().get('/api/v1/followups/summary').set(auth(S.marketing))).status).toBe(403);
  });

  it('switching the module off blocks it (MODULE_NOT_ENABLED)', async () => {
    const off = await api().patch(`/api/v1/platform/tenants/${S.tenantB}/modules`).set(auth(S.superToken)).send({ modules: { followups: false } });
    expect(off.status).toBe(200);
    const res = await api().get('/api/v1/followups/summary').set(auth(S.ownerB));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('MODULE_NOT_ENABLED');
    expect((await api().get('/api/v1/followups/summary').set(auth(S.owner))).status).toBe(200);
  });

  it('another organisation sees none of it', async () => {
    await api().patch(`/api/v1/platform/tenants/${S.tenantB}/modules`).set(auth(S.superToken)).send({ modules: { followups: true } });
    const tasks = (await api().get('/api/v1/followups/tasks').set(auth(S.ownerB))).body;
    expect(tasks.total).toBe(0);
    const tl = (await api().get(`/api/v1/followups/activities?entityType=lead&entityId=${S.lead}`).set(auth(S.ownerB))).body;
    expect(tl.total).toBe(0);
  });

  it('writes audit rows', async () => {
    const actions = (await api().get('/api/v1/audit?limit=100').set(auth(S.owner))).body.items.map((i: any) => i.action);
    for (const a of ['followup.task_created', 'followup.task_completed', 'followup.task_updated', 'followup.activity_logged']) expect(actions).toContain(a);
  });
});

describe('5. lead import', () => {
  const imp = (token: string, body: object) => api().post('/api/v1/leads/import').set(auth(token)).send({ channel: 'import', consentGiven: true, ...body });
  const rows = [
    { name: 'Asha Verma', phone: '98111 11111', city: 'Pune' },
    { name: 'Bela Rao', phone: '9822222222', email: 'bela@x.com' },
    { name: 'Chirag', phone: '9822222222' }, // repeated in file
    { name: 'Dev', phone: '12345' }, // invalid
    { name: 'Rahul Again', phone: '9876543210' }, // already a lead
  ];

  it('needs leads:import and consent, and rejects empty or oversized files', async () => {
    expect((await imp(S.counsellor, { rows })).status).toBe(403);
    expect((await imp(S.owner, { rows, consentGiven: false })).status).toBe(400);
    expect((await imp(S.owner, { rows: [] })).status).toBe(400);
    expect((await imp(S.owner, { rows: Array.from({ length: 1001 }, () => ({ name: 'Aa', phone: '9811111111' })) })).status).toBe(400);
  });

  it('dry run reports but writes nothing', async () => {
    const r = await imp(S.marketing, { rows, dryRun: true });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ total: 5, created: 2, duplicates: 2, dryRun: true });
    expect(r.body.invalid).toEqual([{ row: 4, reason: expect.stringMatching(/Phone/) }]);
    expect((await api().get('/api/v1/leads?search=Bela').set(auth(S.owner))).body.total).toBe(0);
  });

  it('imports for real, skips duplicates, makes one audit row, emits timeline entries', async () => {
    const r = await imp(S.owner, { rows, autoAssign: true });
    expect(r.body).toMatchObject({ total: 5, created: 2, duplicates: 2, dryRun: false });
    const leads = (await api().get('/api/v1/leads?search=Bela').set(auth(S.owner))).body.items;
    expect(leads).toHaveLength(1);
    expect(leads[0].consent).toMatchObject({ given: true, source: 'import' });
    expect(leads[0].source.channel).toBe('import');
    expect(leads[0].assignedTo).toBeTruthy();
    const audit = (await api().get('/api/v1/audit?limit=100').set(auth(S.owner))).body.items.filter((i: any) => i.action === 'lead.imported');
    expect(audit).toHaveLength(1);
    const tl = (await api().get(`/api/v1/followups/activities?entityType=lead&entityId=${leads[0]._id}`).set(auth(S.owner))).body;
    expect(tl.items[0].summary).toBe('Lead created via import');
    // importing the same file again creates nothing
    const again = await imp(S.owner, { rows });
    expect(again.body).toMatchObject({ created: 0, duplicates: 4 });
  });

  it('the other organisation can import the same phone numbers', async () => {
    const r = await imp(S.ownerB, { rows });
    expect(r.body.created).toBe(3); // 9876543210 is only a lead in the first organisation
  });
});
