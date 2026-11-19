import type { Principal } from '../../../../contracts/port.js';
import { AppError, badRequest, conflict, notFound } from '../../../../shared/kernel/errors.js';
import { publish } from '../../../../shared/kernel/events.js';
import { registerContributor, runGuards } from '../../../../shared/kernel/hooks.js';
import { subscribe } from '../../../../shared/kernel/events.js';
import { audit } from '../../audit/index.js';
import { getCollege, getCourse } from '../../colleges/index.js';
import { createdRange, type CentralFilters, type CentralPageOf } from '../../../../shared/kernel/central.js';
import { findStudentIdsForCentral, getStudent } from '../../students/index.js';
import { canRecordFee, isStatus, nextStatuses, transitionProblem, type ApplicationStatus } from '../domain/application.domain.js';
import { ApplicationModel } from '../infrastructure/application.model.js';

const OBJECT_ID = /^[a-f\d]{24}$/i;

/** A counsellor only sees applications assigned to them. */
const visibility = (p: Principal) => (p.role === 'counsellor' ? { assignedTo: p.userId } : {});

export interface CreateApplicationInput {
  studentId: string;
  collegeId: string;
  courseId: string;
  intake: { month: number; year: number };
  assignedTo?: string;
  collegeRef?: string;
  fee?: { applicationFeePaise?: number; tuitionPaise?: number };
  notes?: string;
}

export const createApplication = async (p: Principal, input: CreateApplicationInput) => {
  const tenantId = p.tenantId!;
  const student: any = await getStudent(tenantId, input.studentId);
  if (!student || student.status === 'erased') throw notFound('Student');
  if (p.role === 'counsellor' && student.assignedTo !== p.userId) throw notFound('Student');
  const college = await getCollege(tenantId, input.collegeId);
  if (!college) throw notFound('College');
  const course = await getCourse(tenantId, input.courseId);
  if (!course || course.collegeId !== input.collegeId) throw badRequest('This course does not belong to the chosen college.');
  if (course.active === false || college.active === false) throw badRequest('This college or course is not active.');

  const assignedTo = input.assignedTo ?? student.assignedTo ?? (p.role === 'counsellor' ? p.userId : undefined);
  try {
    const doc = await ApplicationModel(tenantId).create({
      ...input,
      assignedTo,
      fee: { ...(input.fee ?? {}), paidPaise: 0 },
      status: 'draft',
      statusHistory: [{ from: undefined, to: 'draft', by: p.userId, at: new Date() }],
      createdBy: p.userId,
    });
    const app = doc.toObject();
    const id = String(app._id);
    await audit(tenantId, { action: 'application.created', entity: 'application', entityId: id, meta: { studentId: input.studentId, collegeId: input.collegeId, courseId: input.courseId } });
    await publish('application.created', { tenantId, applicationId: id, studentId: input.studentId, collegeId: input.collegeId, actorId: p.userId });
    return app;
  } catch (e: any) {
    if (e?.code === 11000) throw conflict('This student already has an application for this course and intake.');
    throw e;
  }
};

export interface ApplicationFilters {
  status?: string;
  collegeId?: string;
  assignedTo?: string;
  studentId?: string;
}

const buildFilter = (f: ApplicationFilters) => {
  const q: Record<string, unknown> = {};
  if (f.status) q.status = f.status;
  if (f.collegeId) q.collegeId = f.collegeId;
  if (f.assignedTo) q.assignedTo = f.assignedTo;
  if (f.studentId) q.studentId = f.studentId;
  return q;
};

/** Adds the names the screens need, with one lookup per distinct id. */
const withNames = async (tenantId: string, rows: any[]) => {
  const uniq = (k: string) => [...new Set(rows.map((r) => String(r[k])))];
  const [students, colleges, courses] = await Promise.all([
    Promise.all(uniq('studentId').map(async (id) => [id, await getStudent(tenantId, id)] as const)),
    Promise.all(uniq('collegeId').map(async (id) => [id, await getCollege(tenantId, id)] as const)),
    Promise.all(uniq('courseId').map(async (id) => [id, await getCourse(tenantId, id)] as const)),
  ]);
  const sm = new Map(students), cm = new Map(colleges), om = new Map(courses);
  return rows.map((r) => ({
    ...r,
    studentName: sm.get(String(r.studentId))?.name,
    collegeName: cm.get(String(r.collegeId))?.name,
    courseName: om.get(String(r.courseId))?.name,
    allowedNext: isStatus(r.status) ? nextStatuses(r.status) : [],
  }));
};

export const listApplications = async (p: Principal, q: ApplicationFilters & { page: number; limit: number }) => {
  const tenantId = p.tenantId!;
  const filter = { ...buildFilter(q), ...visibility(p) };
  const M = ApplicationModel(tenantId);
  const [rows, total] = await Promise.all([
    M.find(filter).sort({ createdAt: -1 }).skip((q.page - 1) * q.limit).limit(q.limit).lean<any[]>(),
    M.countDocuments(filter),
  ]);
  return { items: await withNames(tenantId, rows), total, page: q.page, limit: q.limit };
};

export const getApplicationForPrincipal = async (p: Principal, id: string) => {
  const tenantId = p.tenantId!;
  const a = await ApplicationModel(tenantId).findOne({ _id: id, ...visibility(p) }).lean<any>();
  if (!a) throw notFound('Application');
  return (await withNames(tenantId, [a]))[0];
};

export interface UpdateApplicationInput {
  notes?: string;
  collegeRef?: string;
  assignedTo?: string;
  fee?: { applicationFeePaise?: number; tuitionPaise?: number };
  offer?: { scholarshipPaise?: number; deadline?: string; note?: string };
}

export const updateApplication = async (p: Principal, id: string, patch: UpdateApplicationInput) => {
  const tenantId = p.tenantId!;
  const M = ApplicationModel(tenantId);
  const cur = await M.findOne({ _id: id, ...visibility(p) }).lean<any>();
  if (!cur) throw notFound('Application');
  const set: Record<string, unknown> = {};
  for (const k of ['notes', 'collegeRef', 'assignedTo'] as const) if (patch[k] !== undefined) set[k] = patch[k];
  if (patch.fee) {
    for (const k of ['applicationFeePaise', 'tuitionPaise'] as const) if (patch.fee[k] !== undefined) set[`fee.${k}`] = patch.fee[k];
  }
  if (patch.offer) {
    for (const k of ['scholarshipPaise', 'note'] as const) if (patch.offer[k] !== undefined) set[`offer.${k}`] = patch.offer[k];
    if (patch.offer.deadline !== undefined) set['offer.deadline'] = new Date(patch.offer.deadline);
  }
  const updated = await M.findByIdAndUpdate(id, { $set: set }, { new: true }).lean<any>();
  await audit(tenantId, { action: 'application.updated', entity: 'application', entityId: id, meta: { fields: Object.keys(patch) } });
  return (await withNames(tenantId, [updated]))[0];
};

/** The single place where the status rules are enforced (staff screens, the college portal and the API all come through here). */
export const changeApplicationStatus = async (p: Principal, id: string, to: string, note?: string, feePaidPaise?: number) => {
  const tenantId = p.tenantId!;
  if (!isStatus(to)) throw badRequest('Unknown status.');
  if (!OBJECT_ID.test(id)) throw notFound('Application');
  const M = ApplicationModel(tenantId);
  const cur = await M.findOne({ _id: id, ...visibility(p) }).lean<any>();
  if (!cur) throw notFound('Application');
  const from = cur.status as ApplicationStatus;
  const problem = transitionProblem(from, to);
  if (problem) throw new AppError(409, 'ILLEGAL_TRANSITION', problem);
  if (feePaidPaise !== undefined && !canRecordFee(to)) throw badRequest('The amount paid can only be recorded when the application is accepted, fee paid or admitted.');

  const reasons = await runGuards('application.beforeStatusChange', { tenantId, applicationId: id, studentId: cur.studentId, collegeId: cur.collegeId, courseId: cur.courseId, from, to });
  if (reasons.length) throw new AppError(409, 'STATUS_BLOCKED', reasons.join(' '), { reasons });

  const set: Record<string, unknown> = { status: to };
  if (feePaidPaise !== undefined) set['fee.paidPaise'] = feePaidPaise;
  // compare-and-set on the old status so two clicks cannot both win
  const updated = await M.findOneAndUpdate(
    { _id: id, status: from },
    { $set: set, $push: { statusHistory: { from, to, by: p.userId, at: new Date(), note } } },
    { new: true },
  ).lean<any>();
  if (!updated) throw new AppError(409, 'ILLEGAL_TRANSITION', 'The application was changed by someone else. Refresh and try again.');
  await audit(tenantId, { action: 'application.status_changed', entity: 'application', entityId: id, meta: { from, to, note, feePaidPaise } });
  await publish('application.status_changed', { tenantId, applicationId: id, studentId: cur.studentId, collegeId: cur.collegeId, from, to, actorId: p.userId });
  return updated;
};

// ---- public API helpers (organisation-internal, no principal)
const summary = (a: any) => ({
  id: String(a._id),
  studentId: a.studentId,
  collegeId: a.collegeId,
  courseId: a.courseId,
  intake: a.intake,
  status: a.status,
  assignedTo: a.assignedTo,
  fee: a.fee,
  collegeRef: a.collegeRef,
});
export type ApplicationSummary = ReturnType<typeof summary>;

export const getApplication = async (tenantId: string, id: string): Promise<ApplicationSummary | null> => {
  if (!OBJECT_ID.test(id)) return null;
  const a = await ApplicationModel(tenantId).findById(id).lean<any>();
  return a ? summary(a) : null;
};
export const listApplicationsForStudent = async (tenantId: string, studentId: string) =>
  (await ApplicationModel(tenantId).find({ studentId }).sort({ createdAt: -1 }).lean<any[]>()).map(summary);
export const listApplicationsForCollege = async (tenantId: string, collegeId: string, filters: { status?: string; page?: number; limit?: number } = {}) => {
  const limit = Math.min(filters.limit ?? 50, 200);
  const rows = await ApplicationModel(tenantId)
    .find({ collegeId, ...(filters.status ? { status: filters.status } : {}) })
    .sort({ createdAt: -1 })
    .skip(((filters.page ?? 1) - 1) * limit)
    .limit(limit)
    .lean<any[]>();
  return rows.map(summary);
};

/** Full application for portal views (own student / own college): history included, internal notes excluded. */
export const getApplicationDetail = async (tenantId: string, id: string) => {
  if (!OBJECT_ID.test(id)) return null;
  const a = await ApplicationModel(tenantId).findById(id).lean<any>();
  if (!a) return null;
  return {
    ...summary(a),
    offer: a.offer,
    statusHistory: (a.statusHistory ?? []).map((h: any) => ({ from: h.from, to: h.to, at: h.at, note: h.note })),
    createdAt: a.createdAt,
  };
};

const countBy = async (tenantId: string, field: string): Promise<Record<string, number>> => {
  const rows = await ApplicationModel(tenantId).aggregate([{ $group: { _id: `$${field}`, n: { $sum: 1 } } }]);
  return Object.fromEntries(rows.map((r: any) => [String(r._id ?? 'unassigned'), r.n as number]));
};
export const applicationCountsByStatus = (tenantId: string) => countBy(tenantId, 'status');
export const applicationCountsByCollege = (tenantId: string) => countBy(tenantId, 'collegeId');
export const applicationCountsByCounsellor = (tenantId: string) => countBy(tenantId, 'assignedTo');

// ---- hooks and events
export const registerHooks = (): void => {
  registerContributor('student.export', async ({ tenantId, studentId }) => ({
    section: 'applications',
    data: await ApplicationModel(tenantId).find({ studentId }).lean(),
  }));
};

export const registerEvents = (): void => {
  subscribe('student.erased', async ({ tenantId, studentId }) => {
    await ApplicationModel(tenantId).updateMany({ studentId }, { $unset: { notes: 1, collegeRef: 1, 'offer.note': 1 } });
  });
};

// ---- CENTRAL DATA (platform view across organisations)
export interface CentralApplicationRow {
  id: string;
  studentId: string;
  studentName?: string;
  collegeId: string;
  collegeName?: string;
  courseName?: string;
  intake: { month: number; year: number };
  status: string;
  assignedTo?: string;
  createdAt: Date;
}

/** One organisation's applications, newest first: the first `take` rows plus the total. A name/phone search matches the STUDENT. */
export const listApplicationsForCentral = async (tenantId: string, f: CentralFilters, take: number): Promise<CentralPageOf<CentralApplicationRow>> => {
  const filter: Record<string, unknown> = {};
  if (f.status) filter.status = f.status;
  if (f.assignedTo) filter.assignedTo = { $in: f.assignedTo };
  const range = createdRange(f);
  if (range) filter.createdAt = range;
  if (f.q) filter.studentId = { $in: await findStudentIdsForCentral(tenantId, { q: f.q }) };
  const M = ApplicationModel(tenantId);
  const [rows, total] = await Promise.all([M.find(filter).sort({ createdAt: -1, _id: -1 }).limit(take).lean<any[]>(), M.countDocuments(filter)]);
  const named = await withNames(tenantId, rows);
  return {
    total,
    items: named.map((a) => ({
      id: String(a._id),
      studentId: String(a.studentId),
      studentName: a.studentName,
      collegeId: String(a.collegeId),
      collegeName: a.collegeName,
      courseName: a.courseName,
      intake: a.intake,
      status: a.status,
      assignedTo: a.assignedTo,
      createdAt: a.createdAt,
    })),
  };
};
