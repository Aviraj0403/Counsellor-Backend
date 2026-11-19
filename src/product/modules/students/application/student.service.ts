import type { Principal } from '../../../../contracts/port.js';
import { getPlatform } from '../../../../contracts/registry.js';
import { badRequest, conflict, notFound } from '../../../../shared/kernel/errors.js';
import { publish } from '../../../../shared/kernel/events.js';
import { collectSections } from '../../../../shared/kernel/hooks.js';
import { audit } from '../../audit/index.js';
import { findLeadById } from '../../leads/index.js';
import { ERASED_NAME, escapeRegex, guardianConsentProblem, normalizePhone } from '../domain/student.domain.js';
import { StudentModel } from '../infrastructure/student.model.js';

const OBJECT_ID = /^[a-f\d]{24}$/i;

/** A counsellor only sees students assigned to them. */
const visibility = (p: Principal) => (p.role === 'counsellor' ? { assignedTo: p.userId } : {});

export interface StudentInput {
  name: string;
  phone: string;
  email?: string;
  dob?: string;
  gender?: 'male' | 'female' | 'other';
  address?: { line?: string; city?: string; state?: string; pincode?: string };
  guardian?: { name?: string; phone?: string; relation?: string };
  academics?: { level?: string; board?: string; institute?: string; year?: number; percentage?: number }[];
  testScores?: { test?: string; score?: number; year?: number }[];
  preferences?: { courses?: string[]; cities?: string[]; budgetMaxPaise?: number };
  assignedTo?: string;
  consent: { given: boolean; source?: string; guardianConsent?: { given: boolean; by?: string } };
}

const isDuplicateKey = (e: any) => e?.code === 11000;

const buildConsent = (p: Principal, c: StudentInput['consent']) => ({
  given: c.given,
  source: c.source,
  at: c.given ? new Date() : undefined,
  guardianConsent: c.guardianConsent?.given ? { given: true, at: new Date(), by: c.guardianConsent.by ?? p.userId } : undefined,
});

const guardianOf = (g: StudentInput['guardian']) => (g ? { ...g, phone: g.phone ? normalizePhone(g.phone) : undefined } : undefined);

const createStudentRecord = async (p: Principal, input: StudentInput, leadId?: string) => {
  const tenantId = p.tenantId!;
  const phone = normalizePhone(input.phone);
  if (!phone) throw badRequest('Enter a valid 10-digit Indian mobile number.');
  if (input.guardian?.phone && !normalizePhone(input.guardian.phone)) throw badRequest('Enter a valid guardian mobile number.');
  const dob = input.dob ? new Date(input.dob) : undefined;
  if (dob && dob.getTime() > Date.now()) throw badRequest('Date of birth cannot be in the future.');
  const problem = guardianConsentProblem(dob, input.consent.guardianConsent?.given, new Date());
  if (problem) throw badRequest(problem);

  const Student = StudentModel(tenantId);
  if (await Student.exists({ phone })) throw conflict('A student with this phone number already exists.');

  const assignedTo = input.assignedTo ?? (p.role === 'counsellor' ? p.userId : undefined);
  try {
    const doc = await Student.create({
      ...input,
      phone,
      guardian: guardianOf(input.guardian),
      dob,
      leadId,
      assignedTo,
      consent: buildConsent(p, input.consent),
      createdBy: p.userId,
    });
    const student = doc.toObject();
    await audit(tenantId, { action: 'student.created', entity: 'student', entityId: String(student._id), meta: { leadId } });
    await publish('student.created', { tenantId, studentId: String(student._id), leadId, actorId: p.userId });
    return student;
  } catch (e) {
    if (isDuplicateKey(e)) throw conflict(leadId ? 'A student was already created from this lead.' : 'A student with this phone number already exists.');
    throw e;
  }
};

export const createStudent = (p: Principal, input: StudentInput) => createStudentRecord(p, input);

export interface FromLeadInput {
  dob?: string;
  guardianConsent?: { given: boolean; by?: string };
  extra?: Partial<Omit<StudentInput, 'name' | 'phone' | 'consent'>>;
}

export const createStudentFromLead = async (p: Principal, leadId: string, body: FromLeadInput = {}) => {
  const tenantId = p.tenantId!;
  const lead = await findLeadById(tenantId, leadId);
  if (!lead) throw notFound('Lead');
  if (p.role === 'counsellor' && lead.assignedTo !== p.userId) throw notFound('Lead');
  if (await StudentModel(tenantId).exists({ leadId })) throw conflict('A student was already created from this lead.');
  const extra = body.extra ?? {};
  return createStudentRecord(
    p,
    {
      ...extra,
      name: lead.name,
      phone: lead.phone,
      email: lead.email,
      dob: body.dob ?? extra.dob,
      address: { ...(extra.address ?? {}), city: lead.city ?? extra.address?.city },
      preferences: { ...(extra.preferences ?? {}), courses: lead.interestedCourse ? [lead.interestedCourse] : extra.preferences?.courses },
      assignedTo: extra.assignedTo ?? lead.assignedTo,
      consent: { given: !!lead.consent?.given, source: lead.consent?.source ?? 'lead', guardianConsent: body.guardianConsent },
    },
    leadId,
  );
};

export const listStudents = async (p: Principal, q: { page: number; limit: number; search?: string; includeErased?: boolean }) => {
  const filter: Record<string, unknown> = { ...visibility(p) };
  if (!q.includeErased) filter.status = { $ne: 'erased' };
  if (q.search) {
    const safe = escapeRegex(q.search);
    const digits = q.search.replace(/\D/g, '');
    filter.$or = [{ name: new RegExp(safe, 'i') }, ...(digits ? [{ phone: new RegExp(digits) }] : [])];
  }
  const Student = StudentModel(p.tenantId!);
  const [items, total] = await Promise.all([
    Student.find(filter).sort({ createdAt: -1 }).skip((q.page - 1) * q.limit).limit(q.limit).lean(),
    Student.countDocuments(filter),
  ]);
  return { items, total, page: q.page, limit: q.limit };
};

export const getStudentForPrincipal = async (p: Principal, id: string) => {
  const s = await StudentModel(p.tenantId!).findOne({ _id: id, ...visibility(p) }).lean<any>();
  if (!s) throw notFound('Student');
  return s;
};

export const updateStudent = async (p: Principal, id: string, patch: Partial<StudentInput>) => {
  const tenantId = p.tenantId!;
  const Student = StudentModel(tenantId);
  const cur = await Student.findOne({ _id: id, ...visibility(p) });
  if (!cur) throw notFound('Student');
  if (cur.status === 'erased') throw conflict('This student has been erased and cannot be changed.');
  const set: Record<string, unknown> = {};
  if (patch.phone !== undefined) {
    const phone = normalizePhone(patch.phone);
    if (!phone) throw badRequest('Enter a valid 10-digit Indian mobile number.');
    set.phone = phone;
  }
  if (patch.guardian?.phone && !normalizePhone(patch.guardian.phone)) throw badRequest('Enter a valid guardian mobile number.');
  for (const k of ['name', 'email', 'gender', 'address', 'academics', 'testScores', 'preferences', 'assignedTo'] as const) {
    if (patch[k] !== undefined) set[k] = patch[k];
  }
  if (patch.guardian) set.guardian = guardianOf(patch.guardian);
  if (patch.dob !== undefined) {
    const dob = new Date(patch.dob);
    if (dob.getTime() > Date.now()) throw badRequest('Date of birth cannot be in the future.');
    set.dob = dob;
  }
  if (patch.consent) {
    const c = patch.consent;
    const prevGuardian = cur.consent?.guardianConsent;
    set.consent = {
      given: c.given,
      source: c.source ?? cur.consent?.source,
      at: c.given ? (cur.consent?.given ? cur.consent.at : new Date()) : undefined,
      guardianConsent: c.guardianConsent?.given
        ? prevGuardian?.given
          ? prevGuardian
          : { given: true, at: new Date(), by: c.guardianConsent.by ?? p.userId }
        : undefined,
    };
  }
  // Re-check the minor rule on the resulting record whenever the age or the consent changes.
  if (patch.dob !== undefined || patch.consent) {
    const dob = (set.dob as Date | undefined) ?? cur.dob;
    const gc = patch.consent ? !!(set.consent as any).guardianConsent?.given : !!cur.consent?.guardianConsent?.given;
    const problem = guardianConsentProblem(dob, gc, new Date());
    if (problem) throw badRequest(problem);
  }

  try {
    const updated = await Student.findByIdAndUpdate(id, { $set: set }, { new: true }).lean<any>();
    await audit(tenantId, { action: 'student.updated', entity: 'student', entityId: id, meta: { fields: Object.keys(patch) } });
    return updated;
  } catch (e) {
    if (isDuplicateKey(e)) throw conflict('A student with this phone number already exists.');
    throw e;
  }
};

export const exportStudent = async (p: Principal, id: string) => {
  const tenantId = p.tenantId!;
  const student = await getStudentForPrincipal(p, id);
  const sections = await collectSections('student.export', { tenantId, studentId: id });
  const exportedAt = new Date().toISOString();
  await audit(tenantId, { action: 'student.exported', entity: 'student', entityId: id });
  return { student, sections, exportedAt, exportedBy: p.userId };
};

export const eraseStudent = async (p: Principal, id: string, reason: string) => {
  const tenantId = p.tenantId!;
  const Student = StudentModel(tenantId);
  const cur = await Student.findOne({ _id: id, ...visibility(p) }).lean<any>();
  if (!cur) throw notFound('Student');
  if (cur.status === 'erased') throw conflict('This student has already been erased.');
  const counts = { academics: cur.academics?.length ?? 0, testScores: cur.testScores?.length ?? 0 };
  const erasedAt = new Date();
  await Student.updateOne(
    { _id: id },
    {
      $set: { name: ERASED_NAME, status: 'erased', erasedAt, consent: { given: false } },
      $unset: { phone: 1, email: 1, dob: 1, gender: 1, address: 1, guardian: 1, academics: 1, testScores: 1, preferences: 1 },
    },
  );
  const portalUsersDisabled = await getPlatform().disablePortalUsers(tenantId, id);
  await audit(tenantId, { action: 'student.erased', entity: 'student', entityId: id, meta: { reason, counts, portalUsersDisabled } });
  await publish('student.erased', { tenantId, studentId: id, actorId: p.userId });
  return { id, status: 'erased', erasedAt, counts };
};

/** Public API helpers for other modules (inside one organisation). */
export const getStudent = async (tenantId: string, id: string) => (OBJECT_ID.test(id) ? StudentModel(tenantId).findById(id).lean<any>() : null);
export const studentExists = async (tenantId: string, id: string): Promise<boolean> => (OBJECT_ID.test(id) ? !!(await StudentModel(tenantId).exists({ _id: id })) : false);
