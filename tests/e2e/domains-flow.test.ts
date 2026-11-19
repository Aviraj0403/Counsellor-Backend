import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * The origin whitelist end to end: server config, superadmin-managed domains, instant effect, safety rules, audit.
 * CORS is checked the way a browser does it: an OPTIONS preflight with an Origin header.
 */
let mongod: MongoMemoryServer;
let app: import('express').Express;
const PW = 'Str0ng-Passw0rd!';
const api = () => request(app);
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const login = async (email: string) => (await api().post('/api/v1/auth/login').send({ email, password: PW })).body.token as string;
const preflight = (origin: string) => api().options('/api/v1/auth/login').set('Origin', origin).set('Access-Control-Request-Method', 'POST').set('Access-Control-Request-Headers', 'authorization,content-type');
const allowed = async (origin: string) => (await preflight(origin)).headers['access-control-allow-origin'] === origin;

const S = { super: '', ops: '', owner: '', tenant: '', domainId: '' };

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri(), { dbName: 'cp_master' });
  const { hashPassword } = await import('../../src/core/modules/identity/infrastructure/security.js');
  const { User } = await import('../../src/core/modules/identity/infrastructure/user.model.js');
  app = (await import('../../src/app/app.js')).buildApp();
  const passwordHash = await hashPassword(PW);
  for (const [email, role] of [['super@d.test', 'superadmin'], ['ops@d.test', 'platform_ops']] as const) await User.create({ email, name: role, passwordHash, role, tenantId: null });
  S.super = await login('super@d.test');
  S.ops = await login('ops@d.test');
  S.tenant = (await api().post('/api/v1/platform/tenants').set(auth(S.super)).send({ name: 'Dom Org', slug: 'dom-org', ownerName: 'Owner', ownerEmail: 'owner@dom.test', ownerPassword: PW })).body.tenantId;
  S.owner = await login('owner@dom.test');
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod?.stop();
});

describe('server configuration', () => {
  it('the platform domain is allowed out of the box (PLATFORM_ORIGINS default), nothing else is', async () => {
    expect(await allowed('https://counsellor.jdinfotechsolutions.in')).toBe(true);
    expect(await allowed('https://evil.example')).toBe(false);
    expect(await allowed('https://counsellor.jdinfotechsolutions.in.evil.example')).toBe(false); // look-alike
    expect(await allowed('http://counsellor.jdinfotechsolutions.in')).toBe(false); // wrong scheme
  });
  it('the list shows the configured origins as read-only', async () => {
    const res = await api().get('/api/v1/platform/domains').set(auth(S.super));
    expect(res.status).toBe(200);
    expect(res.body.configured.map((c: any) => c.origin)).toContain('https://counsellor.jdinfotechsolutions.in');
  });
});

describe('who may manage domains', () => {
  it('only the super admin: ops and organisation owners get 403, anonymous 401', async () => {
    expect((await api().get('/api/v1/platform/domains').set(auth(S.ops))).status).toBe(403);
    expect((await api().post('/api/v1/platform/domains').set(auth(S.ops)).send({ origin: 'https://x.example.com' })).status).toBe(403);
    expect((await api().get('/api/v1/platform/domains').set(auth(S.owner))).status).toBe(403);
    expect((await api().get('/api/v1/platform/domains')).status).toBe(401);
  });
});

describe('adding a domain from the console', () => {
  it('a new domain is allowed immediately, without a restart', async () => {
    expect(await allowed('https://admin.newcollege.example')).toBe(false);
    const add = await api().post('/api/v1/platform/domains').set(auth(S.super)).send({ origin: 'Admin.NewCollege.example/', label: 'New College admin', kind: 'admin', tenantId: S.tenant, note: 'asked by owner' });
    expect(add.status).toBe(201);
    expect(add.body.origin).toBe('https://admin.newcollege.example');
    expect(add.body.tenantId).toBe(S.tenant);
    S.domainId = add.body.id;
    expect(await allowed('https://admin.newcollege.example')).toBe(true);
    expect((await preflight('https://admin.newcollege.example')).headers['access-control-allow-headers']?.toLowerCase()).toContain('authorization');
  });
  it('a duplicate, a domain already in server config and an unknown organisation are refused', async () => {
    expect((await api().post('/api/v1/platform/domains').set(auth(S.super)).send({ origin: 'https://admin.newcollege.example' })).status).toBe(409);
    expect((await api().post('/api/v1/platform/domains').set(auth(S.super)).send({ origin: 'https://counsellor.jdinfotechsolutions.in' })).status).toBe(409);
    expect((await api().post('/api/v1/platform/domains').set(auth(S.super)).send({ origin: 'https://ok.example.com', tenantId: 'a'.repeat(24) })).status).toBe(400);
  });
  it.each(['https://*.example.com', 'https://example.com/login', 'https://203.0.113.9', 'http://plain.example.com', 'https://user:p@example.com', 'javascript:alert(1)'])('refuses an unsafe entry: %s', async (origin) => {
    const res = await api().post('/api/v1/platform/domains').set(auth(S.super)).send({ origin });
    expect(res.status).toBe(400);
    expect(res.body.error.message.length).toBeGreaterThan(10);
  });
});

describe('disable, enable, remove', () => {
  it('disabling stops the domain at once; enabling brings it back', async () => {
    expect((await api().patch(`/api/v1/platform/domains/${S.domainId}`).set(auth(S.super)).send({ active: false })).status).toBe(200);
    expect(await allowed('https://admin.newcollege.example')).toBe(false);
    await api().patch(`/api/v1/platform/domains/${S.domainId}`).set(auth(S.super)).send({ active: true });
    expect(await allowed('https://admin.newcollege.example')).toBe(true);
  });
  it('removing deletes it and it stops working', async () => {
    expect((await api().delete(`/api/v1/platform/domains/${S.domainId}`).set(auth(S.super))).status).toBe(200);
    expect(await allowed('https://admin.newcollege.example')).toBe(false);
    expect((await api().delete(`/api/v1/platform/domains/${S.domainId}`).set(auth(S.super))).status).toBe(404);
    expect((await api().get('/api/v1/platform/domains').set(auth(S.super))).body.custom).toEqual([]);
  });
});

describe('audit', () => {
  it('every change is in the platform audit trail', async () => {
    const actions = (await api().get('/api/v1/platform/audit?limit=100').set(auth(S.super))).body.items.map((i: any) => i.action);
    for (const a of ['domain.added', 'domain.disabled', 'domain.enabled', 'domain.removed']) expect(actions).toContain(a);
  });
});
