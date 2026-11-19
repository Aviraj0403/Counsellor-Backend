import type { Principal } from '../../../../contracts/port.js';
import { forbidden, notFound } from '../../../../shared/kernel/errors.js';
import { changeApplicationStatus, getApplicationDetail, listApplicationsForCollege } from '../../applications/index.js';
import { audit } from '../../audit/index.js';
import { getCollege, getCourse } from '../../colleges/index.js';
import { getDocumentMeta, issueDownloadLinkFor, listDocumentsForStudent } from '../../documents/index.js';
import { getStudent } from '../../students/index.js';
import { collegeMayMoveTo, collegeStudentView, studentHistory } from '../domain/portal.domain.js';

const OBJECT_ID = /^[a-f\d]{24}$/i;

/** The college id comes ONLY from the login (linkedId). */
const me = async (p: Principal) => {
  const collegeId = p.linkedId;
  if (!p.tenantId || !collegeId || !OBJECT_ID.test(collegeId)) throw forbidden('This login is not linked to a college.');
  const college: any = await getCollege(p.tenantId, collegeId);
  if (!college) throw forbidden('This portal login is no longer active.');
  return { tenantId: p.tenantId, collegeId, college };
};

/** Application of THIS college only; anything else (including another college's) is "not found". */
const ownApplication = async (tenantId: string, collegeId: string, id: string) => {
  const a = OBJECT_ID.test(id) ? await getApplicationDetail(tenantId, id) : null;
  if (!a || a.collegeId !== collegeId) throw notFound('Application');
  return a;
};

const view = async (tenantId: string, a: any) => {
  const [student, course]: any[] = await Promise.all([getStudent(tenantId, a.studentId), getCourse(tenantId, a.courseId)]);
  return {
    id: a.id,
    courseName: course?.name,
    intake: a.intake,
    status: a.status,
    collegeRef: a.collegeRef,
    offer: a.offer ? { scholarshipPaise: a.offer.scholarshipPaise, deadline: a.offer.deadline } : undefined,
    student: collegeStudentView(student?.status === 'erased' ? null : student),
    statusHistory: studentHistory(a.statusHistory),
  };
};

export const listApplications = async (p: Principal, q: { status?: string; page: number; limit: number }) => {
  const { tenantId, collegeId, college } = await me(p);
  const rows = await listApplicationsForCollege(tenantId, collegeId, q);
  const items = [];
  for (const r of rows) items.push(await view(tenantId, (await getApplicationDetail(tenantId, r.id))!));
  return { college: { name: college.name }, items, page: q.page, limit: q.limit };
};

export const applicationDetail = async (p: Principal, id: string) => {
  const { tenantId, collegeId } = await me(p);
  const a = await ownApplication(tenantId, collegeId, id);
  return view(tenantId, a);
};

export const updateStatus = async (p: Principal, id: string, to: string, note?: string) => {
  const { tenantId, collegeId } = await me(p);
  await ownApplication(tenantId, collegeId, id);
  if (!collegeMayMoveTo(to)) throw forbidden('A college can only mark an application as under review, offered, rejected, accepted or admitted.');
  await changeApplicationStatus(p, id, to, note); // the state machine, guards, audit and events all apply
  await audit(tenantId, { action: 'portal.college_status_updated', entity: 'application', entityId: id, meta: { to, collegeId, portalUserId: p.userId } });
  return view(tenantId, (await getApplicationDetail(tenantId, id))!);
};

/** Verified, current documents of the student of one of this college's applications. */
export const listDocuments = async (p: Principal, id: string) => {
  const { tenantId, collegeId } = await me(p);
  const a = await ownApplication(tenantId, collegeId, id);
  const rows = await listDocumentsForStudent(tenantId, a.studentId, { status: 'verified' });
  const items = rows
    .filter((d) => !d.supersededBy && (!d.applicationId || d.applicationId === id))
    .map((d) => ({ id: d._id, type: d.type, label: d.label, fileName: d.fileName, mimeType: d.mimeType, sizeBytes: d.sizeBytes, verifiedAt: d.verifiedAt }));
  return { items };
};

export const downloadLink = async (p: Principal, id: string, documentId: string) => {
  const { tenantId, collegeId } = await me(p);
  const a = await ownApplication(tenantId, collegeId, id);
  const d = await getDocumentMeta(tenantId, documentId);
  if (!d || d.studentId !== a.studentId || d.status !== 'verified' || d.supersededBy || (d.applicationId && d.applicationId !== id)) throw notFound('Document');
  return issueDownloadLinkFor(tenantId, p.userId, documentId);
};
