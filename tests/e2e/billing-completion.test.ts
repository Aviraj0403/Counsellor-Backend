import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { env } from '../../src/config/env.js';
import { hmacHex } from '../../src/shared/infra/crypto.js';
import { resetHttpClient, setHttpClient } from '../../src/shared/infra/http.js';

/** GST split, company settings, PDF, Razorpay payment link + webhook (fake HTTP client only; never the real Razorpay). */
let mongod: MongoMemoryServer;
let app: import('express').Express;
const PW = 'Str0ng-Passw0rd!';
const api = () => request(app);
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const login = async (email: string) => (await api().post('/api/v1/auth/login').send({ email, password: PW })).body.token as string;
const S = { super: '', finance: '', ops: '', t1: '', t2: '', owner: '', inv1: null as any, inv2: null as any };
const WH_SECRET = 'whsec_test_123';

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri(), { dbName: 'cp_master' });
  const { hashPassword } = await import('../../src/core/modules/identity/infrastructure/security.js');
  const { User } = await import('../../src/core/modules/identity/infrastructure/user.model.js');
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
  S.t1 = await mk('Same State Co', 'same-state', 'o@same.test');
  S.t2 = await mk('Other State Co', 'other-state', 'o@other.test');
  S.owner = await login('o@same.test');
  await api().post('/api/v1/platform/plans').set(auth(S.finance)).send({ key: 'pro', name: 'Pro', basePricePaise: 100_001, includedModules: [] });
  for (const t of [S.t1, S.t2]) await api().patch(`/api/v1/platform/tenants/${t}/plan`).set(auth(S.finance)).send({ planKey: 'pro' });
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod?.stop();
});
afterEach(() => resetHttpClient());

describe('company settings and billing details', () => {
  it('defaults to 18%, validates GSTIN, needs platform:settings:manage', async () => {
    expect((await api().get('/api/v1/platform/settings').set(auth(S.ops))).status).toBe(403);
    expect((await api().get('/api/v1/platform/settings').set(auth(S.owner))).status).toBe(403);
    expect((await api().get('/api/v1/platform/settings').set(auth(S.finance))).body.gstRateBps).toBe(1800);
    expect((await api().put('/api/v1/platform/settings').set(auth(S.finance)).send({ gstin: 'BAD' })).status).toBe(400);
    const ok = await api()
      .put('/api/v1/platform/settings')
      .set(auth(S.finance))
      .send({ legalName: 'Acme Pvt Ltd', gstin: '29abcde1234f1z5', state: 'Karnataka', address: '1 MG Road', invoiceFooter: 'Thank you', bank: { name: 'HDFC', account: '123456', ifsc: 'HDFC0001' } });
    expect(ok.status).toBe(200);
    expect(ok.body.gstin).toBe('29ABCDE1234F1Z5');
    expect(ok.body.gstRateBps).toBe(1800);
  });
  it('organisation billing details: validated, finance only, shown in the billing view', async () => {
    const url = (t: string) => `/api/v1/platform/tenants/${t}/billing-details`;
    expect((await api().patch(url(S.t1)).set(auth(S.ops)).send({ state: 'Karnataka' })).status).toBe(403);
    expect((await api().patch(url(S.t1)).set(auth(S.finance)).send({ gstin: '123' })).status).toBe(400);
    expect((await api().patch(url('64b0000000000000000000ff')).set(auth(S.finance)).send({ state: 'Goa' })).status).toBe(404);
    await api().patch(url(S.t1)).set(auth(S.finance)).send({ legalName: 'Same State Pvt Ltd', state: ' karnataka', gstin: '29AAAAA0000A1Z5' });
    await api().patch(url(S.t2)).set(auth(S.finance)).send({ legalName: 'Other State LLP', state: 'Delhi' });
    const view = (await api().get(`/api/v1/platform/tenants/${S.t1}/billing`).set(auth(S.finance))).body;
    expect(view.billingDetails.legalName).toBe('Same State Pvt Ltd');
    expect(view.currentCharge.cgstPaise + view.currentCharge.sgstPaise).toBe(view.currentCharge.gstPaise);
  });
});

describe('invoices: GST split, snapshot, PDF', () => {
  it('same state -> CGST+SGST; different state -> IGST; rate stored; later rate change does not touch issued invoices', async () => {
    S.inv1 = (await api().post(`/api/v1/platform/tenants/${S.t1}/invoices`).set(auth(S.finance)).send({ period: '2026-11' })).body;
    S.inv2 = (await api().post(`/api/v1/platform/tenants/${S.t2}/invoices`).set(auth(S.finance)).send({ period: '2026-11' })).body;
    const gst = Math.round(100_001 * 0.18); // 18000.18 -> 18000
    expect(S.inv1).toMatchObject({ gstRateBps: 1800, supply: 'intra', gstPaise: gst, igstPaise: 0, totalPaise: 100_001 + gst });
    expect(S.inv1.cgstPaise + S.inv1.sgstPaise).toBe(gst);
    expect(S.inv2).toMatchObject({ supply: 'inter', igstPaise: gst, cgstPaise: 0, sgstPaise: 0 });
    await api().put('/api/v1/platform/settings').set(auth(S.finance)).send({ gstRateBps: 1200 });
    const list = (await api().get('/api/v1/platform/invoices').set(auth(S.finance))).body.items;
    expect(list.find((i: any) => i.id === S.inv1.id).gstRateBps).toBe(1800);
    await api().put('/api/v1/platform/settings').set(auth(S.finance)).send({ gstRateBps: 1800 });
  });
  it('PDF: finance can download; contains invoice number, GSTIN and total; others cannot', async () => {
    const res = await api().get(`/api/v1/platform/invoices/${S.inv1.id}/pdf`).set(auth(S.finance)).buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/pdf/);
    const s = (res.body as Buffer).toString('latin1');
    expect(s.startsWith('%PDF-')).toBe(true);
    expect(s.endsWith('%%EOF')).toBe(true);
    expect(s).toContain(S.inv1.invoiceNo);
    expect(s).toContain('29ABCDE1234F1Z5');
    expect(s).toContain('29AAAAA0000A1Z5');
    expect(s).toContain('Rs. 1,180.01'); // 100001 + 18000 paise
    expect((await api().get(`/api/v1/platform/invoices/${S.inv1.id}/pdf`).set(auth(S.ops))).status).toBe(403);
    expect((await api().get(`/api/v1/platform/invoices/64b0000000000000000000ff/pdf`).set(auth(S.finance))).status).toBe(404);
  });
});

describe('Razorpay payment link + webhook (fake client)', () => {
  const calls: any[] = [];
  const fake = (over: Record<string, unknown> = {}) =>
    setHttpClient(async (url, req) => {
      calls.push({ url, req });
      return { status: 200, ok: true, text: '', data: { id: 'plink_ABC', short_url: 'https://rzp.io/i/abc', status: 'created', ...over } };
    });
  const signed = (body: object, secret = WH_SECRET) => {
    const raw = JSON.stringify(body);
    return api().post('/public/webhooks/razorpay').set('content-type', 'application/json').set('x-razorpay-signature', hmacHex(secret, raw)).send(raw);
  };
  const paidEvent = (linkId: string, amount: number, payId = 'pay_1') => ({
    event: 'payment_link.paid',
    payload: { payment_link: { entity: { id: linkId, amount_paid: amount } }, payment: { entity: { id: payId } } },
  });

  it('refuses clearly when Razorpay keys are missing', async () => {
    const r = await api().post(`/api/v1/platform/invoices/${S.inv1.id}/payment-link`).set(auth(S.finance));
    expect(r.status).toBe(503);
    expect(r.body.error.code).toBe('PAYMENTS_NOT_CONFIGURED');
  });
  it('creates a link with the right amount and basic auth, stores it, and reuses an open link', async () => {
    env.RAZORPAY_KEY_ID = 'rzp_test_id';
    env.RAZORPAY_KEY_SECRET = 'rzp_test_secret';
    fake();
    expect((await api().post(`/api/v1/platform/invoices/${S.inv1.id}/payment-link`).set(auth(S.ops))).status).toBe(403);
    const r = await api().post(`/api/v1/platform/invoices/${S.inv1.id}/payment-link`).set(auth(S.finance));
    expect(r.status).toBe(201);
    expect(r.body.paymentLink).toMatchObject({ id: 'plink_ABC', url: 'https://rzp.io/i/abc', status: 'created' });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.razorpay.com/v1/payment_links');
    expect(calls[0].req.body).toMatchObject({ amount: S.inv1.totalPaise, currency: 'INR', reference_id: S.inv1.invoiceNo });
    expect(calls[0].req.headers.authorization).toBe(`Basic ${Buffer.from('rzp_test_id:rzp_test_secret').toString('base64')}`);
    await api().post(`/api/v1/platform/invoices/${S.inv1.id}/payment-link`).set(auth(S.finance));
    expect(calls).toHaveLength(1); // reused, no second call
  });
  it('a provider failure becomes a clear 502 and stores nothing', async () => {
    setHttpClient(async () => ({ status: 400, ok: false, text: '', data: { error: {} } }));
    const r = await api().post(`/api/v1/platform/invoices/${S.inv2.id}/payment-link`).set(auth(S.finance));
    expect(r.status).toBe(502);
    expect((await api().get('/api/v1/platform/invoices').set(auth(S.finance))).body.items.find((i: any) => i.id === S.inv2.id).paymentLink).toBeNull();
  });
  it('webhook: unconfigured -> 503; bad signature -> 401', async () => {
    expect((await signed(paidEvent('plink_ABC', 1))).status).toBe(503);
    env.RAZORPAY_WEBHOOK_SECRET = WH_SECRET;
    expect((await signed(paidEvent('plink_ABC', S.inv1.totalPaise), 'wrong')).status).toBe(401);
    expect((await api().post('/public/webhooks/razorpay').send(paidEvent('plink_ABC', 1))).status).toBe(401);
  });
  it('webhook: amount mismatch and unknown link change nothing; real paid event marks paid once (idempotent)', async () => {
    expect((await signed(paidEvent('plink_ABC', 5))).body.result).toBe('ignored');
    expect((await signed(paidEvent('plink_UNKNOWN', 5))).body.result).toBe('ignored');
    const first = await signed(paidEvent('plink_ABC', S.inv1.totalPaise, 'pay_XYZ'));
    expect(first.status).toBe(200);
    expect(first.body.result).toBe('paid');
    expect((await signed(paidEvent('plink_ABC', S.inv1.totalPaise, 'pay_XYZ'))).body.result).toBe('duplicate');
    const inv = (await api().get('/api/v1/platform/invoices?status=paid').set(auth(S.finance))).body.items.find((i: any) => i.id === S.inv1.id);
    expect(inv).toMatchObject({ status: 'paid', paidRef: 'pay_XYZ' });
    expect(inv.paymentLink.status).toBe('paid');
    const audit = await mongoose.connection.db!.collection('platformaudits').countDocuments({ action: 'invoice.paid', targetId: S.inv1.id });
    expect(audit).toBe(1);
    // a paid invoice cannot get a new link
    expect((await api().post(`/api/v1/platform/invoices/${S.inv1.id}/payment-link`).set(auth(S.finance))).status).toBe(409);
  });
});
