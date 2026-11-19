import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/** Portal: invites, student surface, college surface, isolation, PII, staff endpoints closed to portal users, erasure, module switches. */
let mongod: MongoMemoryServer;
let app: import('express').Express;

const PW = 'Str0ng-Passw0rd!';
const api = () => request(app);
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const loginRes = (email: string, password = PW) => api().post('/api/v1/auth/login').send({ email, password });
const login = async (email: string, password = PW) => (await loginRes(email, password)).body.token as string;
const S: Record<string, string> = {};
const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.from('PORTAL-DOC-CONTENT '.repeat(10))]);

const upload = (token: string, q: Record<string, string>, body: Buffer, path = '/api/v1/portal/student/documents') =>
  api().post(path).query(q).set(auth(token)).set('x-file-name', 'doc.pdf').set('content-type', 'application/octet-stream').send(body);
const move = (token: string, id: string, to: string) => api().post(`/api/v1/applications/${id}/status`).set(auth(token)).send({ to });

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri(), { dbName: 'cp_master' });
  const { MemoryFileStore, setFileStore } = await import('../../src/shared/infra/fileStore.js');
  setFileStore(new MemoryFileStore());
  const { hashPassword } = await import('../../src/core/modules/identity/infrastructure/security.js');
  const { User } = await import('../../src/core/modules/identity/infrastructure/user.model.js');
  app = (await import('../../src/app/app.js')).buildApp();
  await User.create({ email: 'super@p.test', name: 'S', passwordHash: await hashPassword(PW), role: 'superadmin', tenantId: null });
  S.super = await login('super@p.test');
  const mk = async (name: string, slug: string, email: string) =>
    (await api().post('/api/v1/platform/tenants').set(auth(S.super)).send({ name, slug, ownerName: 'Owner', ownerEmail: email, ownerPassword: PW })).body.tenantId as string;
  S.tenant = await mk('Alpha Edu', 'alpha-edu', 'owner@alpha.test');
  S.tenantB = await mk('Beta Edu', 'beta-edu', 'owner@beta.test');
  S.tenantOff = await mk('Off Edu', 'off-edu', 'owner@off.test');
  const all = { students: true, colleges: true, applications: true, documents: true, studentPortal: true, collegePortal: true };
  for (const t of [S.tenant, S.tenantB]) { const mr = await api().patch(`/api/v1/platform/tenants/${t}/modules`).set(auth(S.super)).send({ modules: all }); expect([mr.status, JSON.stringify(mr.body)]).toEqual([200, expect.anything()]); }
  expect((await api().patch(`/api/v1/platform/tenants/${S.tenantOff}/modules`).set(auth(S.super)).send({ modules: { students: true, colleges: true, applications: true, documents: true } })).status).toBe(200);
  S.owner = await login('owner@alpha.test');
  S.ownerB = await login('owner@beta.test');
  S.ownerOff = await login('owner@off.test');

  const st = async (token: string, name: string, phone: string, email?: string) =>
    (await api().post('/api/v1/students').set(auth(token)).send({ name, phone, email, dob: '2000-01-01', address: { city: 'Pune' }, guardian: { name: 'Father', phone: '9811111111' }, academics: [{ level: '12th', board: 'CBSE', percentage: 88 }], consent: { given: true } })).body._id as string;
  S.s1 = await st(S.owner, 'Ravi Kumar', '9876543210', 'ravi@stud.test');
  S.s2 = await st(S.owner, 'Sita Devi', '9876543211', 'sita@stud.test');
  S.s3 = await st(S.owner, 'No Email', '9876543212');
  S.sOff = await st(S.ownerOff, 'Off Student', '9876543210', 'off@stud.test');
  const mkCollege = async (name: string) => {
    const c = (await api().post('/api/v1/colleges').set(auth(S.owner)).send({ name, city: 'Pune' })).body._id as string;
    const course = (await api().post(`/api/v1/colleges/${c}/courses`).set(auth(S.owner)).send({ name: 'MBA', level: 'pg', annualFeePaise: 100000, durationMonths: 24, intakes: [{ month: 8, year: 2099 }] })).body._id as string;
    return { c, course };
  };
  const cx = await mkCollege('College X');
  const cy = await mkCollege('College Y');
  S.cx = cx.c;
  S.cy = cy.c;
  const mkApp = async (studentId: string, col: { c: string; course: string }) => {
    const r = await api().post('/api/v1/applications').set(auth(S.owner)).send({ studentId, collegeId: col.c, courseId: col.course, intake: { month: 8, year: 2099 } });
    expect(r.status).toBe(201);
    return r.body._id as string;
  };
  S.a1 = await mkApp(S.s1, cx); // Ravi -> College X
  S.a2 = await mkApp(S.s2, cy); // Sita -> College Y
  for (const a of [S.a1, S.a2]) for (const to of ['documents_pending', 'ready_to_submit', 'submitted']) expect((await move(S.owner, a, to)).status).toBe(200);
});

afterAll(async () => {
  const { setFileStore } = await import('../../src/shared/infra/fileStore.js');
  setFileStore(null);
  await mongoose.disconnect();
  await mongod?.stop();
});

const invite = (token: string, body: object, kind: 'student' | 'college' = 'student') => api().post(`/api/v1/portal/${kind}-invites`).set(auth(token)).send(body);

describe('invites', () => {
  it('refuses a student without email, an erased/unknown student, and a module-off organisation', async () => {
    const noEmail = await invite(S.owner, { studentId: S.s3 });
    expect(noEmail.status).toBe(400);
    expect(noEmail.body.error.message).toMatch(/email/i);
    expect((await invite(S.owner, { studentId: 'a'.repeat(24) })).status).toBe(404);
    expect((await invite(S.owner, { studentId: 'bad' })).status).toBe(400);
    const off = await invite(S.ownerOff, { studentId: S.sOff });
    expect(off.status).toBe(403);
    expect(off.body.error.code).toBe('MODULE_NOT_ENABLED');
    expect((await invite(S.ownerOff, { collegeId: S.cx, name: 'x', email: 'x@y.test' }, 'college')).body.error.code).toBe('MODULE_NOT_ENABLED');
  });

  it('creates student + college logins, shows the temporary password once, and it works for login', async () => {
    const r1 = await invite(S.owner, { studentId: S.s1 });
    expect(r1.status).toBe(201);
    expect(r1.body.temporaryPassword).toMatch(/.{12,}/);
    expect(r1.body.invite.email).toBe('ravi@stud.test');
    S.inv1 = r1.body.invite.id;
    S.pw1 = r1.body.temporaryPassword;
    const r2 = await invite(S.owner, { studentId: S.s2 });
    S.pw2 = r2.body.temporaryPassword;
    S.inv2 = r2.body.invite.id;
    const c1 = await invite(S.owner, { collegeId: S.cx, name: 'Xavier Admissions', email: 'adm@x.test' }, 'college');
    expect(c1.status).toBe(201);
    S.pwX = c1.body.temporaryPassword;
    S.invX = c1.body.invite.id;
    S.pwY = (await invite(S.owner, { collegeId: S.cy, name: 'Yara Admissions', email: 'adm@y.test' }, 'college')).body.temporaryPassword;

    S.stud1 = await login('ravi@stud.test', S.pw1);
    S.stud2 = await login('sita@stud.test', S.pw2);
    S.colX = await login('adm@x.test', S.pwX);
    S.colY = await login('adm@y.test', S.pwY);
    for (const t of [S.stud1, S.stud2, S.colX, S.colY]) expect(t).toBeTruthy();
    expect((await loginRes('ravi@stud.test', 'wrong-password-1')).status).toBe(401);
  });

  it('the password is not listed afterwards; duplicates are refused', async () => {
    const list = await api().get('/api/v1/portal/student-invites').set(auth(S.owner));
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(2);
    expect(JSON.stringify(list.body)).not.toContain(S.pw1);
    expect(list.body.items[0].subjectName).toBeTruthy();
    expect((await invite(S.owner, { studentId: S.s1 })).status).toBe(409);
    expect((await invite(S.owner, { collegeId: S.cy, name: 'Dup', email: 'ADM@x.test' }, 'college')).status).toBe(409);
  });

  it('portal users cannot invite; invites are isolated between organisations', async () => {
    expect((await invite(S.stud1, { studentId: S.s2 })).status).toBe(403);
    expect((await invite(S.colX, { collegeId: S.cy, name: 'a', email: 'a@b.test' }, 'college')).status).toBe(403);
    expect((await invite(S.ownerB, { studentId: S.s1 })).status).toBe(404);
    expect((await api().get('/api/v1/portal/student-invites').set(auth(S.ownerB))).body.items).toHaveLength(0);
  });
});

describe('student portal', () => {
  it('overview: own profile, own applications with status + history + checklist; no staff-only fields', async () => {
    const r = await api().get('/api/v1/portal/student/overview').set(auth(S.stud1));
    expect(r.status).toBe(200);
    expect(r.body.profile.name).toBe('Ravi Kumar');
    expect(r.body.applications).toHaveLength(1);
    expect(r.body.applications[0]).toMatchObject({ id: S.a1, collegeName: 'College X', courseName: 'MBA', status: 'submitted' });
    expect(r.body.applications[0].statusHistory.length).toBeGreaterThan(0);
    expect(Array.isArray(r.body.applications[0].checklist)).toBe(true);
    const text = JSON.stringify(r.body);
    for (const f of ['assignedTo', 'createdBy', 'leadId', 'consent', 'guardian', 'Sita', S.s2]) expect(text).not.toContain(f);
    expect(r.body.applications[0].statusHistory[0].by).toBeUndefined();
  });

  it('two students cannot see each other (id comes from the login only)', async () => {
    expect((await api().get(`/api/v1/portal/student/applications/${S.a2}`).set(auth(S.stud1))).status).toBe(404);
    expect((await api().get(`/api/v1/portal/student/applications/${S.a1}`).set(auth(S.stud1))).status).toBe(200);
    const o2 = await api().get('/api/v1/portal/student/overview?studentId=' + S.s1).set(auth(S.stud2));
    expect(o2.body.profile.name).toBe('Sita Devi');
    expect(o2.body.applications.map((a: any) => a.id)).toEqual([S.a2]);
    // upload for someone else's application is refused; a studentId in the query is ignored
    expect((await upload(S.stud1, { type: 'marksheet', applicationId: S.a2 }, PDF)).status).toBe(404);
  });

  it('uploads own document (uploadedBy student), validation, and staff sees it', async () => {
    expect((await upload(S.stud1, { type: 'marksheet' }, Buffer.from('MZ not a pdf'))).status).toBe(400);
    expect((await upload(S.stud1, { type: 'marksheet' }, Buffer.alloc(0))).status).toBe(400);
    expect((await api().post('/api/v1/portal/student/documents').set(auth(S.stud1)).send({})).status).toBe(400);
    const ok = await upload(S.stud1, { type: 'marksheet', applicationId: S.a1, studentId: S.s2 }, PDF);
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ type: 'marksheet', status: 'pending_review', version: 1 });
    S.doc1 = ok.body.id;
    const staff = await api().get(`/api/v1/documents?studentId=${S.s1}`).set(auth(S.owner));
    expect(staff.body.items.find((d: any) => d._id === S.doc1).uploadedBy).toBe('student');
    expect((await api().get(`/api/v1/documents?studentId=${S.s2}`).set(auth(S.owner))).body.items).toHaveLength(0);
    const mine = await api().get('/api/v1/portal/student/documents').set(auth(S.stud1));
    expect(mine.body.items).toHaveLength(1);
    expect((await api().get('/api/v1/portal/student/documents').set(auth(S.stud2))).body.items).toHaveLength(0);
    const again = await upload(S.stud1, { type: 'marksheet', applicationId: S.a1 }, PDF);
    expect(again.body.version).toBe(2);
  });

  it('a college login cannot use the student surface and vice versa', async () => {
    expect((await api().get('/api/v1/portal/student/overview').set(auth(S.colX))).status).toBe(403);
    expect((await api().get('/api/v1/portal/college/applications').set(auth(S.stud1))).status).toBe(403);
  });
});

describe('college portal', () => {
  it('lists only its own applications with name + academics and NO contact details', async () => {
    const r = await api().get('/api/v1/portal/college/applications').set(auth(S.colX));
    expect(r.status).toBe(200);
    expect(r.body.items.map((a: any) => a.id)).toEqual([S.a1]);
    expect(r.body.items[0].student.name).toBe('Ravi Kumar');
    expect(r.body.items[0].student.academics[0]).toMatchObject({ level: '12th', percentage: 88 });
    const text = JSON.stringify(r.body);
    for (const f of ['9876543210', 'ravi@stud.test', 'Pune', 'Father', '9811111111', 'dob', 'assignedTo', 'Sita']) expect(text).not.toContain(f);
    const y = await api().get('/api/v1/portal/college/applications').set(auth(S.colY));
    expect(y.body.items.map((a: any) => a.id)).toEqual([S.a2]);
  });

  it('two colleges cannot see or touch each other\'s applications', async () => {
    expect((await api().get(`/api/v1/portal/college/applications/${S.a2}`).set(auth(S.colX))).status).toBe(404);
    expect((await api().post(`/api/v1/portal/college/applications/${S.a2}/status`).set(auth(S.colX)).send({ to: 'under_review' })).status).toBe(404);
    expect((await api().get(`/api/v1/portal/college/applications/${S.a2}/documents`).set(auth(S.colX))).status).toBe(404);
    expect((await api().get(`/api/v1/portal/college/applications/${S.a1}`).set(auth(S.colX))).status).toBe(200);
  });

  it('status updates: allowed transitions only, state machine applies, audited', async () => {
    for (const to of ['submitted', 'declined', 'fee_paid', 'withdrawn', 'bogus']) expect((await api().post(`/api/v1/portal/college/applications/${S.a1}/status`).set(auth(S.colX)).send({ to })).status).toBe(403);
    const skip = await api().post(`/api/v1/portal/college/applications/${S.a1}/status`).set(auth(S.colX)).send({ to: 'offered' });
    expect(skip.status).toBe(409);
    expect(skip.body.error.code).toBe('ILLEGAL_TRANSITION');
    const u = await api().post(`/api/v1/portal/college/applications/${S.a1}/status`).set(auth(S.colX)).send({ to: 'under_review', note: 'Looks good' });
    expect(u.status).toBe(200);
    expect(u.body.status).toBe('under_review');
    expect((await api().post(`/api/v1/portal/college/applications/${S.a1}/status`).set(auth(S.colX)).send({ to: 'offered' })).body.status).toBe('offered');
    // the student sees it, and the staff history records the college user
    const stu = await api().get(`/api/v1/portal/student/applications/${S.a1}`).set(auth(S.stud1));
    expect(stu.body.status).toBe('offered');
    const audits = (await api().get(`/api/v1/audit?entityId=${S.a1}&limit=100`).set(auth(S.owner))).body.items.map((a: any) => a.action);
    expect(audits).toEqual(expect.arrayContaining(['application.status_changed', 'portal.college_status_updated']));
    // staff + student steps, then the college admits
    for (const to of ['accepted', 'fee_paid']) expect((await move(S.owner, S.a1, to)).status).toBe(200);
    expect((await api().post(`/api/v1/portal/college/applications/${S.a1}/status`).set(auth(S.colX)).send({ to: 'admitted' })).body.status).toBe('admitted');
  });

  it('verified documents only, with a signed download that returns the real file', async () => {
    const docs = (await api().get(`/api/v1/documents?studentId=${S.s1}`).set(auth(S.owner))).body.items;
    const live = docs.find((d: any) => !d.supersededBy);
    expect((await api().get(`/api/v1/portal/college/applications/${S.a1}/documents`).set(auth(S.colX))).body.items).toHaveLength(0); // still pending_review
    expect((await api().post(`/api/v1/portal/college/applications/${S.a1}/documents/${live._id}/download-link`).set(auth(S.colX))).status).toBe(404);
    expect((await api().post(`/api/v1/documents/${live._id}/verify`).set(auth(S.owner))).status).toBe(200);
    const list = await api().get(`/api/v1/portal/college/applications/${S.a1}/documents`).set(auth(S.colX));
    expect(list.body.items).toHaveLength(1);
    expect(JSON.stringify(list.body)).not.toMatch(/storageKey|sha256/);
    const link = await api().post(`/api/v1/portal/college/applications/${S.a1}/documents/${live._id}/download-link`).set(auth(S.colX));
    expect(link.status).toBe(200);
    const f = await api().get(link.body.url).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(f.status).toBe(200);
    expect((f.body as Buffer).equals(PDF)).toBe(true);
    // another college cannot get a link to it
    expect((await api().post(`/api/v1/portal/college/applications/${S.a1}/documents/${live._id}/download-link`).set(auth(S.colY))).status).toBe(404);
    const audits = (await api().get(`/api/v1/audit?entityId=${live._id}&limit=100`).set(auth(S.owner))).body.items.map((a: any) => a.action);
    expect(audits).toEqual(expect.arrayContaining(['document.download_link_issued', 'document.downloaded']));
  });
});

describe('portal users reach ONLY /portal/*', () => {
  it('get 403 on staff endpoints, for both portal roles', async () => {
    const paths: [string, string][] = [
      ['get', '/api/v1/leads'],
      ['get', '/api/v1/students'],
      ['get', `/api/v1/students/${S.s1}`],
      ['get', '/api/v1/colleges'],
      ['get', '/api/v1/applications'],
      ['get', `/api/v1/documents?studentId=${S.s1}`],
      ['get', '/api/v1/documents/queue'],
      ['get', '/api/v1/audit'],
      ['get', '/api/v1/portal/student-invites'],
      ['post', '/api/v1/portal/student-invites'],
    ];
    for (const t of [S.stud1, S.colX]) {
      for (const [m, p] of paths) {
        const r = await (api() as any)[m](p).set(auth(t)).send({});
        expect([p, r.status]).toEqual([p, 403]);
      }
    }
    expect((await api().get('/api/v1/portal/student/overview')).status).toBe(401);
  });
});

describe('disable, erasure, module switch', () => {
  it('a disabled invite blocks login and existing tokens', async () => {
    const before = await api().get('/api/v1/portal/college/applications').set(auth(S.colY));
    expect(before.status).toBe(200);
    const inv = (await api().get('/api/v1/portal/college-invites').set(auth(S.owner))).body.items.find((i: any) => i.email === 'adm@y.test');
    expect((await api().post(`/api/v1/portal/college-invites/${inv.id}/disable`).set(auth(S.owner))).body.status).toBe('disabled');
    expect((await loginRes('adm@y.test', S.pwY)).status).toBeGreaterThanOrEqual(401);
    expect((await api().get('/api/v1/portal/college/applications').set(auth(S.colY))).status).toBeGreaterThanOrEqual(401);
    expect((await api().post(`/api/v1/portal/college-invites/${'a'.repeat(24)}/disable`).set(auth(S.owner))).status).toBe(404);
  });

  it('erasing a student disables their portal login and invite', async () => {
    const e = await api().post(`/api/v1/students/${S.s2}/erase`).set(auth(S.owner)).send({ confirm: 'ERASE', reason: 'Parent request' });
    expect(e.status).toBe(200);
    expect((await loginRes('sita@stud.test', S.pw2)).status).toBeGreaterThanOrEqual(401);
    expect((await api().get('/api/v1/portal/student/overview').set(auth(S.stud2))).status).toBeGreaterThanOrEqual(401);
    const list = (await api().get('/api/v1/portal/student-invites').set(auth(S.owner))).body.items.find((i: any) => i.email === 'sita@stud.test');
    expect(list.status).toBe('disabled');
  });

  it('turning the module off closes that surface only (403 MODULE_NOT_ENABLED)', async () => {
    expect((await api().patch(`/api/v1/platform/tenants/${S.tenant}/modules`).set(auth(S.super)).send({ modules: { studentPortal: false } })).status).toBe(200);
    const s = await api().get('/api/v1/portal/student/overview').set(auth(S.stud1));
    expect(s.status).toBe(403);
    expect(s.body.error.code).toBe('MODULE_NOT_ENABLED');
    expect((await api().get('/api/v1/portal/college/applications').set(auth(S.colX))).status).toBe(200);
    expect((await invite(S.owner, { studentId: S.s3 })).body.error.code).toBe('MODULE_NOT_ENABLED');
  });
});

describe('invite audit rows', () => {
  it('records created and disabled', async () => {
    const actions = (await api().get('/api/v1/audit?limit=100').set(auth(S.owner))).body.items.map((a: any) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['portal.invite_created', 'portal.invite_disabled', 'portal.student_document_uploaded']));
  });
});
