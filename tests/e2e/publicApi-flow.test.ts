import { createHmac } from 'node:crypto';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

/** publicApi: API keys, public endpoints and signed webhooks, with a FAKE http client (nothing here touches the internet). */
let mongod: MongoMemoryServer;
let app: import('express').Express;
let http: typeof import('../../src/shared/infra/http.js');
let mod: typeof import('../../src/product/modules/publicApi/index.js');

const PW = 'Str0ng-Passw0rd!';
const api = () => request(app);
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const login = async (email: string) => (await api().post('/api/v1/auth/login').send({ email, password: PW })).body.token as string;
const bearer = (k: string) => ({ Authorization: `Bearer ${k}` });
const sig = (secret: string, body: string) => 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');

const S: Record<string, string> = {};
let calls: Array<{ url: string; req: any }> = [];
let respond: (url: string, req: any) => any = () => ({ status: 200, ok: true, data: {}, text: 'ok' });
const hookCalls = () => calls.filter((c) => c.url.startsWith('https://hooks.alpha.example'));

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri(), { dbName: 'cp_master' });
  const { hashPassword } = await import('../../src/core/modules/identity/infrastructure/security.js');
  const { User } = await import('../../src/core/modules/identity/infrastructure/user.model.js');
  app = (await import('../../src/app/app.js')).buildApp();
  http = await import('../../src/shared/infra/http.js');
  mod = await import('../../src/product/modules/publicApi/index.js');
  http.setHttpClient(async (url, req) => {
    calls.push({ url, req });
    return respond(url, req);
  });
  await User.create({ email: 'super@platform.test', name: 'Super', passwordHash: await hashPassword(PW), role: 'superadmin', tenantId: null });
  S.superToken = await login('super@platform.test');
  const mk = async (name: string, slug: string, email: string) =>
    (await api().post('/api/v1/platform/tenants').set(auth(S.superToken)).send({ name, slug, ownerName: 'Owner', ownerEmail: email, ownerPassword: PW })).body.tenantId as string;
  S.tenantA = await mk('Alpha', 'alpha', 'owner@alpha.test');
  S.tenantB = await mk('Beta', 'beta', 'owner@beta.test');
  S.owner = await login('owner@alpha.test');
  S.ownerB = await login('owner@beta.test');
  await api().post('/api/v1/team').set(auth(S.owner)).send({ name: 'Asha', email: 'asha@alpha.test', password: PW, role: 'counsellor' });
  S.counsellor = await login('asha@alpha.test');
});

afterEach(() => {
  calls = [];
  respond = () => ({ status: 200, ok: true, data: {}, text: 'ok' });
});
afterAll(async () => {
  http?.resetHttpClient();
  await mongoose.disconnect();
  await mongod?.stop();
});

const enableAll = async (t: string, extra: Record<string, boolean> = {}) =>
  api().patch(`/api/v1/platform/tenants/${t}/modules`).set(auth(S.superToken)).send({ modules: { students: true, colleges: true, applications: true, publicApi: true, ...extra } });

describe('1. module off', () => {
  it('staff endpoints are closed until the module is enabled', async () => {
    const r = await api().get('/api/v1/integrations/api/keys').set(auth(S.owner));
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('MODULE_NOT_ENABLED');
  });
  it('enable for both organisations (and a college + leads setup)', async () => {
    expect((await enableAll(S.tenantA)).status).toBe(200);
    expect((await enableAll(S.tenantB)).status).toBe(200);
    S.college1 = (await api().post('/api/v1/colleges').set(auth(S.owner)).send({ name: 'Delta Institute', city: 'Pune' })).body._id;
    S.college2 = (await api().post('/api/v1/colleges').set(auth(S.owner)).send({ name: 'Omega University', city: 'Delhi' })).body._id;
    S.collegeB = (await api().post('/api/v1/colleges').set(auth(S.ownerB)).send({ name: 'Beta College' })).body._id;
    expect(S.college1 && S.college2 && S.collegeB).toBeTruthy();
  });
});

describe('2. API keys (staff)', () => {
  it('needs integrations:manage', async () => {
    expect((await api().get('/api/v1/integrations/api/keys').set(auth(S.counsellor))).status).toBe(403);
    expect((await api().post('/api/v1/integrations/api/keys').set(auth(S.counsellor)).send({ name: 'x', scopes: ['leads:create'] })).status).toBe(403);
  });
  it('validates input', async () => {
    const post = (b: object) => api().post('/api/v1/integrations/api/keys').set(auth(S.owner)).send(b);
    expect((await post({ name: 'W', scopes: ['leads:create'] })).status).toBe(400); // name too short
    expect((await post({ name: 'Website', scopes: [] })).status).toBe(400);
    expect((await post({ name: 'Website', scopes: ['admin:everything'] })).status).toBe(400);
    expect((await post({ name: 'Website', scopes: ['applications:read'] })).status).toBe(400); // needs a college
    expect((await post({ name: 'Website', scopes: ['leads:create'], collegeId: 'a'.repeat(24) })).status).toBe(400); // no such college
  });
  it('creates keys: the full key is shown once, only the hash is stored', async () => {
    const mkKey = async (name: string, scopes: string[], collegeId?: string) => {
      const r = await api().post('/api/v1/integrations/api/keys').set(auth(S.owner)).send({ name, scopes, collegeId });
      expect(r.status).toBe(201);
      expect(r.body.apiKey).toMatch(new RegExp(`^cpk_${S.tenantA}_[a-f0-9]{48}$`));
      return r.body as { id: string; apiKey: string; prefix: string };
    };
    const web = await mkKey('Website', ['leads:create', 'colleges:read']);
    const col = await mkKey('Delta portal', ['colleges:read', 'applications:read', 'applications:update'], S.college1);
    const readOnly = await mkKey('Read only', ['colleges:read']);
    Object.assign(S, { webKey: web.apiKey, webKeyId: web.id, collegeKey: col.apiKey, collegeKeyId: col.id, roKey: readOnly.apiKey });

    const list = await api().get('/api/v1/integrations/api/keys').set(auth(S.owner));
    expect(list.body.items).toHaveLength(3);
    for (const k of [web.apiKey, col.apiKey, readOnly.apiKey]) {
      expect(JSON.stringify(list.body)).not.toContain(k);
      expect(JSON.stringify(list.body)).not.toContain(k.split('_')[2]);
    }
    expect(list.body.items.some((k: any) => 'hash' in k || 'apiKey' in k)).toBe(false);

    const raw = await mongoose.connection.useDb(`cp_t_${S.tenantA}`).collection('apikeys').find().toArray();
    expect(raw).toHaveLength(3);
    for (const d of raw) {
      expect(d.hash).toMatch(/^[a-f0-9]{64}$/);
      expect(JSON.stringify(d)).not.toContain(web.apiKey.split('_')[2]);
    }
    const audit = JSON.stringify((await api().get('/api/v1/audit').set(auth(S.owner))).body);
    expect(audit).toContain('apikey.created');
    expect(audit).not.toContain(web.apiKey);
  });
});

describe('3. public API authentication', () => {
  it('refuses a missing, malformed, unknown or other-organisation key with 401', async () => {
    expect((await api().get('/public/v1/colleges')).status).toBe(401);
    expect((await api().get('/public/v1/colleges').set(bearer('nonsense'))).status).toBe(401);
    expect((await api().get('/public/v1/colleges').set(bearer(`cpk_${S.tenantA}_${'0'.repeat(48)}`))).status).toBe(401);
    // a key shaped for organisation B but with A's secret part does not work either
    const forged = S.webKey.replace(S.tenantA, S.tenantB);
    expect((await api().get('/public/v1/colleges').set(bearer(forged))).status).toBe(401);
  });
  it('a key without the scope gets 403', async () => {
    const r = await api().post('/public/v1/leads').set(bearer(S.roKey)).send({ name: 'Sneha Rao', phone: '9876500001', consent: { given: true } });
    expect(r.status).toBe(403);
    expect((await api().get('/public/v1/applications').set(bearer(S.webKey))).status).toBe(403);
  });
});

describe('4. POST /public/v1/leads', () => {
  it('requires consent and a valid phone', async () => {
    const post = (b: object) => api().post('/public/v1/leads').set(bearer(S.webKey)).send(b);
    expect((await post({ name: 'Sneha Rao', phone: '9876500001' })).status).toBe(400);
    expect((await post({ name: 'Sneha Rao', phone: '9876500001', consent: { given: false } })).status).toBe(400);
    expect((await post({ name: 'Sneha Rao', phone: '12345', consent: { given: true } })).status).toBe(400);
    expect((await api().get('/api/v1/leads').set(auth(S.owner))).body.total).toBe(0);
  });
  it('creates a lead on the api channel attributed to the key; a duplicate phone creates no second lead', async () => {
    const body = { name: 'Sneha Rao', phone: '+91 98765 00001', email: 'Sneha@Example.com', city: 'Kochi', utmSource: 'site', consent: { given: true, source: 'contact-form' } };
    const r = await api().post('/public/v1/leads').set(bearer(S.webKey)).send(body);
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ duplicate: false });
    const leads = (await api().get('/api/v1/leads').set(auth(S.owner))).body;
    expect(leads.total).toBe(1);
    expect(leads.items[0]).toMatchObject({ name: 'Sneha Rao', phone: '+919876500001', source: { channel: 'api', utmSource: 'site' }, createdBy: 'system:api:Website' });
    expect(leads.items[0].consent.given).toBe(true);

    const dup = await api().post('/public/v1/leads').set(bearer(S.webKey)).send({ ...body, name: 'Sneha again', phone: '9876500001' });
    expect(dup.status).toBe(200);
    expect(dup.body.duplicate).toBe(true);
    expect(dup.body.id).toBe(r.body.id);
    expect(dup.body.message).toMatch(/already/i);
    expect((await api().get('/api/v1/leads').set(auth(S.owner))).body.total).toBe(1);
  });
  it('is isolated: the lead is not in organisation B and B can use the same phone', async () => {
    expect((await api().get('/api/v1/leads').set(auth(S.ownerB))).body.total).toBe(0);
    const kb = await api().post('/api/v1/integrations/api/keys').set(auth(S.ownerB)).send({ name: 'Beta site', scopes: ['leads:create', 'colleges:read'] });
    S.keyB = kb.body.apiKey;
    const r = await api().post('/public/v1/leads').set(bearer(S.keyB)).send({ name: 'Sneha Rao', phone: '9876500001', consent: { given: true } });
    expect(r.status).toBe(201);
    expect((await api().get('/api/v1/leads').set(auth(S.ownerB))).body.total).toBe(1);
  });
  it('audits the creation', async () => {
    const audit = JSON.stringify((await api().get('/api/v1/audit').set(auth(S.owner))).body);
    expect(audit).toContain('lead.created');
    expect(audit).toContain('lead.duplicate_enquiry');
  });
});

describe('5. GET /public/v1/colleges', () => {
  it('lists active colleges of the key organisation only, without contact details', async () => {
    const r = await api().get('/public/v1/colleges').set(bearer(S.webKey));
    expect(r.status).toBe(200);
    expect(r.body.items.map((c: any) => c.name).sort()).toEqual(['Delta Institute', 'Omega University']);
    expect(JSON.stringify(r.body)).not.toContain('Beta College');
    expect(r.body.items[0]).not.toHaveProperty('contact');
    expect((await api().get('/public/v1/colleges').set(bearer(S.keyB))).body.items.map((c: any) => c.name)).toEqual(['Beta College']);
  });
  it('a college-tied key sees only its own college', async () => {
    const r = await api().get('/public/v1/colleges').set(bearer(S.collegeKey));
    expect(r.body.items.map((c: any) => c.name)).toEqual(['Delta Institute']);
  });
});

describe('6. college applications API', () => {
  const INTAKE = { month: 8, year: 2099 };
  const staffMove = (id: string, to: string) => api().post(`/api/v1/applications/${id}/status`).set(auth(S.owner)).send({ to });
  it('set up two applications in two colleges', async () => {
    S.student = (await api().post('/api/v1/students').set(auth(S.owner)).send({ name: 'Ravi Kumar', phone: '9876543210', dob: '2000-01-01', consent: { given: true } })).body._id;
    const course = async (cid: string) => (await api().post(`/api/v1/colleges/${cid}/courses`).set(auth(S.owner)).send({ name: 'MBA', level: 'pg', annualFeePaise: 100000, durationMonths: 24, intakes: [{ month: 8, year: 2099 }] })).body._id;
    const mkApp = async (collegeId: string) => (await api().post('/api/v1/applications').set(auth(S.owner)).send({ studentId: S.student, collegeId, courseId: await course(collegeId), intake: INTAKE })).body._id;
    S.app1 = await mkApp(S.college1);
    S.app2 = await mkApp(S.college2);
    expect(S.app1 && S.app2).toBeTruthy();
    for (const to of ['documents_pending', 'ready_to_submit', 'submitted']) {
      expect((await staffMove(S.app1, to)).status).toBe(200);
      expect((await staffMove(S.app2, to)).status).toBe(200);
    }
  });
  it('lists only the key college applications, with ids and status only', async () => {
    const r = await api().get('/public/v1/applications').set(bearer(S.collegeKey));
    expect(r.status).toBe(200);
    expect(r.body.items.map((a: any) => a.id)).toEqual([S.app1]);
    expect(r.body.items[0]).toMatchObject({ status: 'submitted' });
    expect(r.body.items[0]).not.toHaveProperty('fee');
    expect(JSON.stringify(r.body)).not.toContain(S.app2);
  });
  it('a key that is not tied to a college cannot use the applications endpoints at all', async () => {
    const k = (await api().post('/api/v1/integrations/api/keys').set(auth(S.owner)).send({ name: 'Open key', scopes: ['leads:create'] })).body.apiKey;
    expect((await api().get('/public/v1/applications').set(bearer(k))).status).toBe(403); // scope
  });
  it('changes a status through the state machine; illegal moves are 409; other colleges look like 404', async () => {
    const patch = (id: string, status: string, key = S.collegeKey) => api().patch(`/public/v1/applications/${id}/status`).set(bearer(key)).send({ status, note: 'via portal' });
    expect((await patch(S.app1, 'offered')).status).toBe(409); // submitted -> offered skips under_review
    expect((await patch(S.app1, 'nonsense')).status).toBe(400);
    const ok = await patch(S.app1, 'under_review');
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('under_review');
    expect((await patch(S.app1, 'offered')).status).toBe(200);
    // another college's application: indistinguishable from a missing one, and untouched
    const other = await patch(S.app2, 'under_review');
    expect(other.status).toBe(404);
    expect((await api().get(`/api/v1/applications/${S.app2}`).set(auth(S.owner))).body.status).toBe('submitted');
    // organisation B's key cannot reach it either
    const kcb = (await api().post('/api/v1/integrations/api/keys').set(auth(S.ownerB)).send({ name: 'Beta college', scopes: ['applications:update', 'applications:read'], collegeId: S.collegeB })).body.apiKey;
    expect((await patch(S.app1, 'rejected', kcb)).status).toBe(404);
    expect((await api().get('/public/v1/applications').set(bearer(kcb))).body.items).toEqual([]);
  });
  it('is audited with the key name', async () => {
    const audit = JSON.stringify((await api().get(`/api/v1/audit?entityId=${S.app1}`).set(auth(S.owner))).body);
    expect(audit).toContain('application.status_changed');
    expect(audit).toContain('publicapi.application_status');
    expect(audit).toContain('Delta portal');
  });
});

describe('7. webhooks: subscriptions and the SSRF guard', () => {
  it('needs integrations:manage', async () => {
    expect((await api().get('/api/v1/integrations/api/webhooks').set(auth(S.counsellor))).status).toBe(403);
  });
  it('rejects unsafe addresses on create', async () => {
    const post = (url: string) => api().post('/api/v1/integrations/api/webhooks').set(auth(S.owner)).send({ url, events: ['lead.created'] });
    for (const url of ['http://hooks.alpha.example/in', 'https://localhost/in', 'https://127.0.0.1/in', 'https://10.1.2.3/in', 'https://169.254.169.254/latest', 'https://192.168.0.9/in', 'https://[::1]/in', 'https://user:pw@hooks.alpha.example/in', 'https://intranet/in']) {
      const r = await post(url);
      expect(r.status, url).toBe(400);
    }
    expect((await api().post('/api/v1/integrations/api/webhooks').set(auth(S.owner)).send({ url: 'https://hooks.alpha.example/in', events: ['lead.deleted'] })).status).toBe(400);
    expect((await api().post('/api/v1/integrations/api/webhooks').set(auth(S.owner)).send({ url: 'https://hooks.alpha.example/in', events: [] })).status).toBe(400);
    expect((await api().get('/api/v1/integrations/api/webhooks').set(auth(S.owner))).body.items).toEqual([]);
  });
  it('creates one; the secret is shown once and stored encrypted', async () => {
    const r = await api().post('/api/v1/integrations/api/webhooks').set(auth(S.owner)).send({ url: 'https://hooks.alpha.example/in', events: ['lead.created', 'application.status_changed', 'lead.stage_changed'] });
    expect(r.status).toBe(201);
    expect(r.body.secret).toMatch(/^whsec_[a-f0-9]{48}$/);
    S.secret = r.body.secret;
    S.hookId = r.body.id;
    const list = await api().get('/api/v1/integrations/api/webhooks').set(auth(S.owner));
    expect(JSON.stringify(list.body)).not.toContain(S.secret);
    expect(list.body.items[0]).toMatchObject({ url: 'https://hooks.alpha.example/in', active: true, failureCount: 0 });
    const raw = await mongoose.connection.useDb(`cp_t_${S.tenantA}`).collection('webhooks').findOne({});
    expect(JSON.stringify(raw)).not.toContain(S.secret);
    expect(raw!.secretEnc).toBeTruthy();
    const audit = JSON.stringify((await api().get('/api/v1/audit').set(auth(S.owner))).body);
    expect(audit).toContain('webhook.created');
    expect(audit).not.toContain(S.secret);
  });
  it('the url cannot be edited to an unsafe address', async () => {
    expect((await api().patch(`/api/v1/integrations/api/webhooks/${S.hookId}`).set(auth(S.owner)).send({ url: 'https://127.0.0.1/x' })).status).toBe(400);
  });
});

describe('8. webhook delivery', () => {
  it('sends a signed POST with exact headers and body, in the background, and records it', async () => {
    const r = await api().post('/public/v1/leads').set(bearer(S.webKey)).send({ name: 'Kiran Das', phone: '9876500002', consent: { given: true } });
    expect(r.status).toBe(201);
    await mod.settlePublicApi();
    const sent = hookCalls();
    expect(sent).toHaveLength(1);
    const { url, req } = sent[0]!;
    expect(url).toBe('https://hooks.alpha.example/in');
    expect(req.method).toBe('POST');
    expect(req.timeoutMs).toBe(5000);
    expect(typeof req.body).toBe('string');
    const body = JSON.parse(req.body);
    expect(Object.keys(body).sort()).toEqual(['data', 'event', 'id', 'occurredAt']);
    expect(body.event).toBe('lead.created');
    expect(body.data).toEqual({ leadId: r.body.id, channel: 'api' });
    expect(new Date(body.occurredAt).toISOString()).toBe(body.occurredAt);
    expect(req.headers['x-cp-event']).toBe('lead.created');
    expect(req.headers['x-cp-signature']).toBe(sig(S.secret, req.body));
    expect(req.headers['content-type']).toBe('application/json');
    expect(JSON.stringify(body)).not.toContain('Kiran'); // no personal data in the payload
    expect(JSON.stringify(body)).not.toContain('9876500002');
    const d = (await api().get('/api/v1/integrations/api/deliveries').set(auth(S.owner))).body.items;
    expect(d[0]).toMatchObject({ event: 'lead.created', status: 'delivered', attempts: 1, responseCode: 200, webhookId: S.hookId });
  });

  it('does not send events the subscription did not ask for, nor for inactive subscriptions', async () => {
    await api().patch(`/api/v1/integrations/api/webhooks/${S.hookId}`).set(auth(S.owner)).send({ events: ['application.status_changed'] });
    calls = [];
    await api().post('/public/v1/leads').set(bearer(S.webKey)).send({ name: 'Mala Iyer', phone: '9876500003', consent: { given: true } });
    await mod.settlePublicApi();
    expect(hookCalls()).toHaveLength(0);
    await api().patch(`/api/v1/integrations/api/webhooks/${S.hookId}`).set(auth(S.owner)).send({ events: ['lead.created', 'application.status_changed'], active: false });
    await api().post('/public/v1/leads').set(bearer(S.webKey)).send({ name: 'Nisha Roy', phone: '9876500004', consent: { given: true } });
    await mod.settlePublicApi();
    expect(hookCalls()).toHaveLength(0);
    await api().patch(`/api/v1/integrations/api/webhooks/${S.hookId}`).set(auth(S.owner)).send({ active: true });
  });

  it('a failing receiver never breaks the request; it is recorded and retried with backoff', async () => {
    respond = () => ({ status: 500, ok: false, data: null, text: 'boom' });
    const t0 = Date.now();
    const r = await api().post('/public/v1/leads').set(bearer(S.webKey)).send({ name: 'Omar Sheikh', phone: '9876500005', consent: { given: true } });
    expect(r.status).toBe(201);
    await mod.settlePublicApi();
    expect(hookCalls()).toHaveLength(1);
    let d = (await api().get('/api/v1/integrations/api/deliveries?status=retrying').set(auth(S.owner))).body.items;
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ status: 'retrying', attempts: 1, responseCode: 500 });
    expect(d[0].error).toContain('500');
    const next1 = new Date(d[0].nextAttemptAt).getTime();
    expect(next1 - t0).toBeGreaterThanOrEqual(59_000);
    expect(next1 - t0).toBeLessThan(70_000);
    expect((await api().get('/api/v1/integrations/api/webhooks').set(auth(S.owner))).body.items[0].failureCount).toBe(1);

    // nothing is due yet
    expect(await mod.retryDueDeliveries(S.tenantA)).toEqual({ tried: 0, delivered: 0 });
    expect(hookCalls()).toHaveLength(1);

    // due after one minute, fails again: next wait is 5 minutes
    const t1 = new Date(next1 + 1000);
    expect(await mod.retryDueDeliveries(S.tenantA, t1)).toEqual({ tried: 1, delivered: 0 });
    d = (await api().get('/api/v1/integrations/api/deliveries?status=retrying').set(auth(S.owner))).body.items;
    expect(d[0].attempts).toBe(2);
    const next2 = new Date(d[0].nextAttemptAt).getTime();
    expect(next2 - Date.now()).toBeGreaterThan(4 * 60_000);
    expect(next2 - Date.now()).toBeLessThan(6 * 60_000);
    // the retry carries the SAME body, signature and event
    const [first, second] = hookCalls();
    expect(second!.req.body).toBe(first!.req.body);
    expect(second!.req.headers['x-cp-signature']).toBe(first!.req.headers['x-cp-signature']);

    // the receiver recovers: next due attempt delivers
    respond = () => ({ status: 200, ok: true, data: {}, text: 'ok' });
    expect(await mod.retryDueDeliveries(S.tenantA, new Date(next2 + 1000))).toEqual({ tried: 1, delivered: 1 });
    const done = (await api().get('/api/v1/integrations/api/deliveries').set(auth(S.owner))).body.items.find((x: any) => x.attempts === 3);
    expect(done).toMatchObject({ status: 'delivered', responseCode: 200, nextAttemptAt: null, error: null });
    expect((await api().get('/api/v1/integrations/api/webhooks').set(auth(S.owner))).body.items[0].failureCount).toBe(0);
  });

  it('gives up after 5 attempts; staff can retry a failed delivery (fresh attempts)', async () => {
    respond = () => { throw new Error('connect ECONNREFUSED'); };
    await api().post('/public/v1/leads').set(bearer(S.webKey)).send({ name: 'Pooja Nair', phone: '9876500006', consent: { given: true } });
    await mod.settlePublicApi();
    let now = Date.now();
    for (let i = 0; i < 4; i++) {
      now += 3 * 3_600_000;
      expect((await mod.retryDueDeliveries(S.tenantA, new Date(now))).tried).toBe(1);
    }
    const failed = (await api().get('/api/v1/integrations/api/deliveries?status=failed').set(auth(S.owner))).body.items;
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ status: 'failed', attempts: 5, nextAttemptAt: null });
    expect(failed[0].error).toContain('ECONNREFUSED');
    expect(await mod.retryDueDeliveries(S.tenantA, new Date(now + 99 * 3_600_000))).toEqual({ tried: 0, delivered: 0 });
    expect(await mod.retryDueDeliveries(undefined, new Date(now + 99 * 3_600_000))).toEqual({ tried: 0, delivered: 0 }); // all organisations

    // staff retry once the receiver is back
    respond = () => ({ status: 200, ok: true, data: {}, text: 'ok' });
    const retry = await api().post(`/api/v1/integrations/api/deliveries/${failed[0].id}/retry`).set(auth(S.owner));
    expect(retry.status).toBe(200);
    expect(retry.body).toMatchObject({ status: 'delivered', attempts: 1 });
    expect((await api().post(`/api/v1/integrations/api/deliveries/${failed[0].id}/retry`).set(auth(S.owner))).status).toBe(400); // already delivered
    expect((await api().post(`/api/v1/integrations/api/deliveries/${'a'.repeat(24)}/retry`).set(auth(S.owner))).status).toBe(404);
    expect((await api().post('/api/v1/integrations/api/webhooks/retry').set(auth(S.owner))).body).toEqual({ tried: 0, delivered: 0 });
    expect((await api().post('/api/v1/integrations/api/webhooks/retry').set(auth(S.counsellor))).status).toBe(403);
  });

  it('application status changes through the API are announced too', async () => {
    calls = [];
    await api().patch(`/public/v1/applications/${S.app1}/status`).set(bearer(S.collegeKey)).send({ status: 'accepted' });
    await mod.settlePublicApi();
    const [c] = hookCalls();
    const body = JSON.parse(c!.req.body);
    expect(body.event).toBe('application.status_changed');
    expect(body.data).toMatchObject({ applicationId: S.app1, collegeId: S.college1, from: 'offered', to: 'accepted' });
    expect(c!.req.headers['x-cp-signature']).toBe(sig(S.secret, c!.req.body));
  });

  it('the secret and the keys never appear in deliveries, webhooks or the audit trail', async () => {
    const all = JSON.stringify([
      (await api().get('/api/v1/integrations/api/deliveries').set(auth(S.owner))).body,
      (await api().get('/api/v1/integrations/api/webhooks').set(auth(S.owner))).body,
      (await api().get('/api/v1/integrations/api/keys').set(auth(S.owner))).body,
      (await api().get('/api/v1/audit').set(auth(S.owner))).body,
    ]);
    expect(all).not.toContain(S.secret);
    expect(all).not.toContain(S.secret.slice(6));
    for (const k of [S.webKey, S.collegeKey, S.roKey]) expect(all).not.toContain(k.split('_')[2]);
  });

  it('organisations are isolated: B sees no webhooks, deliveries or keys of A, and A events never reach B', async () => {
    for (const p of ['webhooks', 'deliveries']) expect((await api().get(`/api/v1/integrations/api/${p}`).set(auth(S.ownerB))).body.items).toEqual([]);
    expect((await api().get('/api/v1/integrations/api/keys').set(auth(S.ownerB))).body.items.map((k: any) => k.name).sort()).toEqual(['Beta college', 'Beta site']);
    expect((await api().patch(`/api/v1/integrations/api/webhooks/${S.hookId}`).set(auth(S.ownerB)).send({ active: false })).status).toBe(404);
    expect((await api().post(`/api/v1/integrations/api/keys/${S.webKeyId}/revoke`).set(auth(S.ownerB))).status).toBe(404);
    calls = [];
    await api().post('/public/v1/leads').set(bearer(S.keyB)).send({ name: 'Beta Lead', phone: '9000000099', consent: { given: true } });
    await mod.settlePublicApi();
    expect(hookCalls()).toHaveLength(0);
  });

  it('deleting a subscription stops sending and is audited', async () => {
    expect((await api().delete(`/api/v1/integrations/api/webhooks/${S.hookId}`).set(auth(S.owner))).status).toBe(200);
    calls = [];
    await api().post('/public/v1/leads').set(bearer(S.webKey)).send({ name: 'Quiet Lead', phone: '9876500007', consent: { given: true } });
    await mod.settlePublicApi();
    expect(hookCalls()).toHaveLength(0);
    expect(JSON.stringify((await api().get('/api/v1/audit').set(auth(S.owner))).body)).toContain('webhook.deleted');
  });
});

describe('9. revoking, rate limit, module off', () => {
  it('a revoked key gets 401 immediately; revoking again is harmless; audited', async () => {
    expect((await api().get('/public/v1/colleges').set(bearer(S.roKey))).status).toBe(200);
    const id = (await api().get('/api/v1/integrations/api/keys').set(auth(S.owner))).body.items.find((k: any) => k.name === 'Read only').id;
    const rv = await api().post(`/api/v1/integrations/api/keys/${id}/revoke`).set(auth(S.owner));
    expect(rv.status).toBe(200);
    expect(rv.body.revokedAt).toBeTruthy();
    expect((await api().get('/public/v1/colleges').set(bearer(S.roKey))).status).toBe(401);
    expect((await api().post(`/api/v1/integrations/api/keys/${id}/revoke`).set(auth(S.owner))).status).toBe(200);
    expect(JSON.stringify((await api().get('/api/v1/audit').set(auth(S.owner))).body)).toContain('apikey.revoked');
    expect((await api().post(`/api/v1/integrations/api/keys/${'a'.repeat(24)}/revoke`).set(auth(S.owner))).status).toBe(404);
  });

  it('rate limits per key (429) without affecting another key', async () => {
    mod.resetPublicApiRateLimits();
    let last = 200;
    for (let i = 0; i < 61; i++) last = (await api().get('/public/v1/colleges').set(bearer(S.collegeKey))).status;
    expect(last).toBe(429);
    expect((await api().get('/public/v1/colleges').set(bearer(S.webKey))).status).toBe(200);
    mod.resetPublicApiRateLimits();
  });

  it('switching the module off closes the public API and the staff API (403 MODULE_NOT_ENABLED)', async () => {
    expect((await api().patch(`/api/v1/platform/tenants/${S.tenantA}/modules`).set(auth(S.superToken)).send({ modules: { publicApi: false } })).status).toBe(200);
    const pub = await api().get('/public/v1/colleges').set(bearer(S.webKey));
    expect(pub.status).toBe(403);
    expect(pub.body.error.code).toBe('MODULE_NOT_ENABLED');
    expect((await api().get('/api/v1/integrations/api/keys').set(auth(S.owner))).body.error.code).toBe('MODULE_NOT_ENABLED');
  });
});
