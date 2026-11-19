import { createHmac } from 'node:crypto';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * WhatsApp: everything runs against a FAKE http client and a FAKE usage meter. Nothing here proves the real WhatsApp Cloud API
 * accepts our calls; that needs real credentials and an approved template.
 */
process.env.WHATSAPP_TOKEN = 'wa-test-token';
process.env.WHATSAPP_PHONE_NUMBER_ID = '555000111';
process.env.WHATSAPP_VERIFY_TOKEN = 'verify-me';
process.env.META_APP_SECRET = 'app-secret-for-tests';
process.env.WHATSAPP_COST_PER_MESSAGE_PAISE = '75';

let mongod: MongoMemoryServer;
let app: import('express').Express;
const PW = 'Str0ng-Passw0rd!';
const api = () => request(app);
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const login = async (email: string) => (await api().post('/api/v1/auth/login').send({ email, password: PW })).body.token as string;

const S = { superToken: '', tenantA: '', tenantB: '', owner: '', ownerB: '', counsellor: '', counsellorId: '', marketing: '', lead: '', leadNoConsent: '', leadOther: '', providerId: '' };
const usage: { tenantId: string; entry: any }[] = [];
const calls: { url: string; req: any }[] = [];
let nextHttp: { status: number; data: any } | null = null;
let seq = 0;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri(), { dbName: 'cp_master' });
  const { hashPassword } = await import('../../src/core/modules/identity/infrastructure/security.js');
  const { User } = await import('../../src/core/modules/identity/infrastructure/user.model.js');
  app = (await import('../../src/app/app.js')).buildApp();

  // fake platform: the real one, except recordUsage is captured
  const { setPlatform, getPlatform } = await import('../../src/contracts/registry.js');
  setPlatform({ ...getPlatform(), recordUsage: async (tenantId: string, entry: any) => void usage.push({ tenantId, entry }) } as any);
  // fake outbound http
  const { setHttpClient } = await import('../../src/shared/infra/http.js');
  setHttpClient(async (url, req) => {
    calls.push({ url, req });
    const r = nextHttp ?? { status: 200, data: { messages: [{ id: `wamid.${++seq}` }] } };
    nextHttp = null;
    return { status: r.status, ok: r.status < 300, data: r.data, text: JSON.stringify(r.data) };
  });

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
  await add('Mohit Marketing', 'mohit@alpha.test', 'marketing');
  S.counsellor = await login('asha@alpha.test');
  S.marketing = await login('mohit@alpha.test');
});

afterAll(async () => {
  const { resetHttpClient } = await import('../../src/shared/infra/http.js');
  resetHttpClient();
  await mongoose.disconnect();
  await mongod?.stop();
});

const newLead = async (phone: string, consent: boolean, name = 'Rahul Sharma') =>
  (await api().post('/api/v1/leads').set(auth(S.owner)).send({ name, phone, source: { channel: 'walk_in' }, consent: { given: consent, source: 'walk_in' } })).body.lead._id as string;
const send = (token: string, body: object) => api().post('/api/v1/whatsapp/send').set(auth(token)).send(body);
const sign = (raw: string) => `sha256=${createHmac('sha256', 'app-secret-for-tests').update(raw).digest('hex')}`;
const hook = (payload: object, sig?: string) => {
  const raw = JSON.stringify(payload);
  return api().post('/public/hooks/whatsapp').set('content-type', 'application/json').set('x-hub-signature-256', sig ?? sign(raw)).send(raw);
};

describe('1. module switch and permissions', () => {
  it('is off until enabled (MODULE_NOT_ENABLED)', async () => {
    const res = await api().get('/api/v1/whatsapp/templates').set(auth(S.owner));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('MODULE_NOT_ENABLED');
    const on = await api().patch(`/api/v1/platform/tenants/${S.tenantA}/modules`).set(auth(S.superToken)).send({ modules: { whatsapp: true } });
    expect(on.status).toBe(200);
    expect((await api().get('/api/v1/whatsapp/templates').set(auth(S.owner))).status).toBe(200);
  });

  it('marketing has no whatsapp permission; a counsellor cannot manage templates', async () => {
    expect((await api().get('/api/v1/whatsapp/templates').set(auth(S.marketing))).status).toBe(403);
    expect((await api().post('/api/v1/whatsapp/templates').set(auth(S.counsellor)).send({ name: 'x_y', body: 'Hi' })).status).toBe(403);
  });
});

describe('2. templates', () => {
  it('validates, creates, lists, blocks duplicates', async () => {
    expect((await api().post('/api/v1/whatsapp/templates').set(auth(S.owner)).send({ name: 'Bad Name', body: 'Hi' })).status).toBe(400);
    expect((await api().post('/api/v1/whatsapp/templates').set(auth(S.owner)).send({ name: 'gap', body: 'Hi {{1}} {{3}}' })).status).toBe(400);
    const ok = await api().post('/api/v1/whatsapp/templates').set(auth(S.owner)).send({ name: 'welcome', body: 'Hi {{1}}, thanks for your interest in {{2}}.', purpose: 'first reply' });
    expect(ok.status).toBe(201);
    expect(ok.body.placeholders).toBe(2);
    await api().post('/api/v1/whatsapp/templates').set(auth(S.owner)).send({ name: 'auto_q', body: 'Hello {{1}}, you are shortlisted!' });
    expect((await api().post('/api/v1/whatsapp/templates').set(auth(S.owner)).send({ name: 'welcome', body: 'again' })).status).toBe(409);
    const list = await api().get('/api/v1/whatsapp/templates').set(auth(S.counsellor));
    expect(list.body.items.map((t: any) => t.name)).toEqual(['auto_q', 'welcome']);
  });
});

describe('3. sending', () => {
  it('refuses a lead without consent and does not call WhatsApp or meter', async () => {
    S.leadNoConsent = await newLead('9811111111', false);
    const res = await send(S.owner, { leadId: S.leadNoConsent, template: 'welcome', params: ['Rahul', 'MBA'] });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/not agreed to be contacted/);
    expect(calls).toHaveLength(0);
    expect(usage).toHaveLength(0);
  });

  it('validates input (params count, unknown template, both ids)', async () => {
    S.lead = await newLead('9876543210', true);
    expect((await send(S.owner, { leadId: S.lead, template: 'welcome', params: ['only one'] })).status).toBe(400);
    expect((await send(S.owner, { leadId: S.lead, template: 'nope', params: [] })).status).toBe(404);
    expect((await send(S.owner, { template: 'welcome', params: [] })).status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('sends through the Graph API, logs it and meters the env cost once', async () => {
    const res = await send(S.owner, { leadId: S.lead, template: 'welcome', params: ['Rahul', 'MBA'] });
    expect(res.status).toBe(201);
    expect(res.body.message).toMatchObject({ status: 'sent', to: '+919876543210', text: 'Hi Rahul, thanks for your interest in MBA.' });
    S.providerId = res.body.message.providerId;
    expect(S.providerId).toMatch(/^wamid\./);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toMatch(/graph\.facebook\.com\/.+\/555000111\/messages$/);
    expect(calls[0].req.headers.authorization).toBe('Bearer wa-test-token');
    expect(calls[0].req.body).toEqual({
      messaging_product: 'whatsapp',
      to: '919876543210',
      type: 'template',
      template: { name: 'welcome', language: { code: 'en' }, components: [{ type: 'body', parameters: [{ type: 'text', text: 'Rahul' }, { type: 'text', text: 'MBA' }] }] },
    });
    expect(usage).toEqual([{ tenantId: S.tenantA, entry: expect.objectContaining({ category: 'whatsapp', amountPaise: 75 }) }]);
  });

  it('the identical send within 10 minutes is a duplicate: no call, no extra cost', async () => {
    const res = await send(S.owner, { leadId: S.lead, template: 'welcome', params: ['Rahul', 'MBA'] });
    expect(res.status).toBe(200);
    expect(res.body.duplicate).toBe(true);
    expect(calls).toHaveLength(1);
    expect(usage).toHaveLength(1);
    // different values are a different message
    expect((await send(S.owner, { leadId: S.lead, template: 'welcome', params: ['Rahul', 'MCA'] })).status).toBe(201);
    expect(usage).toHaveLength(2);
  });

  it('a failed send is logged as failed, not metered, and can be retried', async () => {
    nextHttp = { status: 400, data: { error: { message: 'Template not approved' } } };
    const res = await send(S.owner, { leadId: S.lead, template: 'welcome', params: ['Rahul', 'BBA'] });
    expect(res.body.message).toMatchObject({ status: 'failed', error: 'Template not approved' });
    expect(usage).toHaveLength(2);
    const retry = await send(S.owner, { leadId: S.lead, template: 'welcome', params: ['Rahul', 'BBA'] });
    expect(retry.status).toBe(201); // failed messages do not block a retry
    expect(retry.body.message.status).toBe('sent');
    expect(usage).toHaveLength(3);
  });

  it('a counsellor can only message their own leads; timeline respects it', async () => {
    expect((await send(S.counsellor, { leadId: S.lead, template: 'welcome', params: ['R', 'M'] })).status).toBe(403);
    await api().patch(`/api/v1/leads/${S.lead}/assign`).set(auth(S.owner)).send({ assigneeId: S.counsellorId });
    expect((await send(S.counsellor, { leadId: S.lead, template: 'welcome', params: ['R', 'M'] })).status).toBe(201);
    const other = await newLead('9822222222', true, 'Other Lead');
    S.leadOther = other;
    expect((await api().get(`/api/v1/whatsapp/messages?leadId=${other}`).set(auth(S.counsellor))).status).toBe(403);
    const mine = await api().get(`/api/v1/whatsapp/messages?leadId=${S.lead}`).set(auth(S.counsellor));
    expect(mine.status).toBe(200);
    expect(mine.body.total).toBeGreaterThanOrEqual(4);
  });
});

describe('4. automation rules', () => {
  it('validates and creates a rule (integrations:manage only)', async () => {
    expect((await api().post('/api/v1/whatsapp/rules').set(auth(S.counsellor)).send({ event: 'lead.created', template: 'welcome' })).status).toBe(403);
    expect((await api().post('/api/v1/whatsapp/rules').set(auth(S.owner)).send({ event: 'lead.exploded', template: 'welcome' })).status).toBe(400);
    const r = await api().post('/api/v1/whatsapp/rules').set(auth(S.owner)).send({ event: 'lead.stage_changed', filter: 'qualified', template: 'auto_q', params: ['{name}'] });
    expect(r.status).toBe(201);
    expect((await api().get('/api/v1/whatsapp/rules').set(auth(S.owner))).body.items).toHaveLength(1);
  });

  it('fires when the matching event happens, not for other stages', async () => {
    const before = calls.length;
    await api().patch(`/api/v1/leads/${S.leadOther}/stage`).set(auth(S.owner)).send({ stage: 'contacted' });
    expect(calls.length).toBe(before);
    await api().patch(`/api/v1/leads/${S.leadOther}/stage`).set(auth(S.owner)).send({ stage: 'qualified' });
    expect(calls.length).toBe(before + 1);
    expect(calls[before].req.body.template.components[0].parameters[0].text).toBe('Other Lead');
    const msgs = (await api().get(`/api/v1/whatsapp/messages?leadId=${S.leadOther}`).set(auth(S.owner))).body.items;
    expect(msgs[0]).toMatchObject({ template: 'auto_q', status: 'sent', by: 'system:whatsapp-automation' });
    expect(usage.at(-1)!.entry.amountPaise).toBe(75);
  });

  it('a rule skips people without consent', async () => {
    const before = calls.length;
    await api().patch(`/api/v1/leads/${S.leadNoConsent}/stage`).set(auth(S.owner)).send({ stage: 'contacted' });
    await api().patch(`/api/v1/leads/${S.leadNoConsent}/stage`).set(auth(S.owner)).send({ stage: 'qualified' });
    expect(calls.length).toBe(before);
  });

  it('a delayed rule queues the message until it is processed', async () => {
    await api().post('/api/v1/whatsapp/rules').set(auth(S.owner)).send({ event: 'lead.created', template: 'auto_q', params: ['{name}'], delayMinutes: 30 });
    const before = calls.length;
    const id = await newLead('9833333333', true, 'Delayed Dee');
    expect(calls.length).toBe(before);
    const msgs = (await api().get(`/api/v1/whatsapp/messages?leadId=${id}`).set(auth(S.owner))).body.items;
    expect(msgs[0].status).toBe('queued');
    expect((await api().post('/api/v1/whatsapp/process-due').set(auth(S.owner))).body.processed).toBe(0); // not due yet
  });
});

describe('5. public webhook', () => {
  it('verification handshake needs the right token', async () => {
    const ok = await api().get('/public/hooks/whatsapp').query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'verify-me', 'hub.challenge': '12345' });
    expect(ok.status).toBe(200);
    expect(ok.text).toBe('12345');
    expect((await api().get('/public/hooks/whatsapp').query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'wrong', 'hub.challenge': '1' })).status).toBe(403);
  });

  it('rejects a missing or wrong signature and changes nothing', async () => {
    const payload = { entry: [{ changes: [{ value: { statuses: [{ id: S.providerId, status: 'delivered' }] } }] }] };
    expect((await hook(payload, 'sha256=deadbeef')).status).toBe(401);
    expect((await api().post('/public/hooks/whatsapp').send(payload)).status).toBe(401);
    const msg = (await api().get(`/api/v1/whatsapp/messages?leadId=${S.lead}`).set(auth(S.owner))).body.items.find((m: any) => m.providerId === S.providerId);
    expect(msg.status).toBe('sent');
  });

  it('updates the status by providerId and never goes backwards', async () => {
    const st = (status: string) => ({ entry: [{ changes: [{ value: { statuses: [{ id: S.providerId, status }] } }] }] });
    const r = await hook(st('delivered'));
    expect(r.status).toBe(200);
    expect(r.body.statuses).toBe(1);
    await hook(st('read'));
    await hook(st('delivered')); // late, out-of-order callback
    const get = async () => (await api().get(`/api/v1/whatsapp/messages?leadId=${S.lead}`).set(auth(S.owner))).body.items.find((m: any) => m.providerId === S.providerId);
    expect((await get()).status).toBe('read');
    expect((await hook({ entry: [{ changes: [{ value: { statuses: [{ id: 'wamid.unknown', status: 'read' }] } }] }] })).body.statuses).toBe(0);
  });

  it('keeps an inbound text in the log of the organisation that messaged that number', async () => {
    const r = await hook({ entry: [{ changes: [{ value: { messages: [{ from: '919876543210', type: 'text', text: { body: 'Yes, call me' } }] } }] }] });
    expect(r.body.inbound).toBe(1);
    const msgs = (await api().get(`/api/v1/whatsapp/messages?leadId=${S.lead}`).set(auth(S.owner))).body.items;
    expect(msgs.find((m: any) => m.direction === 'in')).toMatchObject({ text: 'Yes, call me', leadId: S.lead });
  });
});

describe('6. isolation and audit', () => {
  it('another organisation has the module off, and sees nothing once on', async () => {
    expect((await api().get('/api/v1/whatsapp/messages').set(auth(S.ownerB))).status).toBe(403);
    await api().patch(`/api/v1/platform/tenants/${S.tenantB}/modules`).set(auth(S.superToken)).send({ modules: { whatsapp: true } });
    expect((await api().get('/api/v1/whatsapp/messages').set(auth(S.ownerB))).body.total).toBe(0);
    expect((await api().get('/api/v1/whatsapp/templates').set(auth(S.ownerB))).body.items).toHaveLength(0);
    expect((await send(S.ownerB, { leadId: S.lead, template: 'welcome', params: ['a', 'b'] })).status).toBe(404); // lead is not theirs
  });

  it('writes audit rows', async () => {
    const actions = (await api().get('/api/v1/audit?limit=100').set(auth(S.owner))).body.items.map((i: any) => i.action);
    for (const a of ['whatsapp.template_created', 'whatsapp.send_requested', 'whatsapp.rule_created', 'whatsapp.status_updated']) expect(actions).toContain(a);
  });
});
