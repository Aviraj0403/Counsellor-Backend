import { Types } from 'mongoose';
import { env } from '../../../../config/env.js';
import type { Principal } from '../../../../contracts/port.js';
import { getPlatform } from '../../../../contracts/registry.js';
import { decryptBuffer, encryptBuffer, hmacHex, safeEqual, sha256Hex } from '../../../../shared/infra/crypto.js';
import { getFileStore } from '../../../../shared/infra/fileStore.js';
import { logger } from '../../../../shared/infra/logger.js';
import { AppError, badRequest, forbidden, notFound } from '../../../../shared/kernel/errors.js';
import { publish, subscribe } from '../../../../shared/kernel/events.js';
import { registerContributor, registerGuard } from '../../../../shared/kernel/hooks.js';
import { getApplication } from '../../applications/index.js';
import { audit } from '../../audit/index.js';
import { getRequiredDocuments } from '../../colleges/index.js';
import { getStudent } from '../../students/index.js';
import {
  blockMessage,
  computeChecklist,
  createDownloadToken,
  documentKey,
  safeFileName,
  sniffFileType,
  uploadProblem,
  verifyDownloadToken,
  type ChecklistItem,
} from '../domain/document.domain.js';
import { DocumentModel } from '../infrastructure/document.model.js';

const OBJECT_ID = /^[a-f\d]{24}$/i;
const sign = (data: string) => hmacHex(env.JWT_SECRET, data);

/** Metadata only: never the storage key. */
const view = (d: any) => ({
  _id: String(d._id),
  studentId: d.studentId,
  applicationId: d.applicationId,
  type: d.type,
  label: d.label,
  fileName: d.fileName,
  mimeType: d.mimeType,
  sizeBytes: d.sizeBytes,
  sha256: d.sha256,
  status: d.status,
  rejectReason: d.rejectReason,
  verifiedBy: d.verifiedBy,
  verifiedAt: d.verifiedAt,
  uploadedBy: d.uploadedBy,
  version: d.version,
  supersededBy: d.supersededBy,
  createdAt: d.createdAt,
});

/** A counsellor only reaches documents of students assigned to them (or of applications assigned to them). */
const assertStudentAccess = async (p: Principal, studentId: string, applicationId?: string) => {
  const tenantId = p.tenantId!;
  if (!OBJECT_ID.test(studentId)) throw notFound('Student');
  const student: any = await getStudent(tenantId, studentId);
  if (!student || student.status === 'erased') throw notFound('Student');
  if (applicationId) {
    const app = OBJECT_ID.test(applicationId) ? await getApplication(tenantId, applicationId) : null;
    if (!app || app.studentId !== studentId) throw notFound('Application');
    if (p.role === 'counsellor' && student.assignedTo !== p.userId && app.assignedTo !== p.userId) throw notFound('Student');
    return { student, app };
  }
  if (p.role === 'counsellor' && student.assignedTo !== p.userId) throw notFound('Student');
  return { student, app: null };
};

const loadDoc = async (p: Principal, id: string) => {
  if (!OBJECT_ID.test(id)) throw notFound('Document');
  const d: any = await DocumentModel(p.tenantId!).findOne({ _id: id, deletedAt: { $exists: false } }).lean();
  if (!d) throw notFound('Document');
  await assertStudentAccess(p, d.studentId, d.applicationId);
  return d;
};

export interface UploadInput {
  studentId: string;
  type: string;
  applicationId?: string;
  label?: string;
  fileName?: string;
  bytes: Buffer;
}

export const uploadDocument = async (p: Principal, input: UploadInput) => {
  const tenantId = p.tenantId!;
  const maxBytes = env.MAX_UPLOAD_MB * 1024 * 1024;
  const problem = uploadProblem(input.bytes, maxBytes);
  if (problem) throw badRequest(problem);
  await assertStudentAccess(p, input.studentId, input.applicationId);
  return persistUpload(tenantId, { ...input, uploadedBy: p.userId });
};

export interface StoreDocumentInput {
  studentId: string;
  applicationId?: string;
  type: string;
  label?: string;
  fileName?: string;
  bytes: Buffer;
  /** staff user id, or 'student' for a portal upload */
  uploadedBy: string;
}

/** The ONE write path for a document (validation, encryption, versioning, audit, event). The caller has already authorised access. */
const persistUpload = async (tenantId: string, input: StoreDocumentInput) => {
  const maxBytes = env.MAX_UPLOAD_MB * 1024 * 1024;
  const problem = uploadProblem(input.bytes, maxBytes);
  if (problem) throw badRequest(problem);
  const detected = sniffFileType(input.bytes)!;

  const M = DocumentModel(tenantId);
  const scope = { studentId: input.studentId, type: input.type, applicationId: input.applicationId ?? { $exists: false }, deletedAt: { $exists: false } };
  const previous: any[] = await M.find(scope).sort({ version: 1 }).lean();
  const version = (previous.length ? Math.max(...previous.map((d) => d.version ?? 1)) : 0) + 1;

  const id = new Types.ObjectId();
  const storageKey = documentKey(tenantId, input.studentId, String(id));
  await getFileStore().put(storageKey, encryptBuffer(input.bytes)); // encrypt-then-store: the store never sees a readable file
  try {
    const doc = await M.create({
      _id: id,
      studentId: input.studentId,
      applicationId: input.applicationId,
      type: input.type,
      label: input.label,
      fileName: safeFileName(input.fileName, detected.ext),
      mimeType: detected.mime,
      sizeBytes: input.bytes.length,
      sha256: sha256Hex(input.bytes),
      storageKey,
      status: 'pending_review',
      uploadedBy: input.uploadedBy,
      version,
    });
    if (previous.length) await M.updateMany({ _id: { $in: previous.map((d) => d._id) }, supersededBy: { $exists: false } }, { $set: { supersededBy: String(id) } });
    const out = view(doc.toObject());
    await audit(tenantId, { action: 'document.uploaded', entity: 'document', entityId: out._id, meta: { studentId: input.studentId, type: input.type, version, sizeBytes: input.bytes.length, mimeType: detected.mime } });
    await publish('document.uploaded', { tenantId, documentId: out._id, studentId: input.studentId, applicationId: input.applicationId, actorId: input.uploadedBy });
    return out;
  } catch (e) {
    await getFileStore().delete(storageKey).catch(() => undefined);
    throw e;
  }
};

export const listDocuments = async (p: Principal, q: { studentId: string; applicationId?: string }) => {
  await assertStudentAccess(p, q.studentId, q.applicationId);
  const filter: Record<string, unknown> = { studentId: q.studentId, deletedAt: { $exists: false } };
  if (q.applicationId) filter.applicationId = q.applicationId;
  const rows = await DocumentModel(p.tenantId!).find(filter).sort({ createdAt: -1 }).lean<any[]>();
  return { items: rows.map(view) };
};

/** The documents that count for an application: its own uploads plus the student's general ones. */
const docsFor = (tenantId: string, studentId: string, applicationId?: string) =>
  DocumentModel(tenantId)
    .find({ studentId, deletedAt: { $exists: false }, ...(applicationId ? { $or: [{ applicationId }, { applicationId: { $exists: false } }] } : {}) })
    .sort({ createdAt: 1 })
    .lean<any[]>();

export const checklistFor = async (tenantId: string, studentId: string, applicationId?: string, ctx?: { collegeId: string; courseId?: string }): Promise<ChecklistItem[]> => {
  let college = ctx;
  if (!college && applicationId) {
    const app = await getApplication(tenantId, applicationId);
    if (app) college = { collegeId: app.collegeId, courseId: app.courseId };
  }
  const required = college ? await getRequiredDocuments(tenantId, college.collegeId, college.courseId) : [];
  return computeChecklist(required, await docsFor(tenantId, studentId, applicationId));
};

export const getChecklist = async (p: Principal, q: { studentId: string; applicationId?: string }) => {
  await assertStudentAccess(p, q.studentId, q.applicationId);
  const items = await checklistFor(p.tenantId!, q.studentId, q.applicationId);
  return { items, complete: items.filter((i) => i.mandatory).every((i) => i.state === 'verified') };
};

/** Verification queue for the admissions team. */
export const listQueue = async (p: Principal, q: { status: string; page: number; limit: number }) => {
  const tenantId = p.tenantId!;
  const filter = { status: q.status, deletedAt: { $exists: false }, supersededBy: { $exists: false } };
  const M = DocumentModel(tenantId);
  const [rows, total] = await Promise.all([
    M.find(filter).sort({ createdAt: 1 }).skip((q.page - 1) * q.limit).limit(q.limit).lean<any[]>(),
    M.countDocuments(filter),
  ]);
  const names = new Map<string, any>();
  for (const id of new Set(rows.map((r) => r.studentId))) names.set(id, await getStudent(tenantId, id));
  const items = rows
    .filter((r) => p.role !== 'counsellor' || names.get(r.studentId)?.assignedTo === p.userId)
    .map((r) => ({ ...view(r), studentName: names.get(r.studentId)?.name }));
  return { items, total, page: q.page, limit: q.limit };
};

export const verifyDocument = async (p: Principal, id: string) => {
  const d = await loadDoc(p, id);
  if (d.supersededBy) throw new AppError(409, 'DOCUMENT_SUPERSEDED', 'A newer version of this document exists. Review that one instead.');
  const u: any = await DocumentModel(p.tenantId!).findByIdAndUpdate(id, { $set: { status: 'verified', verifiedBy: p.userId, verifiedAt: new Date() }, $unset: { rejectReason: 1 } }, { new: true }).lean();
  await audit(p.tenantId!, { action: 'document.verified', entity: 'document', entityId: id, meta: { studentId: d.studentId, type: d.type } });
  await publish('document.verified', { tenantId: p.tenantId!, documentId: id, studentId: d.studentId, applicationId: d.applicationId, actorId: p.userId });
  return view(u);
};

export const rejectDocument = async (p: Principal, id: string, reason: string) => {
  const d = await loadDoc(p, id);
  if (d.supersededBy) throw new AppError(409, 'DOCUMENT_SUPERSEDED', 'A newer version of this document exists. Review that one instead.');
  const u: any = await DocumentModel(p.tenantId!).findByIdAndUpdate(id, { $set: { status: 'rejected', rejectReason: reason, verifiedBy: p.userId, verifiedAt: new Date() } }, { new: true }).lean();
  await audit(p.tenantId!, { action: 'document.rejected', entity: 'document', entityId: id, meta: { studentId: d.studentId, type: d.type, reason } });
  await publish('document.rejected', { tenantId: p.tenantId!, documentId: id, studentId: d.studentId, applicationId: d.applicationId, reason, actorId: p.userId });
  return view(u);
};

export const deleteDocument = async (p: Principal, id: string) => {
  const d = await loadDoc(p, id);
  if (d.status === 'verified') throw new AppError(409, 'DOCUMENT_VERIFIED', 'A verified document cannot be deleted. Upload a new version instead.');
  await getFileStore().delete(d.storageKey);
  await DocumentModel(p.tenantId!).updateOne({ _id: id }, { $set: { deletedAt: new Date() } });
  await audit(p.tenantId!, { action: 'document.deleted', entity: 'document', entityId: id, meta: { studentId: d.studentId, type: d.type } });
  return { ok: true };
};

// ---- download (two steps, both audited)
export const issueDownloadLink = async (p: Principal, id: string) => {
  const d = await loadDoc(p, id);
  const token = createDownloadToken({ tenantId: p.tenantId!, documentId: id, userId: p.userId }, env.DOWNLOAD_LINK_TTL_SECONDS, Date.now(), sign);
  await audit(p.tenantId!, { action: 'document.download_link_issued', entity: 'document', entityId: id, meta: { studentId: d.studentId, type: d.type } });
  return { url: `/public/documents/file/${token}`, expiresInSeconds: env.DOWNLOAD_LINK_TTL_SECONDS };
};

/** Public route helper: verifies the signed link and returns the decrypted file. Any failure is the same 403. */
export const openByToken = async (token: string) => {
  const denied = () => forbidden('This download link is invalid or has expired. Ask for a new one.');
  const claims = verifyDownloadToken(token, Date.now(), sign, safeEqual);
  if (!claims) throw denied();
  if (!(await getPlatform().enabledModules(claims.tenantId))['documents']) throw denied();
  if (!OBJECT_ID.test(claims.documentId)) throw denied();
  const d: any = await DocumentModel(claims.tenantId).findOne({ _id: claims.documentId, deletedAt: { $exists: false } }).lean();
  if (!d) throw denied();
  const student: any = await getStudent(claims.tenantId, d.studentId);
  if (!student || student.status === 'erased') throw denied();
  const bytes = decryptBuffer(await getFileStore().get(d.storageKey));
  await audit(claims.tenantId, { action: 'document.downloaded', entity: 'document', entityId: claims.documentId, meta: { studentId: d.studentId, type: d.type, issuedTo: claims.userId } });
  return { bytes, fileName: d.fileName as string, mimeType: d.mimeType as string };
};

// ---- additive API for portals (organisation-internal; the CALLER must already have authorised access)
export const storeDocument = async (tenantId: string, input: StoreDocumentInput) => {
  const student: any = await getStudent(tenantId, input.studentId);
  if (!student || student.status === 'erased') throw notFound('Student');
  if (input.applicationId) {
    const app = OBJECT_ID.test(input.applicationId) ? await getApplication(tenantId, input.applicationId) : null;
    if (!app || app.studentId !== input.studentId) throw notFound('Application');
  }
  return persistUpload(tenantId, input);
};

export const listDocumentsForStudent = async (tenantId: string, studentId: string, opts: { applicationId?: string; status?: string } = {}) => {
  const filter: Record<string, unknown> = { studentId, deletedAt: { $exists: false } };
  if (opts.applicationId) filter.applicationId = opts.applicationId;
  if (opts.status) filter.status = opts.status;
  return (await DocumentModel(tenantId).find(filter).sort({ createdAt: -1 }).lean<any[]>()).map(view);
};

export const getDocumentMeta = async (tenantId: string, id: string) => {
  if (!OBJECT_ID.test(id)) return null;
  const d: any = await DocumentModel(tenantId).findOne({ _id: id, deletedAt: { $exists: false } }).lean();
  return d ? view(d) : null;
};

/** Signed, audited download link for a document the caller has already authorised. */
export const issueDownloadLinkFor = async (tenantId: string, userId: string, id: string) => {
  const d: any = await DocumentModel(tenantId).findOne({ _id: id, deletedAt: { $exists: false } }).lean();
  if (!d) throw notFound('Document');
  const token = createDownloadToken({ tenantId, documentId: id, userId }, env.DOWNLOAD_LINK_TTL_SECONDS, Date.now(), sign);
  await audit(tenantId, { action: 'document.download_link_issued', entity: 'document', entityId: id, meta: { studentId: d.studentId, type: d.type } });
  return { url: `/public/documents/file/${token}`, expiresInSeconds: env.DOWNLOAD_LINK_TTL_SECONDS };
};

// ---- hooks and events
export const registerHooks = (): void => {
  registerGuard('application.beforeStatusChange', async ({ tenantId, applicationId, studentId, collegeId, courseId, to }) => {
    if (to !== 'submitted') return null;
    return blockMessage(await checklistFor(tenantId, studentId, applicationId, { collegeId, courseId }));
  });
  registerContributor('student.export', async ({ tenantId, studentId }) => ({
    section: 'documents',
    data: (await DocumentModel(tenantId).find({ studentId, deletedAt: { $exists: false } }).lean<any[]>()).map(view), // metadata only, never file contents
  }));
};

export const registerEvents = (): void => {
  subscribe('student.erased', async ({ tenantId, studentId }) => {
    const M = DocumentModel(tenantId);
    for (const d of await M.find({ studentId }).lean<any[]>()) {
      try {
        await getFileStore().delete(d.storageKey);
      } catch (err) {
        logger.error({ err, documentId: String(d._id) }, 'could not delete stored file during erasure');
      }
    }
    await M.deleteMany({ studentId });
  });
};
