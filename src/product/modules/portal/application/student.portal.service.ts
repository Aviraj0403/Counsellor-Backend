import type { Principal } from '../../../../contracts/port.js';
import { forbidden, notFound } from '../../../../shared/kernel/errors.js';
import { getApplicationDetail, listApplicationsForStudent } from '../../applications/index.js';
import { audit } from '../../audit/index.js';
import { getCollege, getCourse } from '../../colleges/index.js';
import { checklistFor, listDocumentsForStudent, storeDocument } from '../../documents/index.js';
import { getStudent } from '../../students/index.js';
import { studentHistory, studentProfileView } from '../domain/portal.domain.js';
import { getOrCreateStudentReferralCode } from '../../leads/application/referral.service.js';
import { getPlatform } from '../../../../contracts/registry.js';
import { listStudentFeeLinks } from '../../applications/application/studentFee.service.js';

const OBJECT_ID = /^[a-f\d]{24}$/i;

/** The student id comes ONLY from the login (linkedId). An erased or missing student has no portal. */
const me = async (p: Principal) => {
  const studentId = p.linkedId;
  if (!p.tenantId || !studentId || !OBJECT_ID.test(studentId)) throw forbidden('This login is not linked to a student.');
  const student: any = await getStudent(p.tenantId, studentId);
  if (!student || student.status === 'erased') throw forbidden('This portal login is no longer active.');
  return { tenantId: p.tenantId, studentId, student };
};

const docView = (d: any) => ({
  id: d._id,
  applicationId: d.applicationId,
  type: d.type,
  label: d.label,
  fileName: d.fileName,
  status: d.status,
  rejectReason: d.rejectReason,
  version: d.version,
  superseded: !!d.supersededBy,
  uploadedAt: d.createdAt,
});

const names = async (tenantId: string, a: { collegeId: string; courseId: string }) => {
  const [college, course]: any[] = await Promise.all([getCollege(tenantId, a.collegeId), getCourse(tenantId, a.courseId)]);
  return { collegeName: college?.name, courseName: course?.name };
};

const appView = async (tenantId: string, a: any) => ({
  id: a.id,
  collegeId: a.collegeId,
  ...(await names(tenantId, a)),
  intake: a.intake,
  status: a.status,
  offer: a.offer ? { scholarshipPaise: a.offer.scholarshipPaise, deadline: a.offer.deadline } : undefined, // the offer note is staff-written: not shown
  statusHistory: studentHistory(a.statusHistory),
});

export const overview = async (p: Principal) => {
  const { tenantId, studentId, student } = await me(p);
  const apps = await listApplicationsForStudent(tenantId, studentId);
  const applications = [];
  for (const s of apps) {
    const detail = await getApplicationDetail(tenantId, s.id);
    applications.push({ ...(await appView(tenantId, detail!)), checklist: await checklistFor(tenantId, studentId, s.id) });
  }
  const documents = (await listDocumentsForStudent(tenantId, studentId)).map(docView);

  // Student referral code & reward info
  const referralInfo = await getOrCreateStudentReferralCode(tenantId, studentId).catch(() => null);

  // Assigned counsellor contact details
  let counsellor: { id: string; name: string; email?: string } | null = null;
  if (student.assignedTo) {
    const team = await getPlatform().listTeam(tenantId, ['counsellor']).catch(() => []);
    const member = team.find((m) => m.id === student.assignedTo);
    if (member) {
      counsellor = { id: member.id, name: member.name };
    }
  }

  // Pending fee links
  const feeLinks = await listStudentFeeLinks(tenantId, { studentId }).catch(() => []);

  return {
    profile: studentProfileView(student),
    applications,
    documents,
    referral: referralInfo,
    counsellor,
    feeLinks,
  };
};

export const applicationDetail = async (p: Principal, id: string) => {
  const { tenantId, studentId } = await me(p);
  const a = OBJECT_ID.test(id) ? await getApplicationDetail(tenantId, id) : null;
  if (!a || a.studentId !== studentId) throw notFound('Application'); // another student's application looks exactly like a missing one
  return { ...(await appView(tenantId, a)), checklist: await checklistFor(tenantId, studentId, id), documents: (await listDocumentsForStudent(tenantId, studentId, { applicationId: id })).map(docView) };
};

export const myDocuments = async (p: Principal) => {
  const { tenantId, studentId } = await me(p);
  return { items: (await listDocumentsForStudent(tenantId, studentId)).map(docView) };
};

export const uploadOwnDocument = async (p: Principal, input: { type: string; applicationId?: string; label?: string; fileName?: string; bytes: Buffer }) => {
  const { tenantId, studentId } = await me(p);
  if (input.applicationId) {
    const a = OBJECT_ID.test(input.applicationId) ? await getApplicationDetail(tenantId, input.applicationId) : null;
    if (!a || a.studentId !== studentId) throw notFound('Application');
  }
  const doc = await storeDocument(tenantId, { studentId, applicationId: input.applicationId, type: input.type, label: input.label, fileName: input.fileName, bytes: input.bytes, uploadedBy: 'student' });
  await audit(tenantId, { action: 'portal.student_document_uploaded', entity: 'document', entityId: doc._id, meta: { studentId, type: input.type, portalUserId: p.userId } });
  return docView(doc);
};
