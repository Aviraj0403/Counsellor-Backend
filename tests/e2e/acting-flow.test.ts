import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/** Platform staff acting inside an organisation (x-acting-tenant): scope, guard-rails, audit, logo. See docs/adr/0004. */
let mongod: MongoMemoryServer;
let app: import('express').Express;
const PW = 'Str0ng-Passw0rd!';
const api = () => request(app);
const H = 'x-acting-tenant';
const auth = (t: string, acting?: string) => ({ Authorization: `Bearer ${t}`, ...(acting ? { [H]: acting } : {}) });
const login = async (email: string) => (await api().post('/api/v1/auth/login').send({ email, password: PW })).body.token as string;
const S = { super: '', ops: '', ownerA: '', ownerB: '', a: '', b: '', superId: '', studentA: '' };

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri(), { dbName: 'cp_master' });
  const { hashPassword } = await import('../../src/core/modules/identity/infrastructure/security.js');
  const { User } = await import('../../src/core/modules/identity/infrastructure/user.model.js');
  app = (await import('../../src/app/app.js')).buildApp();
  const sup = await User.create({ email: 'super@p.test', name: 'Super Person', passwordHash: await hashPassword(PW), role: 'superadmin', tenantId: null });
  S.superId = String(sup._id);
  await User.create({ email: 'ops@p.test', name: 'Ops', passwordHash: await hashPassword(PW), role: 'platform_ops', tenantId: null });
  S.super = await login('super@p.test');
  S.ops = await login('ops@p.test');
  const mk = async (name: string, slug: string, email: string) =>
    (await api().post('/api/v1/platform/tenants').set(auth(S.super)).send({ name, slug, ownerName: 'Owner', ownerEmail: email, ownerPassword: PW })).body.tenantId as string;
  S.a = await mk('Alpha Acting', 'alpha-act', 'owner@alpha-act.test');
  S.b = await mk('Beta Acting', 'beta-act', 'owner@beta-act.test');
  const on = { students: true, colleges: true, ledger: true, commissions: true, documents: true };
  for (const id of [S.a, S.b]) expect((await api().patch(`/api/v1/platform/tenants/${id}/modules`).set(auth(S.super)).send({ modules: on })).status).toBe(200);
  S.ownerA = await login('owner@alpha-act.test');
  S.ownerB = await login('owner@beta-act.test');
  const lead = (t: string, name: string, phone: string) => api().post('/api/v1/leads').set(auth(t)).send({ name, phone, source: { channel: 'website' }, consent: { given: true, source: 'web' } });
  expect((await lead(S.ownerA, 'Alpha Leadperson', '9811100001')).status).toBe(201);
  expect((await lead(S.ownerB, 'Beta Leadperson', '9811100002')).status).toBe(201);
  const st = await api().post('/api/v1/students').set(auth(S.ownerA)).send({ name: 'Alpha Student', phone: '9811100003', dob: '2000-01-01', consent: { given: true, source: 'office' } });
  expect(st.status).toBe(201);
  S.studentA = st.body._id ?? st.body.id;
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod?.stop();
});

describe('who may act', () => {
  it('superadmin sees organisation A (and only A) data through the normal tenant routes', async () => {
    const leads = await api().get('/api/v1/leads').set(auth(S.super, S.a));
    expect(leads.status).toBe(200);
    expect(JSON.stringify(leads.body)).toContain('Alpha Leadperson');
    expect(JSON.stringify(leads.body)).not.toContain('Beta Leadperson');
    expect(JSON.stringify((await api().get('/api/v1/students').set(auth(S.super, S.a))).body)).toContain('Alpha Student');
    const b = await api().get('/api/v1/leads').set(auth(S.super, S.b));
    expect(JSON.stringify(b.body)).toContain('Beta Leadperson');
    expect(JSON.stringify(b.body)).not.toContain('Alpha Leadperson');
  });
  it('without the header a platform user still cannot use tenant routes', async () => {
    expect((await api().get('/api/v1/leads').set(auth(S.super))).status).toBe(403);
  });
  it('platform_ops and organisation users are refused (403), and the refusal is audited', async () => {
    expect((await api().get('/api/v1/leads').set(auth(S.ops, S.a))).status).toBe(403);
    expect((await api().get('/api/v1/me').set(auth(S.ops, S.a))).status).toBe(403);
    expect((await api().get('/api/v1/leads').set(auth(S.ownerA, S.b))).status).toBe(403);
    const audit = await api().get('/api/v1/platform/audit?limit=100').set(auth(S.super));
    expect(audit.body.items.filter((i: any) => i.action === 'tenant.acting_denied').length).toBeGreaterThanOrEqual(3);
  });
  it('unknown or malformed organisation id: 404', async () => {
    expect((await api().get('/api/v1/leads').set(auth(S.super, 'a'.repeat(24)))).status).toBe(404);
    expect((await api().get('/api/v1/leads').set(auth(S.super, 'not-an-id')))).toMatchObject({ status: 404 });
  });
  it('a suspended organisation can still be acted in, and /me says so', async () => {
    expect((await api().patch(`/api/v1/platform/tenants/${S.b}/status`).set(auth(S.super)).send({ status: 'suspended' })).status).toBe(200);
    const me = await api().get('/api/v1/me').set(auth(S.super, S.b));
    expect(me.status).toBe(200);
    expect(me.body.organisation.status).toBe('suspended');
    expect((await api().get('/api/v1/leads').set(auth(S.super, S.b))).status).toBe(200);
    expect((await api().patch(`/api/v1/platform/tenants/${S.b}/status`).set(auth(S.super)).send({ status: 'active' })).status).toBe(200);
  });
});

describe('/me while acting', () => {
  it('returns the tenant-style payload plus actingAs and platformUser; unchanged without the header', async () => {
    const me = (await api().get('/api/v1/me').set(auth(S.super, S.a))).body;
    expect(me.scope).toBe('tenant');
    expect(me.tenantId).toBe(S.a);
    expect(me.user).toMatchObject({ id: S.superId, role: 'platform_support' });
    expect(me.actingAs).toEqual({ tenantId: S.a, tenantName: 'Alpha Acting', byUserId: S.superId });
    expect(me.platformUser).toEqual({ name: 'Super Person', email: 'super@p.test' });
    expect(me.organisation).toMatchObject({ id: S.a, name: 'Alpha Acting', logoUrl: null });
    expect(me.modules.students).toBe(true);
    expect(me.permissions).toContain('leads:read');
    expect(me.permissions.filter((p: string) => p.startsWith('platform:'))).toEqual([]);
    const plain = (await api().get('/api/v1/me').set(auth(S.super))).body;
    expect(plain.scope).toBe('platform');
    expect(plain.actingAs).toBeUndefined();
    expect(plain.tenantId).toBeNull();
    expect(plain.permissions).toContain('platform:tenants:impersonate');
  });
});

describe('guard-rails: what acting staff can not do', () => {
  it('no erase, export, team invite, document download, ledger post or commission change', async () => {
    const h = auth(S.super, S.a);
    expect((await api().post(`/api/v1/students/${S.studentA}/erase`).set(h).send({ confirm: 'ERASE', reason: 'test reason' })).status).toBe(403);
    expect((await api().get(`/api/v1/students/${S.studentA}/export`).set(h)).status).toBe(403);
    expect((await api().post('/api/v1/team').set(h).send({ name: 'Mallory', email: 'm@alpha-act.test', password: PW, role: 'counsellor' })).status).toBe(403);
    expect((await api().post(`/api/v1/documents/${'a'.repeat(24)}/download-link`).set(h).send({})).status).toBe(403);
    expect((await api().post('/api/v1/ledger/entries').set(h).send({})).status).toBe(403);
    expect((await api().post('/api/v1/commissions/rules').set(h).send({})).status).toBe(403);
    expect((await api().patch('/api/v1/organisation/profile').set(h).send({ logoUrl: 'https://x.example/l.png' })).status).toBe(403);
  });
  it('the same actions work for the real owner (so the 403 above is the acting set, not a broken route)', async () => {
    expect((await api().get(`/api/v1/students/${S.studentA}/export`).set(auth(S.ownerA))).status).toBe(200);
  });
  it('day-to-day writes are allowed', async () => {
    const r = await api().post('/api/v1/leads').set(auth(S.super, S.a)).send({ name: 'Added By Support', phone: '9811100009', source: { channel: 'website' }, consent: { given: true, source: 'web' } });
    expect(r.status).toBe(201);
  });
});

describe('platform routes and /auth routes with the header', () => {
  it('platform routes keep the original platform permissions', async () => {
    expect((await api().get('/api/v1/platform/tenants').set(auth(S.super, S.a))).status).toBe(200);
    expect((await api().get(`/api/v1/platform/tenants/${S.a}/workspace`).set(auth(S.super, S.a))).status).toBe(200);
    expect((await api().get('/api/v1/platform/audit').set(auth(S.super, S.a))).status).toBe(200);
  });
  it('/auth routes ignore the header (even a bad one) and act on the real user', async () => {
    const r = await api().post('/api/v1/auth/mfa/setup').set(auth(S.super, 'garbage'));
    expect(r.status).toBe(200); // a bad id would be 404 if the header had been honoured
    expect((await api().post('/api/v1/auth/change-password').set(auth(S.super, S.a)).send({ currentPassword: 'wrong-wrong-1', newPassword: 'Another-Passw0rd!' })).status).toBe(401);
    expect((await api().post('/api/v1/auth/login').set(H, S.a).send({ email: 'super@p.test', password: PW })).body.user.role).toBe('superadmin');
  });
});

describe('audit', () => {
  it('start writes a platform audit row (needs the permission; ops is refused)', async () => {
    expect((await api().post(`/api/v1/platform/tenants/${S.a}/acting/start`).set(auth(S.ops)).send({})).status).toBe(403);
    expect((await api().post(`/api/v1/platform/tenants/${'a'.repeat(24)}/acting/start`).set(auth(S.super)).send({})).status).toBe(404);
    const r = await api().post(`/api/v1/platform/tenants/${S.a}/acting/start`).set(auth(S.super)).send({ reason: 'Customer asked for help with import' });
    expect(r.status).toBe(200);
    expect(r.body.tenant).toEqual({ id: S.a, name: 'Alpha Acting', slug: 'alpha-act', logoUrl: null, status: 'active' });
    const audit = await api().get(`/api/v1/platform/audit?tenantId=${S.a}`).set(auth(S.super));
    const row = audit.body.items.find((i: any) => i.action === 'tenant.acting_started');
    expect(row).toMatchObject({ actorId: S.superId, tenantId: S.a, meta: { reason: 'Customer asked for help with import' } });
  });
  it("every write and blocked attempt is in THAT organisation's audit with actingAs; reads are not", async () => {
    const items = (await api().get('/api/v1/audit?limit=100').set(auth(S.ownerA))).body.items as any[];
    const writes = items.filter((i) => i.action === 'acting.write');
    expect(writes.length).toBeGreaterThan(0);
    for (const w of writes) expect(w).toMatchObject({ actorId: S.superId, actingAs: true, entity: 'request' });
    expect(writes.some((w) => w.meta.method === 'POST' && w.meta.path === '/api/v1/leads' && w.meta.status === 201)).toBe(true);
    const blocked = items.filter((i) => i.action === 'acting.blocked');
    expect(blocked.some((w) => w.meta.path === `/api/v1/students/${S.studentA}/erase`)).toBe(true);
    expect(items.some((i) => i.action === 'acting.write' && i.meta.method === 'GET')).toBe(false);
    // the domain audit row of the lead the staff member created is stamped too
    const created = items.find((i) => i.action === 'lead.created' && i.actorId === S.superId);
    expect(created?.actingAs).toBe(true);
    // and none of it leaked into organisation B
    const b = (await api().get('/api/v1/audit?limit=100').set(auth(S.ownerB))).body.items as any[];
    expect(b.some((i) => i.actingAs)).toBe(false);
  });
});

describe('organisation logo', () => {
  it('platform sets, validates, clears; value shows in list, workspace and /me', async () => {
    const url = 'https://cdn.example.com/alpha.png';
    const set = await api().patch(`/api/v1/platform/tenants/${S.a}`).set(auth(S.super)).send({ logoUrl: url, brandColor: '#1A2B3C' });
    expect(set.status).toBe(200);
    expect(set.body).toMatchObject({ logoUrl: url, brandColor: '#1A2B3C', name: 'Alpha Acting' });
    for (const bad of ['http://x.example/l.png', 'javascript:alert(1)', 'https://x.example/' + 'a'.repeat(500), 'nope']) {
      expect((await api().patch(`/api/v1/platform/tenants/${S.a}`).set(auth(S.super)).send({ logoUrl: bad })).status).toBe(400);
    }
    expect((await api().patch(`/api/v1/platform/tenants/${S.a}`).set(auth(S.super)).send({ brandColor: 'red' })).status).toBe(400);
    expect((await api().patch(`/api/v1/platform/tenants/${S.a}`).set(auth(S.super)).send({})).status).toBe(400);
    expect((await api().patch(`/api/v1/platform/tenants/${S.a}`).set(auth(S.ops)).send({ name: 'Alpha Renamed' })).status).toBe(200); // rename route still works
    await api().patch(`/api/v1/platform/tenants/${S.a}`).set(auth(S.ops)).send({ name: 'Alpha Acting' });
    const list = (await api().get('/api/v1/platform/tenants').set(auth(S.super))).body.tenants.find((t: any) => t.id === S.a);
    expect(list.logoUrl).toBe(url);
    expect((await api().get(`/api/v1/platform/tenants/${S.a}/workspace`).set(auth(S.super))).body.organisation.logoUrl).toBe(url);
    expect((await api().get('/api/v1/me').set(auth(S.ownerA))).body.organisation.logoUrl).toBe(url);
    expect((await api().get('/api/v1/me').set(auth(S.super, S.a))).body.organisation.logoUrl).toBe(url);
  });
  it('the owner sets their own logo; others cannot', async () => {
    const r = await api().patch('/api/v1/organisation/profile').set(auth(S.ownerB)).send({ logoUrl: 'https://cdn.example.com/beta.webp', brandColor: '#00ff00' });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ logoUrl: 'https://cdn.example.com/beta.webp', brandColor: '#00ff00' });
    expect((await api().patch('/api/v1/organisation/profile').set(auth(S.ownerB)).send({ logoUrl: 'http://insecure.example/x.png' })).status).toBe(400);
    expect((await api().patch('/api/v1/organisation/profile').set(auth(S.ownerB)).send({ logoUrl: null })).body.logoUrl).toBeNull();
    expect((await api().patch('/api/v1/organisation/profile').set(auth(S.super)).send({ logoUrl: 'https://x.example/l.png' })).status).toBe(403);
  });
});

describe('token revoke still works', () => {
  it('logout-all ends the superadmin token, with or without the header', async () => {
    const t = await login('super@p.test');
    expect((await api().get('/api/v1/leads').set(auth(t, S.a))).status).toBe(200);
    expect((await api().post('/api/v1/auth/logout-all').set(auth(t, S.a))).status).toBe(200);
    expect((await api().get('/api/v1/leads').set(auth(t, S.a))).status).toBe(401);
    expect((await api().get('/api/v1/me').set(auth(t))).status).toBe(401);
  });
});
