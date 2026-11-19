import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * One story, top to bottom, exactly as an admin would live it:
 * superadmin -> organisation -> modules -> staff -> leads -> ledger -> revoke access -> audit.
 * Steps share state on purpose (like a real session), so they run in order.
 */
let mongod: MongoMemoryServer;
let app: import('express').Express;
let hashPassword: (s: string) => Promise<string>;
let User: typeof import('../../src/core/modules/identity/infrastructure/user.model.js').User;
let LedgerEntryModel: typeof import('../../src/product/modules/ledger/infrastructure/ledger.model.js').LedgerEntryModel;

const PW = 'Str0ng-Passw0rd!';
const api = () => request(app);
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const login = async (email: string, password = PW) => (await api().post('/api/v1/auth/login').send({ email, password })).body.token as string;

const S = {
  superToken: '', opsToken: '',
  tenantA: '', ownerA: '', ownerToken: '',
  tenantB: '', ownerBToken: '',
  counsellorId: '', counsellorToken: '', marketingToken: '',
  leadMine: '', leadOther: '',
  entryId: '',
};

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri(), { dbName: 'cp_master' });
  ({ hashPassword } = await import('../../src/core/modules/identity/infrastructure/security.js'));
  ({ User } = await import('../../src/core/modules/identity/infrastructure/user.model.js'));
  ({ LedgerEntryModel } = await import('../../src/product/modules/ledger/infrastructure/ledger.model.js'));
  app = (await import('../../src/app/app.js')).buildApp();

  const passwordHash = await hashPassword(PW);
  await User.create({ email: 'super@platform.test', name: 'Super', passwordHash, role: 'superadmin', tenantId: null });
  await User.create({ email: 'ops@platform.test', name: 'Ops', passwordHash, role: 'platform_ops', tenantId: null });
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod?.stop();
});

describe('1. platform staff', () => {
  it('logs in; wrong password and unknown email give the same 401', async () => {
    S.superToken = await login('super@platform.test');
    S.opsToken = await login('ops@platform.test');
    expect(S.superToken).toBeTruthy();
    const wrong = await api().post('/api/v1/auth/login').send({ email: 'super@platform.test', password: 'nope-nope-nope' });
    const unknown = await api().post('/api/v1/auth/login').send({ email: 'ghost@platform.test', password: 'nope-nope-nope' });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body.error.message).toBe(unknown.body.error.message);
  });

  it('/me describes the platform user', async () => {
    const me = (await api().get('/api/v1/me').set(auth(S.superToken))).body;
    expect(me.scope).toBe('platform');
    expect(me.modules).toBeNull();
    expect(me.permissions).toContain('platform:tenants:manage');
  });
});

describe('2. organisations', () => {
  it('creates two organisations; rejects duplicate slug and duplicate owner email', async () => {
    const mk = (name: string, slug: string, email: string) =>
      api().post('/api/v1/platform/tenants').set(auth(S.superToken)).send({ name, slug, ownerName: 'Owner', ownerEmail: email, ownerPassword: PW });
    const a = await mk('Alpha Counselling', 'alpha', 'owner@alpha.test');
    const b = await mk('Beta Counselling', 'beta', 'owner@beta.test');
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    S.tenantA = a.body.tenantId;
    S.tenantB = b.body.tenantId;
    expect((await mk('Dup', 'alpha', 'x@x.test')).status).toBe(409);
    expect((await mk('Dup2', 'gamma', 'owner@alpha.test')).status).toBe(409);
    S.ownerToken = await login('owner@alpha.test');
    S.ownerBToken = await login('owner@beta.test');
  });

  it('lists with paging, shows one, renames', async () => {
    const list = (await api().get('/api/v1/platform/tenants?limit=1').set(auth(S.superToken))).body;
    expect(list.total).toBe(2);
    expect(list.tenants).toHaveLength(1);
    const one = (await api().get(`/api/v1/platform/tenants/${S.tenantA}`).set(auth(S.superToken))).body;
    expect(one.staff.active).toBe(1);
    const renamed = await api().patch(`/api/v1/platform/tenants/${S.tenantA}`).set(auth(S.superToken)).send({ name: 'Alpha Education' });
    expect(renamed.body.name).toBe('Alpha Education');
  });

  it('an organisation owner cannot use platform endpoints', async () => {
    expect((await api().get('/api/v1/platform/tenants').set(auth(S.ownerToken))).status).toBe(403);
    expect((await api().get('/api/v1/platform/audit').set(auth(S.ownerToken))).status).toBe(403);
  });
});

describe('3. modules', () => {
  it('core on, add-ons off by default', async () => {
    const me = (await api().get('/api/v1/me').set(auth(S.ownerToken))).body;
    expect(me.modules.leads).toBe(true);
    expect(me.modules.ledger).toBe(false);
  });

  it('ledger is blocked until switched on', async () => {
    const res = await api().get('/api/v1/ledger/trial-balance').set(auth(S.ownerToken));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('MODULE_NOT_ENABLED');
  });

  it('platform ops can switch a module on; warns about unbuilt and dependency-blocked ones; core cannot be toggled', async () => {
    const ok = await api().patch(`/api/v1/platform/tenants/${S.tenantA}/modules`).set(auth(S.opsToken)).send({ modules: { ledger: true } });
    expect(ok.status).toBe(200);
    expect(ok.body.modules.ledger).toBe(true);
    const soon = await api().patch(`/api/v1/platform/tenants/${S.tenantA}/modules`).set(auth(S.opsToken)).send({ modules: { applications: true } });
    expect(soon.body.modules.applications).toBe(false); // needs students + colleges
    expect(soon.body.warnings.length).toBeGreaterThan(0);
    expect((await api().patch(`/api/v1/platform/tenants/${S.tenantA}/modules`).set(auth(S.opsToken)).send({ modules: { leads: false } })).status).toBe(400);
    expect((await api().patch(`/api/v1/platform/tenants/${S.tenantA}/modules`).set(auth(S.opsToken)).send({ modules: { bogus: true } })).status).toBe(400);
  });

  it('the switch is per organisation: B still has no ledger', async () => {
    expect((await api().get('/api/v1/ledger/trial-balance').set(auth(S.ownerBToken))).status).toBe(403);
  });
});

describe('4. staff and roles', () => {
  it('owner adds a counsellor and a marketing user; cannot add another owner', async () => {
    const add = (name: string, email: string, role: string) => api().post('/api/v1/team').set(auth(S.ownerToken)).send({ name, email, password: PW, role });
    const c = await add('Asha Counsellor', 'asha@alpha.test', 'counsellor');
    const m = await add('Mohit Marketing', 'mohit@alpha.test', 'marketing');
    expect(c.status).toBe(201);
    expect(m.status).toBe(201);
    S.counsellorId = c.body.id;
    expect((await add('Evil', 'evil@alpha.test', 'owner')).status).toBe(400);
    S.counsellorToken = await login('asha@alpha.test');
    S.marketingToken = await login('mohit@alpha.test');
  });

  it('a counsellor cannot manage the team', async () => {
    expect((await api().post('/api/v1/team').set(auth(S.counsellorToken)).send({ name: 'X Y', email: 'x@alpha.test', password: PW, role: 'sales' })).status).toBe(403);
  });
});

describe('5. leads', () => {
  const lead = (token: string, body: object) =>
    api().post('/api/v1/leads').set(auth(token)).send({ name: 'Rahul Sharma', source: { channel: 'website' }, consent: { given: true, source: 'web_form' }, ...body });

  it('creates a lead with a cleaned phone number; same number again is a duplicate, not a new lead', async () => {
    const first = await lead(S.ownerToken, { phone: '98765 43210', autoAssign: true });
    expect(first.status).toBe(201);
    expect(first.body.lead.phone).toBe('+919876543210');
    expect(first.body.lead.assignedTo).toBe(S.counsellorId); // only counsellor => gets it
    expect(first.body.lead.consent.given).toBe(true);
    S.leadMine = first.body.lead._id;
    const again = await lead(S.ownerToken, { phone: '+91-98765-43210' });
    expect(again.status).toBe(200);
    expect(again.body.duplicate).toBe(true);
    const other = await lead(S.ownerToken, { name: 'Priya Singh', phone: '9123456780' });
    S.leadOther = other.body.lead._id;
  });

  it('rejects bad phone numbers and missing consent', async () => {
    expect((await lead(S.ownerToken, { phone: '12345' })).status).toBe(400);
    const noConsent = await api().post('/api/v1/leads').set(auth(S.ownerToken)).send({ name: 'No Consent', phone: '9000000001', source: { channel: 'website' } });
    expect(noConsent.status).toBe(400);
  });

  it('stage rules: cannot skip steps; allowed move works and is recorded', async () => {
    const skip = await api().patch(`/api/v1/leads/${S.leadMine}/stage`).set(auth(S.ownerToken)).send({ stage: 'admitted' });
    expect(skip.status).toBe(400);
    const ok = await api().patch(`/api/v1/leads/${S.leadMine}/stage`).set(auth(S.ownerToken)).send({ stage: 'contacted', note: 'called, will visit' });
    expect(ok.body.stage).toBe('contacted');
    const detail = (await api().get(`/api/v1/leads/${S.leadMine}`).set(auth(S.ownerToken))).body;
    expect(detail.stageHistory).toHaveLength(1);
    expect(detail.allowedNextStages).toContain('qualified');
  });

  it('role limits: marketing can read but not edit; counsellor sees only their own leads', async () => {
    expect((await api().get('/api/v1/leads').set(auth(S.marketingToken))).status).toBe(200);
    expect((await api().patch(`/api/v1/leads/${S.leadMine}/stage`).set(auth(S.marketingToken)).send({ stage: 'qualified' })).status).toBe(403);
    const mine = (await api().get('/api/v1/leads').set(auth(S.counsellorToken))).body;
    expect(mine.total).toBe(1);
    expect(mine.items[0]._id).toBe(S.leadMine);
    expect((await api().get(`/api/v1/leads/${S.leadOther}`).set(auth(S.counsellorToken))).status).toBe(404);
  });

  it('organisations are isolated: B sees nothing of A, and the same phone is allowed in B', async () => {
    expect((await api().get('/api/v1/leads').set(auth(S.ownerBToken))).body.total).toBe(0);
    expect((await api().get(`/api/v1/leads/${S.leadMine}`).set(auth(S.ownerBToken))).status).toBe(404);
    const sameInB = await lead(S.ownerBToken, { phone: '9876543210' });
    expect(sameInB.status).toBe(201);
  });
});

describe('6. ledger', () => {
  const lines = [
    { account: 'bank:main', debit: 500_000, credit: 0 },
    { account: 'student:s1', debit: 0, credit: 500_000 },
  ];
  const post = (token: string, body: object) => api().post('/api/v1/ledger/entries').set(auth(token)).send(body);

  it('posts a balanced entry; the same idempotency key never double-posts', async () => {
    const a = await post(S.ownerToken, { idempotencyKey: 'fee-0001-abc', reference: 'FEE-0001', lines });
    expect(a.status).toBe(201);
    S.entryId = a.body.entry._id;
    const b = await post(S.ownerToken, { idempotencyKey: 'fee-0001-abc', reference: 'FEE-0001', lines });
    expect(b.status).toBe(200);
    expect(b.body.replayed).toBe(true);
    expect(b.body.entry._id).toBe(S.entryId);
    const bal = (await api().get('/api/v1/ledger/balance?account=student:s1').set(auth(S.ownerToken))).body;
    expect(bal.netPaise).toBe(-500_000); // not -1,000,000
  });

  it('rejects unbalanced, fractional and malformed entries', async () => {
    expect((await post(S.ownerToken, { idempotencyKey: 'bad-0001-aaa', reference: 'X', lines: [lines[0], { account: 'student:s1', debit: 0, credit: 499_999 }] })).status).toBe(400);
    expect((await post(S.ownerToken, { idempotencyKey: 'bad-0002-aaa', reference: 'X', lines: [{ account: 'bank:main', debit: 10.5, credit: 0 }, { account: 'student:s1', debit: 0, credit: 10.5 }] })).status).toBe(400);
    expect((await post(S.ownerToken, { idempotencyKey: 'bad-0003-aaa', reference: 'X', lines: [{ account: 'hacker:1', debit: 5, credit: 0 }, { account: 'student:s1', debit: 0, credit: 5 }] })).status).toBe(400);
  });

  it('a counsellor cannot post or read the ledger', async () => {
    expect((await post(S.counsellorToken, { idempotencyKey: 'c-0001-aaaa', reference: 'X', lines })).status).toBe(403);
    expect((await api().get('/api/v1/ledger/trial-balance').set(auth(S.counsellorToken))).status).toBe(403);
  });

  it('entries are immutable at the database layer', async () => {
    const Entry = LedgerEntryModel(S.tenantA);
    await expect(Entry.updateOne({ _id: S.entryId }, { reference: 'HACKED' })).rejects.toThrow(/immutable/i);
    await expect(Entry.deleteOne({ _id: S.entryId })).rejects.toThrow(/immutable/i);
  });

  it('reversal cancels the entry; cannot be reversed twice; trial balance stays balanced', async () => {
    const rev = await api().post(`/api/v1/ledger/entries/${S.entryId}/reverse`).set(auth(S.ownerToken)).send({ idempotencyKey: 'rev-0001-aaa', reason: 'wrong student' });
    expect(rev.status).toBe(201);
    const again = await api().post(`/api/v1/ledger/entries/${S.entryId}/reverse`).set(auth(S.ownerToken)).send({ idempotencyKey: 'rev-0002-aaa', reason: 'again' });
    expect(again.status).toBe(409);
    expect((await api().get('/api/v1/ledger/balance?account=student:s1').set(auth(S.ownerToken))).body.netPaise).toBe(0);
    const tb = (await api().get('/api/v1/ledger/trial-balance').set(auth(S.ownerToken))).body;
    expect(tb.isBalanced).toBe(true);
  });
});

describe('7. staff access control', () => {
  it('owner sees everyone incl. blocked; changes a role; cannot touch the owner', async () => {
    const team = (await api().get('/api/v1/team').set(auth(S.ownerToken))).body.team;
    expect(team).toHaveLength(3);
    const ownerRow = team.find((u: any) => u.role === 'owner');
    expect((await api().patch(`/api/v1/team/${ownerRow.id}/role`).set(auth(S.ownerToken)).send({ role: 'sales' })).status).toBe(400);
    expect((await api().patch(`/api/v1/team/${ownerRow.id}/status`).set(auth(S.ownerToken)).send({ status: 'blocked' })).status).toBe(400);
    const changed = await api().patch(`/api/v1/team/${S.counsellorId}/role`).set(auth(S.ownerToken)).send({ role: 'sales' });
    expect(changed.body.role).toBe('sales');
    // role change is live: the sales role now sees ALL leads, not only assigned ones
    expect((await api().get('/api/v1/leads').set(auth(S.counsellorToken))).body.total).toBe(2);
    await api().patch(`/api/v1/team/${S.counsellorId}/role`).set(auth(S.ownerToken)).send({ role: 'counsellor' });
  });

  it('password reset ends the person\'s old session at once; they can log in with the new password', async () => {
    const reset = await api().post(`/api/v1/team/${S.counsellorId}/reset-password`).set(auth(S.ownerToken)).send({ newPassword: 'Brand-New-Pass-123' });
    expect(reset.body.sessionsEnded).toBe(true);
    expect((await api().get('/api/v1/me').set(auth(S.counsellorToken))).status).toBe(401);
    expect(await login('asha@alpha.test', 'Brand-New-Pass-123')).toBeTruthy();
    expect((await api().post('/api/v1/auth/login').send({ email: 'asha@alpha.test', password: PW })).status).toBe(401);
  });

  it('own password change: needs the current password, ends other sessions, returns a working token', async () => {
    const t1 = await login('mohit@alpha.test');
    const bad = await api().post('/api/v1/auth/change-password').set(auth(t1)).send({ currentPassword: 'wrong-wrong-wrong', newPassword: 'Another-Pass-9999' });
    expect(bad.status).toBe(401);
    const ok = await api().post('/api/v1/auth/change-password').set(auth(t1)).send({ currentPassword: PW, newPassword: 'Another-Pass-9999' });
    expect(ok.status).toBe(200);
    expect((await api().get('/api/v1/me').set(auth(t1))).status).toBe(401); // old token dead
    expect((await api().get('/api/v1/me').set(auth(ok.body.token))).status).toBe(200); // new token works
  });

  it('log out everywhere kills existing tokens', async () => {
    const t = await login('mohit@alpha.test', 'Another-Pass-9999');
    expect((await api().post('/api/v1/auth/logout-all').set(auth(t))).status).toBe(200);
    expect((await api().get('/api/v1/me').set(auth(t))).status).toBe(401);
  });

  it('blocking a person takes effect on their very next request', async () => {
    const t = await login('asha@alpha.test', 'Brand-New-Pass-123');
    expect((await api().get('/api/v1/me').set(auth(t))).status).toBe(200);
    await api().patch(`/api/v1/team/${S.counsellorId}/status`).set(auth(S.ownerToken)).send({ status: 'blocked' });
    expect((await api().get('/api/v1/me').set(auth(t))).status).toBe(401);
    expect((await api().post('/api/v1/auth/login').send({ email: 'asha@alpha.test', password: 'Brand-New-Pass-123' })).status).toBe(401);
  });

  it('suspending an organisation locks everyone out; reactivating restores access', async () => {
    await api().patch(`/api/v1/platform/tenants/${S.tenantA}/status`).set(auth(S.opsToken)).send({ status: 'suspended' });
    expect((await api().get('/api/v1/me').set(auth(S.ownerToken))).status).toBe(403);
    expect((await api().post('/api/v1/auth/login').send({ email: 'owner@alpha.test', password: PW })).status).toBe(403);
    await api().patch(`/api/v1/platform/tenants/${S.tenantA}/status`).set(auth(S.opsToken)).send({ status: 'active' });
    expect((await api().get('/api/v1/me').set(auth(S.ownerToken))).status).toBe(200);
  });
});

describe('8. audit trails', () => {
  it('platform audit recorded who did what to organisations, modules and people', async () => {
    const all = (await api().get(`/api/v1/platform/audit?tenantId=${S.tenantA}&limit=100`).set(auth(S.superToken))).body.items.map((i: any) => i.action);
    for (const a of ['tenant.created', 'tenant.renamed', 'tenant.modules_changed', 'user.created', 'user.role_changed', 'user.password_reset', 'user.password_changed', 'user.blocked', 'tenant.suspended', 'tenant.reactivated']) {
      expect(all).toContain(a);
    }
    const first = (await api().get('/api/v1/platform/audit?limit=1').set(auth(S.superToken))).body.items[0];
    expect(first.actorId).toBeTruthy();
    expect(first.requestId).toBeTruthy();
  });

  it('organisation audit recorded lead and ledger actions', async () => {
    const actions = (await api().get('/api/v1/audit?limit=100').set(auth(S.ownerToken))).body.items.map((i: any) => i.action);
    for (const a of ['lead.created', 'lead.duplicate_enquiry', 'lead.stage_changed', 'ledger.posted', 'ledger.reversed']) expect(actions).toContain(a);
    expect((await api().get('/api/v1/audit').set(auth(S.marketingToken))).status).toBe(401); // marketing token was revoked above
  });
});
