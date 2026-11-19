import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/** Public SEO site story: staff set up pages -> visitors read HTML/sitemap -> enquiry form -> lead; plus every refusal path. */
let mongod: MongoMemoryServer;
let app: import('express').Express;

const PW = 'Str0ng-Passw0rd!';
const api = () => request(app);
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const login = async (email: string) => (await api().post('/api/v1/auth/login').send({ email, password: PW })).body.token as string;
const SITE = '/public/sites/alpha-seo';
const XSS = '<script>alert(1)</script>';

const S = { super: '', tenant: '', tenantB: '', tenantOff: '', tenantSusp: '', owner: '', ownerB: '', ownerOff: '', counsellor: '', marketing: '', collegeId: '', xssCollegeId: '' };

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri(), { dbName: 'cp_master' });
  const { hashPassword } = await import('../../src/core/modules/identity/infrastructure/security.js');
  const { User } = await import('../../src/core/modules/identity/infrastructure/user.model.js');
  app = (await import('../../src/app/app.js')).buildApp();
  await User.create({ email: 'super@p.test', name: 'Super', passwordHash: await hashPassword(PW), role: 'superadmin', tenantId: null });
  S.super = await login('super@p.test');

  const mk = async (name: string, slug: string, email: string) =>
    (await api().post('/api/v1/platform/tenants').set(auth(S.super)).send({ name, slug, ownerName: 'Owner', ownerEmail: email, ownerPassword: PW })).body.tenantId as string;
  S.tenant = await mk('Alpha SEO', 'alpha-seo', 'owner@alpha.test');
  S.tenantB = await mk('Beta SEO', 'beta-seo', 'owner@beta.test');
  S.tenantOff = await mk('Off SEO', 'off-seo', 'owner@off.test');
  S.tenantSusp = await mk('Susp SEO', 'susp-seo', 'owner@susp.test');
  for (const t of [S.tenant, S.tenantB, S.tenantSusp]) {
    expect((await api().patch(`/api/v1/platform/tenants/${t}/modules`).set(auth(S.super)).send({ modules: { colleges: true, seoPages: true } })).status).toBe(200);
  }
  expect((await api().patch(`/api/v1/platform/tenants/${S.tenantOff}/modules`).set(auth(S.super)).send({ modules: { colleges: true } })).status).toBe(200);
  S.owner = await login('owner@alpha.test');
  S.ownerB = await login('owner@beta.test');
  S.ownerOff = await login('owner@off.test');
  const add = async (name: string, email: string, role: string) => (await api().post('/api/v1/team').set(auth(S.owner)).send({ name, email, password: PW, role })).body.id as string;
  await add('Asha Counsellor', 'asha@alpha.test', 'counsellor');
  await add('Mohit Marketing', 'mohit@alpha.test', 'marketing');
  S.counsellor = await login('asha@alpha.test');
  S.marketing = await login('mohit@alpha.test');

  const college = await api().post('/api/v1/colleges').set(auth(S.owner)).send({ name: 'Sunrise Institute', city: 'Pune', state: 'Maharashtra', description: 'A friendly college for engineers.', website: 'https://sunrise.edu' });
  expect(college.status).toBe(201);
  S.collegeId = college.body._id;
  const evil = await api().post('/api/v1/colleges').set(auth(S.owner)).send({ name: `Evil ${XSS} College`, slug: 'evil', description: `<img src=x onerror=alert(2)> ${XSS}` });
  S.xssCollegeId = evil.body._id;
  await api().post(`/api/v1/colleges/${S.collegeId}/courses`).set(auth(S.owner)).send({ name: 'B.Tech CSE', level: 'ug', annualFeePaise: 12000000, durationMonths: 48 });
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod?.stop();
});

describe('staff endpoints: module switch and permissions', () => {
  it('module off => 403 MODULE_NOT_ENABLED', async () => {
    const r = await api().get('/api/v1/seo/settings').set(auth(S.ownerOff));
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('MODULE_NOT_ENABLED');
  });
  it('a counsellor (no seo:manage) gets 403 everywhere; marketing may manage', async () => {
    expect((await api().get('/api/v1/seo/settings').set(auth(S.counsellor))).status).toBe(403);
    expect((await api().put('/api/v1/seo/settings').set(auth(S.counsellor)).send({ siteTitle: 'Hack' })).status).toBe(403);
    expect((await api().get('/api/v1/seo/pages').set(auth(S.counsellor))).status).toBe(403);
    expect((await api().get('/api/v1/seo/preview/evil').set(auth(S.counsellor))).status).toBe(403);
    expect((await api().get('/api/v1/seo/settings').set(auth(S.marketing))).status).toBe(200);
    expect((await api().get('/api/v1/seo/settings')).status).toBe(401);
  });
});

describe('staff: settings and page overrides', () => {
  it('defaults first, then update; orgSlug must be the caller\'s own organisation', async () => {
    const d = await api().get('/api/v1/seo/settings').set(auth(S.owner));
    expect(d.body).toMatchObject({ leadFormEnabled: true, themeColor: '#1d4ed8', publicUrl: null });
    expect((await api().put('/api/v1/seo/settings').set(auth(S.owner)).send({ orgSlug: 'beta-seo' })).status).toBe(400); // someone else's
    expect((await api().put('/api/v1/seo/settings').set(auth(S.owner)).send({ themeColor: 'red' })).status).toBe(400);
    expect((await api().put('/api/v1/seo/settings').set(auth(S.owner)).send({ logoUrl: 'javascript:alert(1)' })).status).toBe(400);
    const r = await api().put('/api/v1/seo/settings').set(auth(S.owner)).send({
      orgSlug: 'alpha-seo', siteTitle: 'Alpha Admissions', tagline: 'We guide', themeColor: '#0a7d4f',
      contact: { phone: '+91 99999 11111', email: 'hi@alpha.test', whatsapp: '919999911111' },
    });
    expect(r.status).toBe(200);
    expect(r.body.publicUrl).toBe('http://api.test/public/sites/alpha-seo');
  });

  it('overrides: upsert with FAQs, list, get, validation, delete, audit rows', async () => {
    expect((await api().put(`/api/v1/seo/pages/${S.collegeId}`).set(auth(S.owner)).send({ faqs: [{ q: '', a: 'x' }] })).status).toBe(400);
    expect((await api().put('/api/v1/seo/pages/not-an-id').set(auth(S.owner)).send({})).status).toBe(400);
    expect((await api().put('/api/v1/seo/pages/aaaaaaaaaaaaaaaaaaaaaaaa').set(auth(S.owner)).send({ heroText: 'x' })).status).toBe(404);
    const r = await api().put(`/api/v1/seo/pages/${S.collegeId}`).set(auth(S.owner)).send({
      metaTitle: 'Sunrise Institute Pune | Alpha Admissions', metaDescription: 'Apply to Sunrise today.', heroText: 'Engineering made friendly',
      faqs: [{ q: 'Is hostel available?', a: 'Yes, for all years.' }], published: true,
    });
    expect(r.status).toBe(200);
    expect((await api().get(`/api/v1/seo/pages/${S.collegeId}`).set(auth(S.owner))).body.faqs).toHaveLength(1);
    const list = await api().get('/api/v1/seo/pages').set(auth(S.owner));
    const row = list.body.items.find((i: any) => i.collegeId === S.collegeId);
    expect(row.override.metaTitle).toContain('Sunrise');
    expect(row.publicUrl).toContain('/public/sites/alpha-seo/colleges/');
    // a college of another organisation is not reachable
    expect((await api().get(`/api/v1/seo/pages/${S.collegeId}`).set(auth(S.ownerB))).status).toBe(404);
    const audit = await api().get('/api/v1/audit').set(auth(S.owner));
    const actions = JSON.stringify(audit.body);
    expect(actions).toContain('seo.settings_updated');
    expect(actions).toContain('seo.page_saved');
  });

  it('preview shows an unpublished page to staff only', async () => {
    const slug = (await api().get('/api/v1/seo/pages').set(auth(S.owner))).body.items.find((i: any) => i.collegeId === S.collegeId).slug;
    const r = await api().get(`/api/v1/seo/preview/${slug}`).set(auth(S.owner));
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toContain('text/html');
    expect(r.text).toContain('noindex');
    const j = await api().get(`/api/v1/seo/preview/${slug}?format=json`).set(auth(S.owner));
    expect(j.body.html).toContain('Sunrise Institute');
    expect((await api().get('/api/v1/seo/preview/nope').set(auth(S.owner))).status).toBe(404);
  });
});

describe('public site (no login)', () => {
  let slug = '';
  it('college page: title, description, canonical, Open Graph, JSON-LD, FAQ, form', async () => {
    slug = (await api().get('/api/v1/seo/pages').set(auth(S.owner))).body.items.find((i: any) => i.collegeId === S.collegeId).slug;
    const r = await api().get(`${SITE}/colleges/${slug}`);
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toContain('text/html');
    expect(r.text).toContain('<title>Sunrise Institute Pune | Alpha Admissions</title>');
    expect(r.text).toContain('<meta name="description" content="Apply to Sunrise today.">');
    expect(r.text).toContain(`<link rel="canonical" href="http://api.test${SITE}/colleges/${slug}">`);
    expect(r.text).toContain('property="og:title"');
    expect(r.text).toContain('application/ld+json');
    expect(r.text).toContain('"@type":"CollegeOrUniversity"');
    expect(r.text).toContain('"@type":"FAQPage"');
    expect(r.text).toContain('Is hostel available?');
    expect(r.text).toContain('Engineering made friendly');
    expect(r.text).toContain('Alpha Admissions');
    expect(r.text).toContain('action="http://api.test/public/sites/alpha-seo/lead"');
    expect(r.headers['content-security-policy']).toContain("default-src 'none'");
    const { listCourses } = (await import('../../src/product/modules/colleges/index.js')) as Record<string, unknown>;
    if (listCourses) expect(r.text).toContain('B.Tech CSE'); // course table needs colleges to export listCourses
  });

  it('index lists colleges; sitemap and robots; json', async () => {
    const idx = await api().get(`${SITE}/`);
    expect(idx.status).toBe(200);
    expect(idx.text).toContain('Sunrise Institute');
    const sm = await api().get(`${SITE}/sitemap.xml`);
    expect(sm.headers['content-type']).toContain('xml');
    expect(sm.text).toContain(`${SITE}/colleges/${slug}</loc>`);
    const rb = await api().get(`${SITE}/robots.txt`);
    expect(rb.headers['content-type']).toContain('text/plain');
    expect(rb.text).toContain(`Sitemap: http://api.test${SITE}/sitemap.xml`);
    const j = await api().get(`${SITE}/colleges/${slug}.json`);
    expect(j.status).toBe(200);
    expect(j.body.college.name).toBe('Sunrise Institute');
    expect(j.body.faqs).toHaveLength(1);
    expect(JSON.stringify(j.body)).not.toContain('contact');
  });

  it('XSS payloads in college name/description are escaped in HTML, sitemap and JSON-LD', async () => {
    const r = await api().get(`${SITE}/colleges/evil`);
    expect(r.status).toBe(200);
    expect(r.text).not.toContain('<script>alert(1)');
    expect(r.text).not.toContain('<img src=x');
    expect(r.text).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    for (const m of r.text.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) expect(m[1]).not.toMatch(/[<>]/);
    const idx = await api().get(`${SITE}/`);
    expect(idx.text).not.toContain('<script>alert(1)');
  });

  it('unknown organisation, unknown college, suspended organisation and module-off all answer 404', async () => {
    expect((await api().get('/public/sites/nobody/')).status).toBe(404);
    expect((await api().get(`${SITE}/colleges/does-not-exist`)).status).toBe(404);
    expect((await api().get('/public/sites/off-seo/')).status).toBe(404); // seoPages not enabled
    expect((await api().get('/public/sites/off-seo/sitemap.xml')).status).toBe(404);
    expect((await api().get('/public/sites/susp-seo/')).status).toBe(200);
    expect((await api().patch(`/api/v1/platform/tenants/${S.tenantSusp}/status`).set(auth(S.super)).send({ status: 'suspended' })).status).toBe(200);
    expect((await api().get('/public/sites/susp-seo/')).status).toBe(404);
    expect((await api().get('/public/sites/susp-seo/robots.txt')).status).toBe(404);
  });

  it('unpublished page and de-selected colleges are hidden from visitors', async () => {
    await api().put(`/api/v1/seo/pages/${S.xssCollegeId}`).set(auth(S.owner)).send({ published: false });
    expect((await api().get(`${SITE}/colleges/evil`)).status).toBe(404);
    expect((await api().get(`${SITE}/sitemap.xml`)).text).not.toContain('/evil');
    await api().put(`/api/v1/seo/pages/${S.xssCollegeId}`).set(auth(S.owner)).send({ published: true });
    await api().put('/api/v1/seo/settings').set(auth(S.owner)).send({ enabledColleges: [S.collegeId] });
    expect((await api().get(`${SITE}/colleges/evil`)).status).toBe(404);
    expect((await api().get(`${SITE}/colleges/${slug}`)).status).toBe(200);
    await api().put('/api/v1/seo/settings').set(auth(S.owner)).send({ enabledColleges: [] });
  });
});

describe('lead form', () => {
  const form = (body: object, query = '') => api().post(`${SITE}/lead${query}`).type('form').send(body);
  const leads = async () => (await api().get('/api/v1/leads?limit=50').set(auth(S.owner))).body.items as any[];

  it('consent is required (400) and nothing is created', async () => {
    const r = await form({ name: 'No Consent', phone: '9811100001' });
    expect(r.status).toBe(400);
    expect(r.text).toContain('consent');
    const j = await api().post(`${SITE}/lead`).send({ name: 'No Consent', phone: '9811100001' });
    expect(j.status).toBe(400);
    expect(j.body.error.code).toBe('CONSENT_REQUIRED');
    expect((await leads()).some((l) => l.name === 'No Consent')).toBe(false);
  });

  it('honeypot: answers like success but creates nothing', async () => {
    const r = await form({ name: 'Bot Bob', phone: '9811100002', consent: 'yes', company_url: 'http://spam.test' });
    expect(r.status).toBe(200);
    expect(r.text).toContain('Thank you');
    expect((await leads()).some((l) => l.name === 'Bot Bob')).toBe(false);
  });

  it('creates a lead (channel website, utm from query) and shows a thank-you page', async () => {
    const r = await form({ name: 'Real Riya', phone: '98111 00003', consent: 'yes', city: 'Pune', course: 'B.Tech CSE' }, '?utm_source=google&utm_medium=cpc&utm_campaign=diwali');
    expect(r.status).toBe(200);
    expect(r.text).toContain('Thank you');
    const lead = (await leads()).find((l) => l.name === 'Real Riya');
    expect(lead.phone).toBe('+919811100003');
    expect(lead.source).toMatchObject({ channel: 'website', utmSource: 'google', utmMedium: 'cpc', utmCampaign: 'diwali' });
    expect(lead.consent.given).toBe(true);
    expect(lead.interestedCourse).toBe('B.Tech CSE');
  });

  it('JSON post works and a duplicate phone creates no second lead', async () => {
    const j = await api().post(`${SITE}/lead`).send({ name: 'Real Riya Again', phone: '9811100003', consent: true });
    expect(j.status).toBe(200);
    expect(j.body.ok).toBe(true);
    expect((await leads()).filter((l) => l.phone === '+919811100003')).toHaveLength(1);
    expect((await api().post(`${SITE}/lead`).send({ name: 'Bad Phone', phone: '123', consent: true })).status).toBe(400);
  });

  it('the lead belongs to the right organisation only', async () => {
    const other = (await api().get('/api/v1/leads?limit=50').set(auth(S.ownerB))).body.items as any[];
    expect(other.some((l) => l.name === 'Real Riya')).toBe(false);
  });

  it('lead form switched off in settings => 404; on again => works', async () => {
    await api().put('/api/v1/seo/settings').set(auth(S.owner)).send({ leadFormEnabled: false });
    expect((await form({ name: 'Off Olly', phone: '9811100005', consent: 'yes' })).status).toBe(404);
    await api().put('/api/v1/seo/settings').set(auth(S.owner)).send({ leadFormEnabled: true });
  });

  it('per-IP rate limit on the form (429)', async () => {
    const { LEAD_FORM_LIMIT } = await import('../../src/product/modules/seoPages/http/seo.public.routes.js');
    let limited = 0;
    for (let i = 0; i < LEAD_FORM_LIMIT + 3; i++) {
      const r = await api().post(`${SITE}/lead`).send({ name: 'Flood', phone: '9811100009', consent: true, company_url: 'x' });
      if (r.status === 429) limited++;
    }
    expect(limited).toBeGreaterThan(0);
  });
});
