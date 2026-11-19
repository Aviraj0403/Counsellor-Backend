import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Finance and research story: plan -> pricing -> staff limit -> invoice -> costs -> dashboard -> research -> ledger list.
 * Numbers are asserted exactly (integer paise), because this is the part where being "roughly right" is wrong.
 */
let mongod: MongoMemoryServer;
let app: import('express').Express;

const PW = 'Str0ng-Passw0rd!';
const PERIOD = '2026-11';
const api = () => request(app);
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const login = async (email: string, password = PW) => (await api().post('/api/v1/auth/login').send({ email, password })).body.token as string;

const S = { super: '', finance: '', ops: '', tenant: '', owner: '', tenant2: '', owner2: '', planId: '', invoiceId: '', entryId: '', costId: '' };

// ledger catalogue price (INR) is read from the live catalogue so the test never drifts from it
let LEDGER_PAISE = 0;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri(), { dbName: 'cp_master' });
  const { hashPassword } = await import('../../src/core/modules/identity/infrastructure/security.js');
  const { User } = await import('../../src/core/modules/identity/infrastructure/user.model.js');
  const { MODULE_CATALOG } = await import('../../src/core/modules/catalog/domain/moduleCatalog.js');
  LEDGER_PAISE = MODULE_CATALOG.find((m) => m.key === 'ledger')!.priceMonthlyInr! * 100;
  app = (await import('../../src/app/app.js')).buildApp();

  const passwordHash = await hashPassword(PW);
  for (const [email, role] of [['super@p.test', 'superadmin'], ['fin@p.test', 'platform_finance'], ['ops@p.test', 'platform_ops']] as const) {
    await User.create({ email, name: role, passwordHash, role, tenantId: null });
  }
  S.super = await login('super@p.test');
  S.finance = await login('fin@p.test');
  S.ops = await login('ops@p.test');

  const mk = async (name: string, slug: string, email: string) =>
    (await api().post('/api/v1/platform/tenants').set(auth(S.super)).send({ name, slug, ownerName: 'Owner', ownerEmail: email, ownerPassword: PW })).body.tenantId as string;
  S.tenant = await mk('Gamma Counselling', 'gamma', 'owner@gamma.test');
  S.tenant2 = await mk('Delta Counselling', 'delta', 'owner@delta.test');
  S.owner = await login('owner@gamma.test');
  S.owner2 = await login('owner@delta.test');
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod?.stop();
});

describe('1. who may see money', () => {
  it('ops can do research but not billing, costs or the financial dashboard', async () => {
    expect((await api().get('/api/v1/platform/dashboard').set(auth(S.ops))).status).toBe(403);
    expect((await api().get('/api/v1/platform/plans').set(auth(S.ops))).status).toBe(403);
    expect((await api().get('/api/v1/platform/costs').set(auth(S.ops))).status).toBe(403);
    expect((await api().get('/api/v1/platform/insights/usage').set(auth(S.ops))).status).toBe(200);
  });
  it('an organisation owner can see none of the platform screens', async () => {
    for (const path of ['/platform/dashboard', '/platform/plans', '/platform/costs', '/platform/invoices', '/platform/insights/funnel']) {
      expect((await api().get(`/api/v1${path}`).set(auth(S.owner))).status).toBe(403);
    }
  });
});

describe('2. plans', () => {
  it('creates a plan; rejects a core/unknown module and a duplicate key', async () => {
    const ok = await api().post('/api/v1/platform/plans').set(auth(S.finance)).send({ key: 'starter', name: 'Starter', basePricePaise: 199_900, includedModules: [], maxStaff: 2 });
    expect(ok.status).toBe(201);
    S.planId = ok.body.id;
    const bad = (m: string) => api().post('/api/v1/platform/plans').set(auth(S.finance)).send({ key: 'bad', name: 'Bad', basePricePaise: 1, includedModules: [m] });
    expect((await bad('leads')).status).toBe(400); // core
    expect((await bad('nope')).status).toBe(400); // unknown
    expect((await api().post('/api/v1/platform/plans').set(auth(S.finance)).send({ key: 'starter', name: 'Dup', basePricePaise: 1 })).status).toBe(409);
  });
  it('rejects a fractional or negative price', async () => {
    const r = (basePricePaise: number) => api().post('/api/v1/platform/plans').set(auth(S.finance)).send({ key: 'x1', name: 'X1', basePricePaise });
    expect((await r(10.5)).status).toBe(400);
    expect((await r(-1)).status).toBe(400);
  });
});

describe('3. pricing an organisation', () => {
  it('assign plan + switch ledger on: preview shows exact lines, GST and total', async () => {
    expect((await api().patch(`/api/v1/platform/tenants/${S.tenant}/plan`).set(auth(S.finance)).send({ planKey: 'ghost' })).status).toBe(400);
    expect((await api().patch(`/api/v1/platform/tenants/${S.tenant}/plan`).set(auth(S.finance)).send({ planKey: 'starter' })).status).toBe(200);
    await api().patch(`/api/v1/platform/tenants/${S.tenant}/modules`).set(auth(S.ops)).send({ modules: { ledger: true } });
    const view = (await api().get(`/api/v1/platform/tenants/${S.tenant}/billing`).set(auth(S.finance))).body;
    const subtotal = 199_900 + LEDGER_PAISE;
    expect(view.currentCharge.lines.map((l: any) => l.code)).toEqual(['plan', 'module:ledger']);
    expect(view.currentCharge.subtotalPaise).toBe(subtotal);
    expect(view.currentCharge.gstPaise).toBe(Math.round(subtotal * 0.18));
    expect(view.currentCharge.totalPaise).toBe(subtotal + Math.round(subtotal * 0.18));
  });
  it('a negotiated price replaces the list price and can be removed again', async () => {
    await api().patch(`/api/v1/platform/tenants/${S.tenant}/pricing`).set(auth(S.finance)).send({ priceOverrides: { ledger: 499 } });
    expect((await api().get(`/api/v1/platform/tenants/${S.tenant}/billing`).set(auth(S.finance))).body.currentCharge.subtotalPaise).toBe(199_900 + 49_900);
    await api().patch(`/api/v1/platform/tenants/${S.tenant}/pricing`).set(auth(S.finance)).send({ priceOverrides: { ledger: null } });
    expect((await api().get(`/api/v1/platform/tenants/${S.tenant}/billing`).set(auth(S.finance))).body.currentCharge.subtotalPaise).toBe(199_900 + LEDGER_PAISE);
    expect((await api().patch(`/api/v1/platform/tenants/${S.tenant}/pricing`).set(auth(S.finance)).send({ priceOverrides: { leads: 5 } })).status).toBe(400); // core is not priced
  });
});

describe('4. plan limit on staff', () => {
  const add = (email: string) => api().post('/api/v1/team').set(auth(S.owner)).send({ name: 'Staff Member', email, password: PW, role: 'support' });
  let secondId = '';

  it('plan allows 2 active accounts: owner + one more; the third is refused with a clear message', async () => {
    const second = await add('s1@gamma.test');
    expect(second.status).toBe(201);
    secondId = second.body.id;
    const third = await add('s2@gamma.test');
    expect(third.status).toBe(403);
    expect(third.body.error.code).toBe('PLAN_LIMIT');
    expect(third.body.error.message).toMatch(/Starter/);
  });
  it('blocking frees a seat; unblocking needs a free seat again', async () => {
    await api().patch(`/api/v1/team/${secondId}/status`).set(auth(S.owner)).send({ status: 'blocked' });
    const third = await add('s2@gamma.test');
    expect(third.status).toBe(201);
    const unblock = await api().patch(`/api/v1/team/${secondId}/status`).set(auth(S.owner)).send({ status: 'active' });
    expect(unblock.status).toBe(403);
    expect(unblock.body.error.code).toBe('PLAN_LIMIT');
  });
  it('an organisation without a plan has no limit', async () => {
    for (const n of [1, 2, 3, 4]) {
      const r = await api().post('/api/v1/team').set(auth(S.owner2)).send({ name: 'Staff Member', email: `d${n}@delta.test`, password: PW, role: 'support' });
      expect(r.status).toBe(201);
    }
  });
});

describe('5. invoices', () => {
  it('issues an invoice that snapshots the charge; numbering is sequential; one per month', async () => {
    const inv = await api().post(`/api/v1/platform/tenants/${S.tenant}/invoices`).set(auth(S.finance)).send({ period: PERIOD });
    expect(inv.status).toBe(201);
    S.invoiceId = inv.body.id;
    expect(inv.body.invoiceNo).toMatch(/^CP-\d{4}-0001$/);
    expect(inv.body.subtotalPaise).toBe(199_900 + LEDGER_PAISE);
    expect(inv.body.totalPaise).toBe(inv.body.subtotalPaise + inv.body.gstPaise);
    expect(inv.body.status).toBe('issued');
    expect((await api().post(`/api/v1/platform/tenants/${S.tenant}/invoices`).set(auth(S.finance)).send({ period: PERIOD })).status).toBe(409);
    expect((await api().post(`/api/v1/platform/tenants/${S.tenant}/invoices`).set(auth(S.finance)).send({ period: '2026-13' })).status).toBe(400);
  });
  it('an organisation with nothing priced cannot be invoiced', async () => {
    const r = await api().post(`/api/v1/platform/tenants/${S.tenant2}/invoices`).set(auth(S.finance)).send({ period: PERIOD });
    expect(r.status).toBe(400);
    expect(r.body.error.message).toMatch(/Nothing to bill/);
  });
  it('later price changes do not rewrite an issued invoice', async () => {
    await api().patch(`/api/v1/platform/tenants/${S.tenant}/pricing`).set(auth(S.finance)).send({ priceOverrides: { ledger: 100 } });
    const list = (await api().get(`/api/v1/platform/invoices?period=${PERIOD}`).set(auth(S.finance))).body;
    expect(list.items[0].subtotalPaise).toBe(199_900 + LEDGER_PAISE);
    await api().patch(`/api/v1/platform/tenants/${S.tenant}/pricing`).set(auth(S.finance)).send({ priceOverrides: { ledger: null } });
  });
  it('mark paid once; paid or void invoices cannot change again', async () => {
    const paid = await api().patch(`/api/v1/platform/invoices/${S.invoiceId}`).set(auth(S.finance)).send({ status: 'paid', paidRef: 'UPI-123' });
    expect(paid.body.status).toBe('paid');
    expect(paid.body.paidRef).toBe('UPI-123');
    expect((await api().patch(`/api/v1/platform/invoices/${S.invoiceId}`).set(auth(S.finance)).send({ status: 'void' })).status).toBe(409);
  });
});

describe('6. platform costs', () => {
  const cost = (body: object) => api().post('/api/v1/platform/costs').set(auth(S.finance)).send({ month: PERIOD, ...body });
  it('records shared and per-organisation costs; rejects unknown organisation, zero and fractional amounts', async () => {
    expect((await cost({ category: 'hosting', amountPaise: 50_000 })).status).toBe(201);
    const wa = await cost({ category: 'whatsapp', amountPaise: 20_000, tenantId: S.tenant });
    expect(wa.status).toBe(201);
    S.costId = wa.body.id;
    expect((await cost({ category: 'sms', amountPaise: 100, tenantId: 'a'.repeat(24) })).status).toBe(400);
    expect((await cost({ category: 'sms', amountPaise: 0 })).status).toBe(400);
    expect((await cost({ category: 'sms', amountPaise: 12.5 })).status).toBe(400);
    expect((await cost({ category: 'coffee', amountPaise: 100 })).status).toBe(400);
  });
  it('a wrong entry is voided, not deleted, and drops out of the totals', async () => {
    const extra = await cost({ category: 'ads', amountPaise: 99_999 });
    await api().post(`/api/v1/platform/costs/${extra.body.id}/void`).set(auth(S.finance));
    expect((await api().post(`/api/v1/platform/costs/${extra.body.id}/void`).set(auth(S.finance))).status).toBe(409);
    const list = (await api().get(`/api/v1/platform/costs?month=${PERIOD}`).set(auth(S.finance))).body;
    expect(list.totalPaise).toBe(70_000);
    expect(list.byCategory).toEqual({ hosting: 50_000, whatsapp: 20_000 });
    expect(list.items).toHaveLength(3); // the voided one is still visible in history
  });
});

describe('7. financial dashboard', () => {
  it('adds up exactly: MRR, invoiced, collected, outstanding, costs, margin, adoption', async () => {
    const d = (await api().get(`/api/v1/platform/dashboard?month=${PERIOD}`).set(auth(S.finance))).body;
    const subtotal = 199_900 + LEDGER_PAISE;
    expect(d.organisations).toMatchObject({ total: 2, active: 2, suspended: 0 });
    expect(d.revenue.mrrPaise).toBe(subtotal);
    expect(d.revenue.invoicedPaise).toBe(subtotal);
    expect(d.revenue.collectedPaise).toBe(subtotal + Math.round(subtotal * 0.18));
    expect(d.revenue.outstandingPaise).toBe(0);
    expect(d.costs.totalPaise).toBe(70_000);
    expect(d.marginPaise).toBe(subtotal - 70_000);
    expect(d.moduleAdoption.ledger).toBe(1);
    const gamma = d.perOrganisation.find((o: any) => o.name === 'Gamma Counselling');
    expect(gamma).toMatchObject({ mrrPaise: subtotal, costPaise: 20_000 });
  });
  it('a suspended organisation stops counting towards MRR', async () => {
    await api().patch(`/api/v1/platform/tenants/${S.tenant}/status`).set(auth(S.super)).send({ status: 'suspended' });
    const d = (await api().get(`/api/v1/platform/dashboard?month=${PERIOD}`).set(auth(S.finance))).body;
    expect(d.revenue.mrrPaise).toBe(0);
    expect(d.organisations.suspended).toBe(1);
    await api().patch(`/api/v1/platform/tenants/${S.tenant}/status`).set(auth(S.super)).send({ status: 'active' });
  });
});

describe('8. research insights (counts only)', () => {
  const lead = (name: string, phone: string, channel: string) =>
    api().post('/api/v1/leads').set(auth(S.owner)).send({ name, phone, source: { channel }, consent: { given: true } });
  const stage = (id: string, to: string) => api().patch(`/api/v1/leads/${id}/stage`).set(auth(S.owner)).send({ stage: to });

  it('funnel: totals, per channel and per organisation; conversion is exact; no personal data leaks', async () => {
    const a = (await lead('Secret Student A', '9876500001', 'meta_ads')).body.lead._id;
    await lead('Secret Student B', '9876500002', 'meta_ads');
    const c = (await lead('Secret Student C', '9876500003', 'website')).body.lead._id;
    for (const s of ['contacted', 'qualified', 'counselling_done', 'application_started', 'admitted']) await stage(a, s);
    await stage(c, 'lost');

    const res = await api().get('/api/v1/platform/insights/funnel').set(auth(S.ops));
    expect(res.status).toBe(200);
    expect(res.body.totals).toMatchObject({ total: 3, admitted: 1, lost: 1, conversionPct: 33.3 });
    const meta = res.body.byChannel.find((c: any) => c.channel === 'meta_ads');
    expect(meta).toMatchObject({ total: 2, admitted: 1, conversionPct: 50 });
    expect(res.body.byChannel.find((c: any) => c.channel === 'website')).toMatchObject({ total: 1, admitted: 0, conversionPct: 0 });
    expect(res.body.byOrganisation[0]).toMatchObject({ name: 'Gamma Counselling', total: 3 });
    const text = JSON.stringify(res.body);
    expect(text).not.toMatch(/Secret Student|9876500/);
  });

  it('usage per organisation', async () => {
    const usage = (await api().get('/api/v1/platform/insights/usage').set(auth(S.ops))).body.organisations;
    const gamma = usage.find((o: any) => o.name === 'Gamma Counselling');
    expect(gamma.leads).toBe(3);
    expect(gamma.lastActivityAt).toBeTruthy();
    expect(usage.find((o: any) => o.name === 'Delta Counselling').leads).toBe(0);
  });
});

describe('9. ledger entries list', () => {
  it('lists entries and marks reversed ones', async () => {
    const lines = [{ account: 'bank:main', debit: 100_000, credit: 0 }, { account: 'student:s9', debit: 0, credit: 100_000 }];
    const posted = await api().post('/api/v1/ledger/entries').set(auth(S.owner)).send({ idempotencyKey: 'list-test-0001', reference: 'FEE-LIST', lines });
    S.entryId = posted.body.entry._id;
    let list = (await api().get('/api/v1/ledger/entries').set(auth(S.owner))).body;
    expect(list.total).toBe(1);
    expect(list.items[0].reversed).toBe(false);
    await api().post(`/api/v1/ledger/entries/${S.entryId}/reverse`).set(auth(S.owner)).send({ idempotencyKey: 'list-test-rev-1', reason: 'test reversal' });
    list = (await api().get('/api/v1/ledger/entries').set(auth(S.owner))).body;
    expect(list.total).toBe(2);
    expect(list.items.find((i: any) => i._id === S.entryId).reversed).toBe(true);
    expect((await api().get('/api/v1/ledger/entries?account=student:s9').set(auth(S.owner))).body.total).toBe(2);
    expect((await api().get('/api/v1/ledger/entries?account=bad').set(auth(S.owner))).status).toBe(400);
  });
});

describe('10. audit covers the money actions', () => {
  it('platform audit recorded plans, pricing, invoices and costs', async () => {
    const actions = (await api().get('/api/v1/platform/audit?limit=100').set(auth(S.finance))).body.items.map((i: any) => i.action);
    for (const a of ['plan.created', 'tenant.plan_changed', 'tenant.pricing_changed', 'invoice.issued', 'invoice.paid', 'cost.recorded', 'cost.voided']) {
      expect(actions).toContain(a);
    }
  });
});
