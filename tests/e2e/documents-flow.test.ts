import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/** Documents: encrypted vault, magic-byte validation, checklist, verification, signed audited downloads, status guard, erasure, scope, isolation. */
let mongod: MongoMemoryServer;
let app: import('express').Express;
let store: import('../../src/shared/infra/fileStore.js').MemoryFileStore;
let crypto: typeof import('../../src/shared/infra/crypto.js');

const PW = 'Str0ng-Passw0rd!';
const api = () => request(app);
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const login = async (email: string) => (await api().post('/api/v1/auth/login').send({ email, password: PW })).body.token as string;
const S = { super: '', tenant: '', tenantB: '', tenantOff: '', owner: '', ownerB: '', ownerOff: '', counsellor: '', counsellorId: '', other: '', support: '', student: '', student2: '', studentB: '', collegeId: '', courseId: '', appId: '' };

const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.from('SECRET-MARKSHEET-CONTENT '.repeat(20))]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('png-body-bytes')]);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('jpeg-body-bytes')]);

const upload = (token: string, q: Record<string, string>, body: Buffer, name = 'file.pdf', ctype = 'application/octet-stream') =>
  api()
    .post('/api/v1/documents')
    .query(q)
    .set(auth(token))
    .set('x-file-name', name)
    .set('content-type', ctype)
    .send(body);
const up = (token: string, studentId: string, type: string, body: Buffer = PDF, extra: Record<string, string> = {}) => upload(token, { studentId, type, ...extra }, body);
const checklist = (token: string, q: string) => api().get(`/api/v1/documents/checklist?${q}`).set(auth(token));
const move = (token: string, id: string, to: string) => api().post(`/api/v1/applications/${id}/status`).set(auth(token)).send({ to });
const auditActions = async (entityId: string) => (await api().get(`/api/v1/audit?entityId=${entityId}&limit=100`).set(auth(S.owner))).body.items.map((a: any) => a.action);

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri(), { dbName: 'cp_master' });
  const { MemoryFileStore, setFileStore } = await import('../../src/shared/infra/fileStore.js');
  store = new MemoryFileStore();
  setFileStore(store);
  crypto = await import('../../src/shared/infra/crypto.js');
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
  for (const t of [S.tenant, S.tenantB]) {
    const r = await api().patch(`/api/v1/platform/tenants/${t}/modules`).set(auth(S.super)).send({ modules: { students: true, colleges: true, applications: true, documents: true } });
    expect(r.status).toBe(200);
  }
  S.owner = await login('owner@alpha.test');
  S.ownerB = await login('owner@beta.test');
  S.ownerOff = await login('owner@off.test');
  const add = async (name: string, email: string, role: string) => (await api().post('/api/v1/team').set(auth(S.owner)).send({ name, email, password: PW, role })).body.id as string;
  S.counsellorId = await add('Asha Counsellor', 'asha@alpha.test', 'counsellor');
  await add('Bina Counsellor', 'bina@alpha.test', 'counsellor');
  await add('Sam Support', 'sam@alpha.test', 'support');
  S.counsellor = await login('asha@alpha.test');
  S.other = await login('bina@alpha.test');
  S.support = await login('sam@alpha.test');

  const st = async (token: string, phone: string, extra: object = {}) =>
    (await api().post('/api/v1/students').set(auth(token)).send({ name: 'Ravi Kumar', phone, dob: '2000-01-01', consent: { given: true }, ...extra })).body._id as string;
  S.student = await st(S.owner, '9876543210', { assignedTo: S.counsellorId });
  S.student2 = await st(S.owner, '9876543211');
  S.studentB = await st(S.ownerB, '9876543210');
  const col = await api()
    .post('/api/v1/colleges')
    .set(auth(S.owner))
    .send({
      name: 'Delta Institute',
      city: 'Pune',
      requiredDocuments: [
        { type: 'marksheet', label: '12th marksheet', mandatory: true },
        { type: 'id', label: 'ID proof', mandatory: true },
        { type: 'photo', label: 'Photo', mandatory: false },
      ],
    });
  S.collegeId = col.body._id;
  S.courseId = (await api().post(`/api/v1/colleges/${S.collegeId}/courses`).set(auth(S.owner)).send({ name: 'MBA', level: 'pg', annualFeePaise: 150000000, durationMonths: 24, intakes: [{ month: 8, year: 2099 }] })).body._id;
  const a = await api().post('/api/v1/applications').set(auth(S.owner)).send({ studentId: S.student, collegeId: S.collegeId, courseId: S.courseId, intake: { month: 8, year: 2099 } });
  expect(a.status).toBe(201);
  S.appId = a.body._id;
});

afterAll(async () => {
  const { setFileStore } = await import('../../src/shared/infra/fileStore.js');
  setFileStore(null);
  await mongoose.disconnect();
  await mongod?.stop();
});

describe('module switch and permissions', () => {
  it('module off => 403 MODULE_NOT_ENABLED', async () => {
    const r = await api().get(`/api/v1/documents?studentId=${S.student}`).set(auth(S.ownerOff));
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('MODULE_NOT_ENABLED');
  });
  it('support can read but not upload, download or verify; counsellor cannot verify; no token is 401', async () => {
    expect((await api().get(`/api/v1/documents?studentId=${S.student}`).set(auth(S.support))).status).toBe(200);
    expect((await up(S.support, S.student, 'marksheet')).status).toBe(403);
    expect((await api().post(`/api/v1/documents/${'a'.repeat(24)}/download-link`).set(auth(S.support))).status).toBe(403);
    expect((await api().post(`/api/v1/documents/${'a'.repeat(24)}/verify`).set(auth(S.counsellor))).status).toBe(403);
    expect((await api().get('/api/v1/documents/queue').set(auth(S.counsellor))).status).toBe(403);
    expect((await api().get(`/api/v1/documents?studentId=${S.student}`)).status).toBe(401);
  });
});

describe('upload: validation and encryption', () => {
  it('rejects missing/invalid query and a non-raw body', async () => {
    expect((await upload(S.owner, { type: 'marksheet' }, PDF)).status).toBe(400);
    expect((await upload(S.owner, { studentId: 'bad', type: 'marksheet' }, PDF)).status).toBe(400);
    expect((await upload(S.owner, { studentId: S.student }, PDF)).status).toBe(400);
    expect((await up(S.owner, 'a'.repeat(24), 'marksheet')).status).toBe(404);
  });

  it('accepts only PDF/JPEG/PNG by CONTENT: spoofed content types and names are refused', async () => {
    const exe = Buffer.from('MZ\x90\x00this is an executable pretending to be a pdf');
    const spoof = await upload(S.owner, { studentId: S.student, type: 'marksheet' }, exe, 'marksheet.pdf', 'application/pdf');
    expect(spoof.status).toBe(400);
    expect(spoof.body.error.message).toMatch(/PDF, JPEG or PNG/);
    expect((await upload(S.owner, { studentId: S.student, type: 'marksheet' }, Buffer.from('<html><script>1</script>'), 'a.png', 'image/png')).status).toBe(400);
    expect((await upload(S.owner, { studentId: S.student, type: 'marksheet' }, Buffer.from('GIF89a....'), 'a.pdf', 'application/pdf')).status).toBe(400);
    expect(store.files.size).toBe(0); // nothing was stored for refused files
  });

  it('rejects an empty file and a file over the size limit (413)', async () => {
    const empty = await upload(S.owner, { studentId: S.student, type: 'marksheet' }, Buffer.alloc(0));
    expect(empty.status).toBe(400);
    const big = await upload(S.owner, { studentId: S.student, type: 'marksheet' }, Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(11 * 1024 * 1024)]));
    expect(big.status).toBe(413);
    expect(big.body.error.code).toBe('FILE_TOO_LARGE');
    expect(store.files.size).toBe(0);
  });

  it('stores ENCRYPTED bytes, returns metadata only, and a modified ciphertext cannot be decrypted', async () => {
    const r = await up(S.owner, S.student, 'marksheet', PDF, { label: '12th' });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ type: 'marksheet', status: 'pending_review', version: 1, mimeType: 'application/pdf', sizeBytes: PDF.length });
    expect(r.body.storageKey).toBeUndefined();
    expect(r.body.sha256).toBe(crypto.sha256Hex(PDF));

    expect(store.files.size).toBe(1);
    const [key, stored] = [...store.files.entries()][0];
    expect(key).toBe(`${S.tenant}/${S.student}/${r.body._id}`);
    expect(stored.equals(PDF)).toBe(false);
    expect(stored.includes(Buffer.from('SECRET-MARKSHEET-CONTENT'))).toBe(false);
    expect(crypto.decryptBuffer(stored).equals(PDF)).toBe(true);
    const tampered = Buffer.from(stored);
    tampered[tampered.length - 1] ^= 0xff;
    expect(() => crypto.decryptBuffer(tampered)).toThrow();
  });

  it('key path traversal is impossible', async () => {
    const { getFileStore, LocalFileStore } = await import('../../src/shared/infra/fileStore.js');
    for (const bad of ['../x', 'a/../../b', '/etc/passwd', 'a\\..\\b', 'a/../b']) {
      await expect(getFileStore().put(bad, Buffer.from('x'))).rejects.toMatchObject({ code: 'BAD_FILE_KEY' });
      await expect(new LocalFileStore('./tmp-never-written').get(bad)).rejects.toMatchObject({ code: 'BAD_FILE_KEY' });
    }
  });

  it('strips path parts from the file name', async () => {
    const r = await upload(S.owner, { studentId: S.student2, type: 'photo' }, JPG, '..%2F..%2Fetc%2Fphoto.jpg');
    expect(r.status).toBe(201);
    expect(r.body.fileName).toBe('photo.jpg');
    expect(r.body.mimeType).toBe('image/jpeg');
    expect((await upload(S.owner, { studentId: S.student2, type: 'photo' }, PNG, 'x.png')).body.mimeType).toBe('image/png');
  });
});

describe('versioning, list, checklist', () => {
  it('re-uploading the same type supersedes the old version', async () => {
    const v2 = await up(S.owner, S.student, 'marksheet');
    expect(v2.status).toBe(201);
    expect(v2.body.version).toBe(2);
    const list = await api().get(`/api/v1/documents?studentId=${S.student}`).set(auth(S.owner));
    const ms = list.body.items.filter((d: any) => d.type === 'marksheet');
    expect(ms).toHaveLength(2);
    expect(ms.find((d: any) => d.version === 1).supersededBy).toBe(v2.body._id);
    expect(ms.find((d: any) => d.version === 2).supersededBy).toBeUndefined();
  });

  it('checklist: missing / pending_review / rejected / verified for an application', async () => {
    let c = await checklist(S.owner, `studentId=${S.student}&applicationId=${S.appId}`);
    expect(c.status).toBe(200);
    expect(Object.fromEntries(c.body.items.map((i: any) => [i.type, i.state]))).toEqual({ marksheet: 'pending_review', id: 'missing', photo: 'missing' });
    expect(c.body.complete).toBe(false);

    const list = await api().get(`/api/v1/documents?studentId=${S.student}`).set(auth(S.owner));
    const live = list.body.items.find((d: any) => d.type === 'marksheet' && !d.supersededBy);
    const rej = await api().post(`/api/v1/documents/${live._id}/reject`).set(auth(S.owner)).send({});
    expect(rej.status).toBe(400); // reason required
    expect((await api().post(`/api/v1/documents/${live._id}/reject`).set(auth(S.owner)).send({ reason: 'Image is blurred' })).body.status).toBe('rejected');
    c = await checklist(S.owner, `studentId=${S.student}&applicationId=${S.appId}`);
    expect(c.body.items.find((i: any) => i.type === 'marksheet')).toMatchObject({ state: 'rejected', rejectReason: 'Image is blurred' });
    const v = await api().post(`/api/v1/documents/${live._id}/verify`).set(auth(S.owner));
    expect(v.body.status).toBe('verified');
    expect(v.body.rejectReason).toBeUndefined();
    expect(await auditActions(live._id)).toEqual(expect.arrayContaining(['document.rejected', 'document.verified', 'document.uploaded']));
  });

  it('verification queue lists pending items with the student name', async () => {
    const q = await api().get('/api/v1/documents/queue').set(auth(S.owner));
    expect(q.status).toBe(200);
    expect(q.body.items.length).toBeGreaterThan(0);
    expect(q.body.items.every((d: any) => d.status === 'pending_review' && d.studentName)).toBe(true);
  });

  it('delete: only pending/rejected; verified is refused (409); deleting removes the file', async () => {
    const list = await api().get(`/api/v1/documents?studentId=${S.student}`).set(auth(S.owner));
    const verified = list.body.items.find((d: any) => d.status === 'verified');
    expect((await api().delete(`/api/v1/documents/${verified._id}`).set(auth(S.owner))).status).toBe(409);
    const tmp = await up(S.owner, S.student2, 'extra');
    const filesBefore = store.files.size;
    expect((await api().delete(`/api/v1/documents/${tmp.body._id}`).set(auth(S.owner))).status).toBe(200);
    expect(store.files.size).toBe(filesBefore - 1);
    expect((await api().post(`/api/v1/documents/${tmp.body._id}/download-link`).set(auth(S.owner))).status).toBe(404);
    expect(await auditActions(tmp.body._id)).toContain('document.deleted');
  });
});

describe('mandatory-documents guard on the real applications endpoint', () => {
  it('blocks "submitted" until every mandatory item is verified, then allows it', async () => {
    for (const to of ['documents_pending', 'ready_to_submit']) expect((await move(S.owner, S.appId, to)).status).toBe(200);
    const blocked = await move(S.owner, S.appId, 'submitted');
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('STATUS_BLOCKED');
    expect(blocked.body.error.message).toContain('ID proof');
    expect(blocked.body.error.message).not.toContain('12th marksheet'); // already verified
    expect(blocked.body.error.message).not.toContain('Photo'); // optional

    const idDoc = await up(S.owner, S.student, 'id', PNG, { applicationId: S.appId });
    expect(idDoc.status).toBe(201);
    expect((await move(S.owner, S.appId, 'submitted')).status).toBe(409); // pending_review is not enough
    await api().post(`/api/v1/documents/${idDoc.body._id}/verify`).set(auth(S.owner));
    const ok = await move(S.owner, S.appId, 'submitted');
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('submitted');
    const c = await checklist(S.owner, `studentId=${S.student}&applicationId=${S.appId}`);
    expect(c.body.complete).toBe(true);
  });
});

describe('download: signed link, audited, expiry, tamper, isolation', () => {
  let docId = '';
  let url = '';
  it('issues a link and streams the DECRYPTED file with safe headers; both steps are audited', async () => {
    docId = (await api().get(`/api/v1/documents?studentId=${S.student}`).set(auth(S.owner))).body.items.find((d: any) => d.type === 'marksheet' && !d.supersededBy)._id;
    const link = await api().post(`/api/v1/documents/${docId}/download-link`).set(auth(S.owner));
    expect(link.status).toBe(200);
    expect(link.body.url).toMatch(/^\/public\/documents\/file\//);
    expect(link.body.expiresInSeconds).toBeGreaterThan(0);
    url = link.body.url;
    const f = await api().get(url).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(f.status).toBe(200);
    expect(Buffer.from(f.body).equals(PDF)).toBe(true);
    expect(f.headers['content-disposition']).toMatch(/^attachment;/);
    expect(f.headers['cache-control']).toBe('no-store');
    expect(f.headers['content-type']).toContain('application/pdf');
    const actions = await auditActions(docId);
    expect(actions).toContain('document.download_link_issued');
    expect(actions).toContain('document.downloaded');
    const row = (await api().get(`/api/v1/audit?entityId=${docId}&limit=100`).set(auth(S.owner))).body.items.find((a: any) => a.action === 'document.downloaded');
    expect(row.meta.issuedTo).toBeTruthy();
  });

  it('a tampered, truncated or garbage token is 403', async () => {
    const token = url.split('/').pop()!;
    const [body, sig] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url').toString()), documentId: 'b'.repeat(24) })).toString('base64url');
    for (const bad of [`${forged}.${sig}`, `${body}.${sig.slice(0, -2)}00`, `${body}`, 'garbage', `${body}.`]) {
      const r = await api().get(`/public/documents/file/${bad}`);
      expect(r.status).toBe(403);
    }
  });

  it('an expired token is 403', async () => {
    const { createDownloadToken } = await import('../../src/product/modules/documents/domain/document.domain.js');
    const { env } = await import('../../src/config/env.js');
    const old = createDownloadToken({ tenantId: S.tenant, documentId: docId, userId: 'u' }, 60, Date.now() - 3600_000, (d) => crypto.hmacHex(env.JWT_SECRET, d));
    expect((await api().get(`/public/documents/file/${old}`)).status).toBe(403);
    const fresh = createDownloadToken({ tenantId: S.tenant, documentId: docId, userId: 'u' }, 60, Date.now(), (d) => crypto.hmacHex(env.JWT_SECRET, d));
    expect((await api().get(`/public/documents/file/${fresh}`)).status).toBe(200);
  });

  it('another organisation cannot read this organisation\'s document by id, list or token tampering', async () => {
    expect((await api().post(`/api/v1/documents/${docId}/download-link`).set(auth(S.ownerB))).status).toBe(404);
    expect((await api().get(`/api/v1/documents?studentId=${S.student}`).set(auth(S.ownerB))).status).toBe(404);
    // a token re-pointed at the other tenant fails the signature
    const token = url.split('/').pop()!;
    const [body, sig] = token.split('.');
    const swapped = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url').toString()), tenantId: S.tenantB })).toString('base64url');
    expect((await api().get(`/public/documents/file/${swapped}.${sig}`)).status).toBe(403);
    // and a validly signed token for tenant B cannot reach tenant A's document (it is looked up in B's database)
    const { createDownloadToken } = await import('../../src/product/modules/documents/domain/document.domain.js');
    const { env } = await import('../../src/config/env.js');
    const cross = createDownloadToken({ tenantId: S.tenantB, documentId: docId, userId: 'u' }, 60, Date.now(), (d) => crypto.hmacHex(env.JWT_SECRET, d));
    expect((await api().get(`/public/documents/file/${cross}`)).status).toBe(403);
  });

  it('the public route refuses when the module is switched off for the organisation', async () => {
    const link = await api().post(`/api/v1/documents/${docId}/download-link`).set(auth(S.owner));
    await api().patch(`/api/v1/platform/tenants/${S.tenant}/modules`).set(auth(S.super)).send({ modules: { documents: false } });
    expect((await api().get(link.body.url)).status).toBe(403);
    await api().patch(`/api/v1/platform/tenants/${S.tenant}/modules`).set(auth(S.super)).send({ modules: { documents: true } });
    expect((await api().get(link.body.url)).status).toBe(200);
  });
});

describe('counsellor data scope', () => {
  it('a counsellor sees documents of their own student only', async () => {
    expect((await api().get(`/api/v1/documents?studentId=${S.student}`).set(auth(S.counsellor))).status).toBe(200);
    expect((await api().get(`/api/v1/documents?studentId=${S.student}`).set(auth(S.other))).status).toBe(404);
    expect((await up(S.other, S.student, 'marksheet')).status).toBe(404);
    expect((await up(S.counsellor, S.student2, 'marksheet')).status).toBe(404); // unassigned student
    const mine = await up(S.counsellor, S.student, 'photo');
    expect(mine.status).toBe(201);
    expect((await api().post(`/api/v1/documents/${mine.body._id}/download-link`).set(auth(S.other))).status).toBe(404);
    expect((await api().post(`/api/v1/documents/${mine.body._id}/download-link`).set(auth(S.counsellor))).status).toBe(200);
  });
});

describe('export and erasure', () => {
  it('student export includes document METADATA only', async () => {
    const r = await api().get(`/api/v1/students/${S.student}/export`).set(auth(S.owner));
    expect(r.status).toBe(200);
    const sec = r.body.sections.find((s: any) => s.section === 'documents');
    expect(sec.data.length).toBeGreaterThan(0);
    expect(JSON.stringify(sec)).not.toContain('SECRET-MARKSHEET-CONTENT');
    expect(JSON.stringify(sec)).not.toContain(S.tenant + '/'); // no storage keys
  });

  it('erasing the student deletes every file and record', async () => {
    const before = [...store.files.keys()].filter((k) => k.startsWith(`${S.tenant}/${S.student}/`));
    expect(before.length).toBeGreaterThan(0);
    const e = await api().post(`/api/v1/students/${S.student}/erase`).set(auth(S.owner)).send({ confirm: 'ERASE', reason: 'Parent request' });
    expect(e.status).toBe(200);
    expect([...store.files.keys()].filter((k) => k.startsWith(`${S.tenant}/${S.student}/`))).toEqual([]);
    const { DocumentModel } = await import('../../src/product/modules/documents/infrastructure/document.model.js');
    expect(await DocumentModel(S.tenant).countDocuments({ studentId: S.student })).toBe(0);
    expect([...store.files.keys()].some((k) => k.startsWith(`${S.tenant}/${S.student2}/`))).toBe(true); // others untouched
  });
});
