import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/** Platform staff workspace: configuration and health of ONE organisation, never its people or records. */
let mongod: MongoMemoryServer;
let app: import('express').Express;
const PW = 'Str0ng-Passw0rd!';
const api = () => request(app);
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const login = async (email: string) => (await api().post('/api/v1/auth/login').send({ email, password: PW })).body.token as string;
const ws = (token: string, id: string) => api().get(`/api/v1/platform/tenants/${id}/workspace`).set(auth(token));
const mod = (body: any, key: string) => body.modules.find((m: any) => m.key === key);

const S = { super: '', a: '', b: '', ownerA: '', ownerB: '', apiKey: '' };
const SECRETS: string[] = [];

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri(), { dbName: 'cp_master' });
  const { hashPassword } = await import('../../src/core/modules/identity/infrastructure/security.js');
  const { User } = await import('../../src/core/modules/identity/infrastructure/user.model.js');
  app = (await import('../../src/app/app.js')).buildApp();
  const { setLlmClient } = await import('../../src/product/modules/bots/infrastructure/llm.js');
  setLlmClient(null); // deterministic: no AI key

  await User.create({ email: 'super@p.test', name: 'Super', passwordHash: await hashPassword(PW), role: 'superadmin', tenantId: null });
  S.super = await login('super@p.test');
  const mk = async (name: string, slug: string, email: string) =>
    (await api().post('/api/v1/platform/tenants').set(auth(S.super)).send({ name, slug, ownerName: 'Owner Person', ownerEmail: email, ownerPassword: PW })).body.tenantId as string;
  S.a = await mk('Alpha Workspace', 'alpha-ws', 'owner@alpha-ws.test');
  S.b = await mk('Beta Workspace', 'beta-ws', 'owner@beta-ws.test');
  const on = { students: true, colleges: true, applications: true, ledger: true, commissions: true, whatsapp: true, publicApi: true, seoPages: true, appointments: true, aiBot: true, documents: true, studentPortal: true, metaAds: true };
  expect((await api().patch(`/api/v1/platform/tenants/${S.a}/modules`).set(auth(S.super)).send({ modules: on })).status).toBe(200);
  expect((await api().patch(`/api/v1/platform/tenants/${S.b}/modules`).set(auth(S.super)).send({ modules: { colleges: true } })).status).toBe(200);
  S.ownerA = await login('owner@alpha-ws.test');
  S.ownerB = await login('owner@beta-ws.test');

  // organisation A: a few records. Their values must NEVER appear in the platform view.
  const lead = await api().post('/api/v1/leads').set(auth(S.ownerA)).send({ name: 'Zorbatron Quillfeather', phone: '9811122233', email: 'zorba.q@secret-mail.test', source: { channel: 'website' }, consent: { given: true, source: 'web' } });
  expect(lead.status).toBe(201);
  const college = await api().post('/api/v1/colleges').set(auth(S.ownerA)).send({ name: 'Zeta Hidden College', city: 'Pune', state: 'Maharashtra', description: 'desc' });
  expect(college.status).toBe(201);
  const collegeId = college.body._id as string;
  const course = await api().post(`/api/v1/colleges/${collegeId}/courses`).set(auth(S.ownerA)).send({ name: 'B.Tech Zeta', level: 'ug', annualFeePaise: 10000000, durationYears: 4 });
  expect([200, 201]).toContain(course.status);
  const key = await api().post('/api/v1/integrations/api/keys').set(auth(S.ownerA)).send({ name: 'Website key', scopes: ['leads:create'] });
  expect(key.status).toBe(201);
  S.apiKey = key.body.apiKey;
  const hook = await api().post('/api/v1/integrations/api/webhooks').set(auth(S.ownerA)).send({ url: 'https://hooks.alpha-ws.example/in', events: ['lead.created'] });
  expect(hook.status).toBe(201);
  expect((await api().post('/api/v1/whatsapp/templates').set(auth(S.ownerA)).send({ name: 'welcome_msg', language: 'en', body: 'Hello {{1}}' })).status).toBe(201);
  expect((await api().post('/api/v1/commissions/rules').set(auth(S.ownerA)).send({ collegeId, mode: 'flat', flatPaise: 500000, trigger: 'admitted' })).status).toBe(201);
  expect((await api().put('/api/v1/seo/settings').set(auth(S.ownerA)).send({ orgSlug: 'alpha-ws', contact: { phone: '9822233344', email: 'seo-contact@secret-mail.test' } })).status).toBe(200);
  await api().post('/api/v1/team').set(auth(S.ownerA)).send({ name: 'Hidden Counsellor', email: 'hidden.c@alpha-ws.test', password: PW, role: 'counsellor' });

  SECRETS.push('Zorbatron', 'Quillfeather', '9811122233', 'zorba.q@secret-mail.test', 'Zeta Hidden College', 'B.Tech Zeta', S.apiKey, 'hooks.alpha-ws.example', '9822233344', 'seo-contact@secret-mail.test', 'owner@alpha-ws.test', 'Owner Person', 'Hidden Counsellor', 'hidden.c@alpha-ws.test', 'welcome_msg', 'Website key', PW);
});

afterAll(async () => {
  const { resetLlmClient } = await import('../../src/product/modules/bots/infrastructure/llm.js');
  resetLlmClient();
  await mongoose.disconnect();
  await mongod?.stop();
});

describe('who may open the workspace', () => {
  it('platform staff: 200. tenant user: 403. no login: 401. unknown or malformed id: 404', async () => {
    expect((await ws(S.super, S.a)).status).toBe(200);
    expect((await ws(S.ownerA, S.a)).status).toBe(403);
    expect((await api().get(`/api/v1/platform/tenants/${S.a}/workspace`)).status).toBe(401);
    expect((await ws(S.super, '64b7f0f0f0f0f0f0f0f0f0f0')).status).toBe(404);
    expect((await ws(S.super, 'not-an-id')).status).toBe(404);
  });
});

describe('identity, modules and config of an organisation', () => {
  it('shows identity, plan, team counts and the module list', async () => {
    const { body } = await ws(S.super, S.a);
    expect(body.organisation).toMatchObject({ id: S.a, name: 'Alpha Workspace', slug: 'alpha-ws', status: 'active' });
    expect(body.plan).toHaveProperty('monthlySubtotalPaise');
    expect(body.team.active).toBe(2); // owner + counsellor
    expect(body.team.byRole.reduce((n: number, r: any) => n + r.count, 0)).toBe(2);
    expect(body.modules.length).toBeGreaterThanOrEqual(18);
    const ledger = mod(body, 'ledger');
    expect(ledger).toMatchObject({ enabled: true, group: 'finance', priceMonthlyInr: 999 });
  });

  it('counts and flags are correct for enabled modules', async () => {
    const { body } = await ws(S.super, S.a);
    const items = (key: string) => Object.fromEntries(mod(body, key).config.items.map((i: any) => [i.label, i.value]));
    expect(items('colleges')).toMatchObject({ 'Active colleges': 1, 'Active courses': 1 });
    expect(mod(body, 'colleges').config).toMatchObject({ configured: true, health: 'ok' });
    expect(items('publicApi')).toMatchObject({ 'Active API keys': 1, 'Active webhooks': 1 });
    expect(mod(body, 'publicApi').config.health).toBe('ok');
    expect(items('commissions')).toMatchObject({ 'Active commission rules': 1 });
    expect(items('seoPages')).toMatchObject({ 'Public address (slug) set': true });
    expect(items('whatsapp')).toMatchObject({ 'Active message templates': 1, 'WhatsApp number connected on the platform': false });
    expect(mod(body, 'whatsapp').config).toMatchObject({ health: 'attention', configured: false });
    expect(mod(body, 'whatsapp').config.nextStep).toBeTruthy();
    expect(mod(body, 'appointments').config).toMatchObject({ health: 'attention', configured: false }); // no type yet
    expect(mod(body, 'aiBot').config).toMatchObject({ health: 'attention', configured: false }); // no AI key
    expect(items('aiBot')).toMatchObject({ 'AI key set on the server': false, 'Conversations (count only)': 0 });
    expect(mod(body, 'studentPortal').config.health).toBe('attention'); // nobody invited
    expect(mod(body, 'documents').config.configured).toBe(true);
    expect(mod(body, 'team').config.health).toBe('ok');
  });

  it('metaAds reports its real setup state (not connected yet)', async () => {
    const { body } = await ws(S.super, S.a);
    expect(mod(body, 'metaAds')).toMatchObject({ enabled: true, config: { configured: false, health: 'attention' } });
  });

  it('health roll-up matches the modules', async () => {
    const { body } = await ws(S.super, S.a);
    const attention = body.modules.filter((m: any) => m.enabled && m.config?.health === 'attention').map((m: any) => m.key);
    expect(body.health.needsAttention).toBe(attention.length);
    expect(body.health.attentionKeys.sort()).toEqual(attention.sort());
    expect(body.health.overall).toBe('attention');
  });

  it('config follows reality: adding an appointment type moves it forward', async () => {
    const before = mod((await ws(S.super, S.a)).body, 'appointments').config;
    expect(before.items.find((i: any) => i.label === 'Appointment types').value).toBe(0);
    const t = await api().post('/api/v1/appointments/types').set(auth(S.ownerA)).send({ name: 'Call', mode: 'phone', durationMin: 30, publicBookable: true });
    expect(t.status).toBe(201);
    const after = mod((await ws(S.super, S.a)).body, 'appointments').config;
    expect(after.items.find((i: any) => i.label === 'Appointment types').value).toBe(1);
    expect(after.items.find((i: any) => i.label === 'Public booking on').value).toBe(true);
    expect(after.summary).toMatch(/no counsellor has working hours/i);
  });
});

describe('disabled modules and isolation', () => {
  it('a module that is off shows enabled:false and no config; a module blocked by a missing dependency says which', async () => {
    const { body } = await ws(S.super, S.b);
    const whatsapp = mod(body, 'whatsapp');
    expect(whatsapp).toMatchObject({ enabled: false, config: null });
    expect(mod(body, 'colleges')).toMatchObject({ enabled: true });
    expect(mod(body, 'applications')).toMatchObject({ enabled: false, config: null, dependsOnUnmet: ['students'] });
    expect(body.health.overall).toBe('attention'); // only colleges is on and it has no college yet
  });

  it('two organisations never see each other', async () => {
    const a = await ws(S.super, S.a);
    const b = await ws(S.super, S.b);
    expect(b.body.organisation.slug).toBe('beta-ws');
    expect(mod(b.body, 'colleges').config.items.find((i: any) => i.label === 'Active colleges').value).toBe(0);
    expect(mod(a.body, 'colleges').config.items.find((i: any) => i.label === 'Active colleges').value).toBe(1);
    expect(JSON.stringify(b.body)).not.toContain('alpha');
  });
});

describe('the hard rule: configuration and health only', () => {
  it('the JSON contains none of the personal values or secrets that were created', async () => {
    for (const id of [S.a, S.b]) {
      const text = JSON.stringify((await ws(S.super, id)).body);
      for (const s of SECRETS) expect(text, `leaked: ${s}`).not.toContain(s);
      expect(text).not.toMatch(/password|secret|token|hash|\+91|@.+\.test/i);
    }
  });

  it('toggling a module reuses the existing endpoint and the workspace follows', async () => {
    expect((await api().patch(`/api/v1/platform/tenants/${S.b}/modules`).set(auth(S.super)).send({ modules: { seoPages: true } })).status).toBe(200);
    expect(mod((await ws(S.super, S.b)).body, 'seoPages')).toMatchObject({ enabled: true });
    expect(mod((await ws(S.super, S.b)).body, 'seoPages').config.health).toBe('attention'); // slug not set
  });
});
