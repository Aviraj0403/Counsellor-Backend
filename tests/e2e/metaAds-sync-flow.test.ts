import { createHmac } from 'node:crypto';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

/** Meta insights sync, performance, alerts, cron job, platform overview. A FAKE Graph (setHttpClient): nothing here touches Meta. */
let mongod: MongoMemoryServer;
let app: import('express').Express;
let http: typeof import('../../src/shared/infra/http.js');
let envMod: typeof import('../../src/config/env.js');

const PW = 'Str0ng-Passw0rd!';
const APP_SECRET = 'meta-app-secret-for-tests';
const JOBS = 'jobs-secret-0123456789';
const TOKEN_A = 'EAAB-alpha-secret-access-token-AAAA';
const TOKEN_B = 'EAAB-beta-secret-access-token-BBBB';
const TOKEN_B2 = 'EAAB-beta-NEW-secret-access-token-CCCC';
const ACC_A = '1112223334';
const ACC_B = '5556667778';
const api = () => request(app);
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const login = async (email: string) => (await api().post('/api/v1/auth/login').send({ email, password: PW })).body.token as string;
const sign = (body: string) => 'sha256=' + createHmac('sha256', APP_SECRET).update(body).digest('hex');
const M = '/api/v1/integrations/meta';

const S = { superToken: '', tenantA: '', tenantB: '', owner: '', ownerB: '', counsellor: '' };
const seen: string[] = []; // every response body we looked at: none may contain a token
const note = <T extends { body: unknown; text?: string }>(r: T): T => {
  seen.push(JSON.stringify(r.body) + (r.text ?? ''));
  return r;
};

const istDate = (d = new Date()) => new Date(d.getTime() + 330 * 60_000).toISOString().slice(0, 10);
const addDays = (s: string, n: number) => new Date(Date.parse(`${s}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const TODAY = istDate();
const YEST = addDays(TODAY, -1);

let calls: Array<{ url: string; req: any }> = [];
type Responder = (url: string, req: any) => any;
let respond: Responder = () => ({ status: 200, ok: true, data: {}, text: '{}' });
const ok = (data: unknown) => ({ status: 200, ok: true, data, text: JSON.stringify(data) });
const fail = (status: number, code: number, message: string) => ({ status, ok: false, data: { error: { code, message } }, text: '' });
const row = (campaign: string, name: string, date: string, spend: string, imp: number, clicks: number, leads?: number, currency = 'INR') => ({
  campaign_id: campaign, campaign_name: name, date_start: date, spend, impressions: String(imp), reach: String(imp - 1), clicks: String(clicks), account_currency: currency,
  actions: leads === undefined ? undefined : [{ action_type: 'link_click', value: '9' }, { action_type: 'lead', value: String(leads) }, { action_type: 'onsite_conversion.lead_grouped', value: String(leads) }],
});

beforeAll(async () => {
  process.env.META_APP_SECRET = APP_SECRET;
  process.env.JOBS_SECRET = JOBS;
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri(), { dbName: 'cp_master' });
  const { hashPassword } = await import('../../src/core/modules/identity/infrastructure/security.js');
  const { User } = await import('../../src/core/modules/identity/infrastructure/user.model.js');
  app = (await import('../../src/app/app.js')).buildApp();
  http = await import('../../src/shared/infra/http.js');
  envMod = await import('../../src/config/env.js');
  http.setHttpClient(async (url, req) => {
    calls.push({ url, req });
    return respond(url, req);
  });
  await User.create({ email: 'super@platform.test', name: 'Super', passwordHash: await hashPassword(PW), role: 'superadmin', tenantId: null });
  S.superToken = await login('super@platform.test');
  const mk = (name: string, slug: string, email: string) => api().post('/api/v1/platform/tenants').set(auth(S.superToken)).send({ name, slug, ownerName: 'Owner', ownerEmail: email, ownerPassword: PW });
  S.tenantA = (await mk('Alpha', 'alpha', 'owner@alpha.test')).body.tenantId;
  S.tenantB = (await mk('Beta', 'beta', 'owner@beta.test')).body.tenantId;
  S.owner = await login('owner@alpha.test');
  S.ownerB = await login('owner@beta.test');
  await api().post('/api/v1/team').set(auth(S.owner)).send({ name: 'Asha', email: 'asha@alpha.test', password: PW, role: 'counsellor' });
  S.counsellor = await login('asha@alpha.test');
});

afterEach(() => {
  calls = [];
  respond = () => ({ status: 200, ok: true, data: {}, text: '{}' });
});
afterAll(async () => {
  http?.resetHttpClient();
  await mongoose.disconnect();
  await mongod?.stop();
});

const insightCalls = () => calls.filter((c) => c.url.includes('/insights'));
const timeRange = (url: string) => JSON.parse(new URL(url).searchParams.get('time_range')!) as { since: string; until: string };
const rawCount = (tenant: string) => mongoose.connection.useDb(`cp_t_${tenant}`).collection('metainsightdailies').countDocuments();

describe('1. module off and permissions', () => {
  it('everything is closed until the module is enabled', async () => {
    for (const path of ['/status', '/performance', '/sync', '/connection/test']) {
      const r = path === '/status' || path === '/performance' ? await api().get(M + path).set(auth(S.owner)) : await api().post(M + path).set(auth(S.owner)).send({});
      expect(r.body.error.code).toBe('MODULE_NOT_ENABLED');
    }
    for (const t of [S.tenantA, S.tenantB]) {
      expect((await api().patch(`/api/v1/platform/tenants/${t}/modules`).set(auth(S.superToken)).send({ modules: { metaAds: true } })).status).toBe(200);
    }
  });

  it('is for integrations:manage only (a counsellor gets 403)', async () => {
    expect((await api().get(`${M}/status`).set(auth(S.counsellor))).status).toBe(403);
    expect((await api().get(`${M}/performance`).set(auth(S.counsellor))).status).toBe(403);
    expect((await api().post(`${M}/sync`).set(auth(S.counsellor)).send({})).status).toBe(403);
    expect((await api().post(`${M}/connection/test`).set(auth(S.counsellor))).status).toBe(403);
    expect((await api().get(`${M}/status`)).status).toBe(401);
  });
});

describe('2. connection', () => {
  it('validates ad account ids, the API version and the token shape', async () => {
    const put = (b: object) => api().put(`${M}/config`).set(auth(S.owner)).send(b);
    expect((await put({ adAccountIds: ['not-a-number'] })).status).toBe(400);
    expect((await put({ apiVersion: '21' })).status).toBe(400);
    expect((await put({ accessToken: 'short' })).status).toBe(400);
    expect((await put({ accessToken: 'has spaces in it but is long enough' })).status).toBe(400);
  });

  it('syncing before a token and account are saved is a plain 400', async () => {
    const r = await api().post(`${M}/sync`).set(auth(S.owner)).send({});
    expect(r.status).toBe(400);
    expect(r.body.error.message).toContain('access token');
    expect(calls).toHaveLength(0);
  });

  it('saves token (encrypted, masked hint) and ad accounts; the token is never returned', async () => {
    const r = note(await api().put(`${M}/config`).set(auth(S.owner)).send({ accessToken: TOKEN_A, adAccountIds: [ACC_A, `act_${ACC_A}`], apiVersion: 'v22.0', pageId: 'P1' }));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ tokenSet: true, adAccountIds: [`act_${ACC_A}`], apiVersion: 'v22.0', pageId: 'P1' });
    expect(r.body.tokenHint).toBe('••••••••AAAA');
    const status = note(await api().get(`${M}/status`).set(auth(S.owner)));
    expect(status.body).toMatchObject({ connected: true, tokenSet: true, tokenHint: '••••••••AAAA', apiVersion: 'v22.0', lastSyncAt: null, alerts: [] });
    const raw = await mongoose.connection.useDb(`cp_t_${S.tenantA}`).collection('metaconfigs').findOne({ key: 'main' });
    expect(raw!.accessTokenEnc).toBeTruthy();
    expect(JSON.stringify(raw)).not.toContain(TOKEN_A);
  });

  it('the test calls /me and /me/adaccounts with the token in a header (not the URL) and reports in plain language', async () => {
    respond = (url) =>
      url.includes('/me/adaccounts') ? ok({ data: [{ account_id: ACC_A, name: 'Alpha Ads', currency: 'INR', account_status: 1 }, { account_id: '999999', name: 'Other', currency: 'USD', account_status: 1 }] }) : ok({ id: 'u1', name: 'Alpha System User' });
    const r = note(await api().post(`${M}/connection/test`).set(auth(S.owner)));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, me: { id: 'u1', name: 'Alpha System User' }, apiVersion: 'v22.0' });
    expect(r.body.adAccounts).toHaveLength(2);
    expect(r.body.configuredAccounts).toEqual([{ id: `act_${ACC_A}`, found: true, name: 'Alpha Ads', currency: 'INR' }]);
    expect(r.body.message).toContain('Connected as Alpha System User');
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual(['/v22.0/me', '/v22.0/me/adaccounts']);
    for (const c of calls) {
      expect(c.url).not.toContain(TOKEN_A);
      expect(c.req.headers.Authorization).toBe(`Bearer ${TOKEN_A}`);
    }
  });

  it('a rejected token comes back as ok:false with a human message and no token', async () => {
    respond = () => fail(400, 190, 'Error validating access token: Session has expired');
    const r = note(await api().post(`${M}/connection/test`).set(auth(S.owner)));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: false, code: 'TOKEN_INVALID' });
    expect(r.body.message).toContain('invalid or has expired');
  });

  it('a network failure is also reported, not thrown', async () => {
    http.setHttpClient(async () => {
      throw new Error('ECONNRESET secret=' + TOKEN_A);
    });
    const r = note(await api().post(`${M}/connection/test`).set(auth(S.owner)));
    expect(r.body).toMatchObject({ ok: false, code: 'NETWORK' });
    http.setHttpClient(async (url, req) => {
      calls.push({ url, req });
      return respond(url, req);
    });
  });
});

describe('3. insights sync', () => {
  it('first sync backfills 30 days, follows paging (access_token stripped) and stores integer paise', async () => {
    respond = (url) => {
      if (url.includes('after=PAGE2')) return ok({ data: [row('222', 'Bulk Mailer', YEST, '200.50', 2000, 20)] });
      return ok({
        data: [row('111', 'Admissions Nov', YEST, '300.00', 3000, 30, 3), row('111', 'Admissions Nov', TODAY, '500.00', 5000, 50, 5), { campaign_name: 'broken row without id', date_start: TODAY }],
        paging: { next: `https://graph.facebook.com/v22.0/act_${ACC_A}/insights?after=PAGE2&access_token=LEAKED_FROM_PAGING` },
      });
    };
    const r = note(await api().post(`${M}/sync`).set(auth(S.owner)).send({}));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, days: 30, rows: 3, currency: 'INR', currencyMismatch: false });
    const ic = insightCalls();
    expect(ic).toHaveLength(2);
    expect(timeRange(ic[0]!.url)).toEqual({ since: addDays(TODAY, -29), until: TODAY });
    expect(new URL(ic[0]!.url).pathname).toBe(`/v22.0/act_${ACC_A}/insights`);
    expect(new URL(ic[0]!.url).searchParams.get('level')).toBe('campaign');
    expect(new URL(ic[0]!.url).searchParams.get('time_increment')).toBe('1');
    expect(ic[1]!.url).not.toContain('LEAKED');
    for (const c of ic) expect(c.url).not.toContain(TOKEN_A);
    expect(await rawCount(S.tenantA)).toBe(3);
    const doc = await mongoose.connection.useDb(`cp_t_${S.tenantA}`).collection('metainsightdailies').findOne({ campaignId: '111', date: TODAY });
    expect(doc).toMatchObject({ spend: 50000, impressions: 5000, clicks: 50, leads: 5, currency: 'INR', currencyMismatch: false, accountId: `act_${ACC_A}` });
    const status = note(await api().get(`${M}/status`).set(auth(S.owner)));
    expect(status.body).toMatchObject({ lastError: null, consecutiveFailures: 0, currency: 'INR', lastSyncRows: 3 });
    expect(status.body.lastSyncAt).toBeTruthy();
    expect(status.body.alerts).toEqual([]);
  });

  it('later runs re-pull only the last 3 days, update restated numbers and never duplicate', async () => {
    respond = () => ok({ data: [row('111', 'Admissions Nov', TODAY, '600.00', 5200, 55, 6)] });
    const r = note(await api().post(`${M}/sync`).set(auth(S.owner)).send({}));
    expect(r.body).toMatchObject({ ok: true, days: 3, rows: 1 });
    expect(timeRange(insightCalls()[0]!.url)).toEqual({ since: addDays(TODAY, -2), until: TODAY });
    expect(await rawCount(S.tenantA)).toBe(3);
    const doc = await mongoose.connection.useDb(`cp_t_${S.tenantA}`).collection('metainsightdailies').findOne({ campaignId: '111', date: TODAY });
    expect(doc).toMatchObject({ spend: 60000, leads: 6, impressions: 5200 });
    // the very same data again: nothing changes
    await api().post(`${M}/sync`).set(auth(S.owner)).send({});
    expect(await rawCount(S.tenantA)).toBe(3);
  });

  it('an explicit window can be asked for (1 to 90 days)', async () => {
    respond = () => ok({ data: [] });
    expect((await api().post(`${M}/sync`).set(auth(S.owner)).send({ days: 7 })).body.days).toBe(7);
    expect((await api().post(`${M}/sync`).set(auth(S.owner)).send({ days: 365 })).status).toBe(400);
  });

  it('a lead from a lead ad keeps its campaign', async () => {
    respond = (url) =>
      url.includes('/LGX1')
        ? ok({ id: 'x', campaign_id: '111', campaign_name: 'Admissions Nov', ad_id: 'A7', adset_id: 'S3', form_id: 'F9', field_data: [{ name: 'full_name', values: ['Meera Nair'] }, { name: 'phone_number', values: ['9876543210'] }] })
        : ok({ id: 'y', field_data: [{ name: 'full_name', values: ['No Campaign'] }, { name: 'phone_number', values: ['9876543211'] }] });
    const hook = (id: string) => {
      const body = JSON.stringify({ object: 'page', entry: [{ id: 'P1', changes: [{ field: 'leadgen', value: { leadgen_id: id, form_id: 'F9', ad_id: 'A7' } }] }] });
      return api().post(`/public/hooks/meta/${S.tenantA}`).set('content-type', 'application/json').set('x-hub-signature-256', sign(body)).send(body);
    };
    expect((await hook('LGX1')).body).toMatchObject({ created: 1 });
    expect((await hook('LGX2')).body).toMatchObject({ created: 1 });
    expect((await hook('LGX1')).body).toMatchObject({ duplicates: 1, created: 0 }); // same phone: no second lead, no second link
    const link = await mongoose.connection.useDb(`cp_t_${S.tenantA}`).collection('metaleadlinks').findOne({ leadgenId: 'LGX1' });
    expect(link).toMatchObject({ campaignId: '111', adId: 'A7', adsetId: 'S3', formId: 'F9' });
    expect(await mongoose.connection.useDb(`cp_t_${S.tenantA}`).collection('metaleadlinks').countDocuments()).toBe(2);
  });
});

describe('4. performance', () => {
  it('per campaign: spend, impressions, clicks, Meta leads, platform leads, cost per lead, totals', async () => {
    const r = note(await api().get(`${M}/performance`).query({ from: addDays(TODAY, -29), to: TODAY }).set(auth(S.owner)));
    expect(r.status).toBe(200);
    expect(r.body.items.map((i: any) => i.campaignId)).toEqual(['111', '222']);
    expect(r.body.items[0]).toMatchObject({ campaignName: 'Admissions Nov', spend: 90000, impressions: 8200, clicks: 85, metaLeads: 9, platformLeads: 1, costPerLead: 10000, costPerPlatformLead: 90000, currencyMismatch: false });
    expect(r.body.items[1]).toMatchObject({ campaignName: 'Bulk Mailer', spend: 20050, metaLeads: 0, platformLeads: 0, costPerLead: null });
    expect(r.body.totals).toMatchObject({ spend: 110050, metaLeads: 9, platformLeads: 1, costPerLead: Math.round(110050 / 9), currencyMismatch: false });
    expect(r.body.unattributedPlatformLeads).toBe(1);
  });

  it('respects the date range and defaults to the last 30 days', async () => {
    const one = (await api().get(`${M}/performance`).query({ from: TODAY, to: TODAY }).set(auth(S.owner))).body;
    expect(one.items.find((i: any) => i.campaignId === '111')).toMatchObject({ spend: 60000, metaLeads: 6 });
    expect(one.items.find((i: any) => i.campaignId === '222')).toBeUndefined();
    const def = (await api().get(`${M}/performance`).set(auth(S.owner))).body;
    expect(def.from).toBe(addDays(TODAY, -29));
    expect(def.totals.spend).toBe(110050);
  });

  it('rejects bad dates and ranges', async () => {
    const get = (q: object) => api().get(`${M}/performance`).query(q).set(auth(S.owner));
    expect((await get({ from: '2026-13-01' })).status).toBe(400);
    expect((await get({ from: '2026-11-10', to: '2026-11-01' })).status).toBe(400);
    expect((await get({ from: '2020-01-01', to: '2026-11-01' })).status).toBe(400);
  });

  it('spend in another currency is kept but flagged and left out of the cost figures', async () => {
    respond = () => ok({ data: [row('333', 'Dollar campaign', TODAY, '10.50', 1000, 10, 2, 'USD')] });
    const s = note(await api().post(`${M}/sync`).set(auth(S.owner)).send({}));
    expect(s.body).toMatchObject({ ok: true, currencyMismatch: true });
    const p = note(await api().get(`${M}/performance`).set(auth(S.owner)));
    const usd = p.body.items.find((i: any) => i.campaignId === '333');
    expect(usd).toMatchObject({ currencyMismatch: true, spend: 0, otherCurrencySpend: 1050, costPerLead: null, metaLeads: 2 });
    expect(p.body.totals).toMatchObject({ spend: 110050, currencyMismatch: true, costPerLead: Math.round(110050 / 9) });
    expect((await api().get(`${M}/status`).set(auth(S.owner))).body.currencyMismatch).toBe(true);
  });
});

describe('5. alerts', () => {
  const sync = () => api().post(`${M}/sync`).set(auth(S.ownerB)).send({});
  const status = async () => note(await api().get(`${M}/status`).set(auth(S.ownerB))).body;
  const auditCount = async (action: string) => {
    const a = (await api().get('/api/v1/audit?limit=100').set(auth(S.ownerB))).body;
    return JSON.stringify(a).split(`"${action}"`).length - 1;
  };

  it('a rejected token (190) raises ONE critical alert at once, audited the first time only', async () => {
    note(await api().put(`${M}/config`).set(auth(S.ownerB)).send({ accessToken: TOKEN_B, adAccountIds: [ACC_B] }));
    respond = () => fail(400, 190, 'Error validating access token');
    const r = note(await sync());
    expect(r.body).toMatchObject({ ok: false, code: 'TOKEN_INVALID' });
    expect(r.body.error).toContain('invalid or has expired');
    let s = await status();
    expect(s.alerts.map((a: any) => a.code)).toEqual(['TOKEN_INVALID']);
    expect(s.alerts[0].severity).toBe('critical');
    expect(s).toMatchObject({ consecutiveFailures: 1, lastErrorCode: 'TOKEN_INVALID' });
    await sync();
    s = await status();
    expect(s.alerts).toHaveLength(1);
    expect(s.consecutiveFailures).toBe(2);
    expect(await auditCount('meta.alert_raised')).toBe(1);
  });

  it('two failed runs in a row raise "sync failing"; the token alert goes away when the error changes', async () => {
    respond = () => fail(500, 1, 'An unknown error occurred');
    await sync();
    const s = await status();
    expect(s.consecutiveFailures).toBe(3);
    expect(s.alerts.map((a: any) => a.code)).toEqual(['SYNC_FAILING']);
    expect(s.lastError).toContain('Meta returned an error');
  });

  it('saving a new token gives a fresh start; spend today with no leads raises an alert', async () => {
    const put = note(await api().put(`${M}/config`).set(auth(S.ownerB)).send({ accessToken: TOKEN_B2 }));
    expect(put.body.tokenHint).toBe('••••••••CCCC');
    respond = () => ok({ data: [row('777', 'No lead campaign', TODAY, '100.00', 4000, 40)] });
    const r = await sync();
    expect(r.body).toMatchObject({ ok: true, days: 30 });
    const s = await status();
    expect(s).toMatchObject({ consecutiveFailures: 0, lastError: null });
    expect(s.alerts.map((a: any) => a.code)).toEqual(['SPEND_NO_LEADS']);
    expect(await auditCount('meta.alert_raised')).toBe(3); // token, failing, no leads: each once
  });

  it('the alert clears when leads show up', async () => {
    respond = () => ok({ data: [row('777', 'No lead campaign', TODAY, '100.00', 4000, 40, 2)] });
    await sync();
    expect((await status()).alerts).toEqual([]);
    respond = () => ok({ data: [row('777', 'No lead campaign', TODAY, '100.00', 4000, 40)] });
    await sync(); // restated back to zero leads: raised again, audited again
    expect((await status()).alerts.map((a: any) => a.code)).toEqual(['SPEND_NO_LEADS']);
  });
});

describe('6. cron job', () => {
  const job = (secret?: string) => api().post('/public/meta/jobs/sync-all').set(secret ? { 'x-jobs-secret': secret } : {}).send({});

  it('503 when the server has no (or a too short) secret, 401 for a wrong or missing one', async () => {
    const saved = envMod.env.JOBS_SECRET;
    envMod.env.JOBS_SECRET = undefined;
    expect((await job(JOBS)).status).toBe(503);
    envMod.env.JOBS_SECRET = 'short';
    expect((await job('short')).status).toBe(503);
    envMod.env.JOBS_SECRET = saved;
    expect((await job()).status).toBe(401);
    expect((await job('wrong-secret-wrong-secret')).status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it('syncs every organisation; one failing organisation does not stop the other; the 3-day window is used', async () => {
    const a0 = await rawCount(S.tenantA);
    respond = (url) => (url.includes(`act_${ACC_B}`) ? fail(500, 2, 'Service temporarily unavailable') : ok({ data: [row('111', 'Admissions Nov', TODAY, '650.00', 5300, 56, 7)] }));
    const r = note(await job(JOBS));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ organisations: 2, synced: 1, failed: 1 });
    expect(r.body.results.find((x: any) => x.tenantId === S.tenantA)).toMatchObject({ ok: true, rows: 1 });
    expect(r.body.results.find((x: any) => x.tenantId === S.tenantB)).toMatchObject({ ok: false, code: 'META_ERROR' });
    const aCall = insightCalls().find((c) => c.url.includes(`act_${ACC_A}`))!;
    expect(timeRange(aCall.url).since).toBe(addDays(TODAY, -2));
    expect(await rawCount(S.tenantA)).toBe(a0);
    const sa = (await api().get(`${M}/status`).set(auth(S.owner))).body;
    expect(sa).toMatchObject({ lastError: null, consecutiveFailures: 0 });
    const sb = (await api().get(`${M}/status`).set(auth(S.ownerB))).body;
    expect(sb.lastError).toContain('Meta returned an error');
    expect(sb.consecutiveFailures).toBe(1);
    expect(JSON.stringify((await api().get('/api/v1/audit?limit=100').set(auth(S.owner))).body)).toContain('meta.sync_run');
  });

  it('is idempotent: running it again changes no row count', async () => {
    const before = [await rawCount(S.tenantA), await rawCount(S.tenantB)];
    respond = (url) => (url.includes(`act_${ACC_B}`) ? ok({ data: [row('777', 'No lead campaign', TODAY, '100.00', 4000, 40)] }) : ok({ data: [row('111', 'Admissions Nov', TODAY, '650.00', 5300, 56, 7)] }));
    const r = await job(JOBS);
    expect(r.body).toMatchObject({ synced: 2, failed: 0 });
    expect(await job(JOBS)).toBeTruthy();
    expect([await rawCount(S.tenantA), await rawCount(S.tenantB)]).toEqual(before);
    expect((await api().get(`${M}/status`).set(auth(S.ownerB))).body.consecutiveFailures).toBe(0);
  });

  it('skips an organisation whose module is switched off', async () => {
    await api().patch(`/api/v1/platform/tenants/${S.tenantB}/modules`).set(auth(S.superToken)).send({ modules: { metaAds: false } });
    respond = () => ok({ data: [] });
    const r = await job(JOBS);
    expect(r.body).toMatchObject({ organisations: 1, skipped: 1 });
    expect(insightCalls().every((c) => c.url.includes(`act_${ACC_A}`))).toBe(true);
    await api().patch(`/api/v1/platform/tenants/${S.tenantB}/modules`).set(auth(S.superToken)).send({ modules: { metaAds: true } });
  });
});

describe('7. platform overview, isolation, secrets', () => {
  it('superadmin sees one row per organisation with the module on: connected, last sync, last error, 30-day spend and leads', async () => {
    const r = note(await api().get('/api/v1/platform/meta/overview').set(auth(S.superToken)));
    expect(r.status).toBe(200);
    const a = r.body.organisations.find((o: any) => o.tenantId === S.tenantA);
    const b = r.body.organisations.find((o: any) => o.tenantId === S.tenantB);
    expect(a).toMatchObject({ name: 'Alpha', connected: true, lastError: null });
    expect(a.lastSyncAt).toBeTruthy();
    // INR rows only: 111 (65000 today + 30000 yesterday) + 222 (20050); the USD campaign is left out
    expect(a.spend30dPaise).toBe(65000 + 30000 + 20050);
    expect(a.leads30d).toBe(7 + 3);
    expect(b).toMatchObject({ name: 'Beta', connected: true, spend30dPaise: 10000, leads30d: 0 });
  });

  it('is for platform staff only', async () => {
    expect((await api().get('/api/v1/platform/meta/overview').set(auth(S.owner))).status).toBe(403);
    expect((await api().get('/api/v1/platform/meta/overview')).status).toBe(401);
  });

  it('organisations are isolated: B sees none of A', async () => {
    const p = note(await api().get(`${M}/performance`).set(auth(S.ownerB)));
    expect(p.body.items.map((i: any) => i.campaignId)).toEqual(['777']);
    expect(p.body.unattributedPlatformLeads).toBe(0);
    const s = (await api().get(`${M}/status`).set(auth(S.ownerB))).body;
    expect(s.adAccountIds).toEqual([`act_${ACC_B}`]);
  });

  it('records what happened in the audit log, without any token', async () => {
    const audit = JSON.stringify((await api().get('/api/v1/audit?limit=100').set(auth(S.owner))).body);
    for (const action of ['meta.config_updated', 'meta.connection_tested', 'meta.sync_run']) expect(audit).toContain(action);
    seen.push(audit, JSON.stringify((await api().get(`${M}/events`).set(auth(S.owner))).body), JSON.stringify((await api().get(`${M}/config`).set(auth(S.ownerB))).body));
  });

  it('no token appears in any response, audit row or log we looked at, and none is stored in clear', async () => {
    expect(seen.length).toBeGreaterThan(20);
    for (const body of seen) for (const t of [TOKEN_A, TOKEN_B, TOKEN_B2, 'LEAKED_FROM_PAGING']) expect(body).not.toContain(t);
    for (const tenant of [S.tenantA, S.tenantB]) {
      const db = mongoose.connection.useDb(`cp_t_${tenant}`);
      for (const coll of ['metaconfigs', 'metaalerts', 'audits']) {
        const text = JSON.stringify(await db.collection(coll).find().toArray());
        for (const t of [TOKEN_A, TOKEN_B, TOKEN_B2]) expect(text).not.toContain(t);
      }
    }
  });
});
