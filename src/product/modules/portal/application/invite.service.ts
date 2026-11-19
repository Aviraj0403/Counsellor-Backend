import type { Principal } from '../../../../contracts/port.js';
import { getPlatform } from '../../../../contracts/registry.js';
import { badRequest, conflict, notFound } from '../../../../shared/kernel/errors.js';
import { subscribe } from '../../../../shared/kernel/events.js';
import { audit } from '../../audit/index.js';
import { getCollege } from '../../colleges/index.js';
import { getStudent } from '../../students/index.js';
import { generateTempPassword, normalizeEmail } from '../domain/portal.domain.js';
import { InviteModel } from '../infrastructure/invite.model.js';

const OBJECT_ID = /^[a-f\d]{24}$/i;
const isDuplicateKey = (e: any) => e?.code === 11000;

const view = (i: any) => ({ id: String(i._id), kind: i.kind, linkedId: i.linkedId, name: i.name, email: i.email, status: i.status, createdAt: i.createdAt, disabledAt: i.disabledAt });

const createLogin = async (p: Principal, kind: 'student' | 'college', linkedId: string, name: string, email: string) => {
  const tenantId = p.tenantId!;
  const M = InviteModel(tenantId);
  if (await M.exists({ email, status: 'active' })) throw conflict('This email already has an active portal invite.');
  const password = generateTempPassword();
  let user: { id: string };
  try {
    user = await getPlatform().createPortalUser(tenantId, { role: kind === 'student' ? 'student' : 'college_user', name, email, password, linkedId });
  } catch (e: any) {
    if (e?.status === 409 || e?.statusCode === 409) throw conflict('A login with this email already exists. Use a different email, or ask support to re-enable it.');
    throw e;
  }
  try {
    const row = await M.create({ kind, linkedId, userId: user.id, name, email, createdBy: p.userId });
    await audit(tenantId, { action: 'portal.invite_created', entity: 'portal_invite', entityId: String(row._id), meta: { kind, linkedId, email } });
    return { invite: view(row.toObject()), temporaryPassword: password };
  } catch (e) {
    if (isDuplicateKey(e)) throw conflict('This person already has an active portal invite.');
    throw e;
  }
};

export const inviteStudent = async (p: Principal, studentId: string) => {
  const tenantId = p.tenantId!;
  const student: any = OBJECT_ID.test(studentId) ? await getStudent(tenantId, studentId) : null;
  if (!student || student.status === 'erased') throw notFound('Student');
  if (p.role === 'counsellor' && student.assignedTo !== p.userId) throw notFound('Student');
  if (!student.email) throw badRequest('This student has no email address. Add an email to the student record first.');
  const email = normalizeEmail(student.email);
  if (await InviteModel(tenantId).exists({ kind: 'student', linkedId: studentId, status: 'active' })) throw conflict('This student already has an active portal invite.');
  return createLogin(p, 'student', studentId, student.name, email);
};

export const inviteCollegeUser = async (p: Principal, input: { collegeId: string; name: string; email: string }) => {
  const college: any = await getCollege(p.tenantId!, input.collegeId);
  if (!college) throw notFound('College');
  return createLogin(p, 'college', input.collegeId, input.name, normalizeEmail(input.email));
};

export const listInvites = async (p: Principal, kind: 'student' | 'college', q: { page: number; limit: number }) => {
  const tenantId = p.tenantId!;
  const M = InviteModel(tenantId);
  const [rows, total] = await Promise.all([
    M.find({ kind }).sort({ createdAt: -1 }).skip((q.page - 1) * q.limit).limit(q.limit).lean<any[]>(),
    M.countDocuments({ kind }),
  ]);
  const items = [];
  for (const r of rows) {
    const subject: any = kind === 'student' ? await getStudent(tenantId, r.linkedId) : await getCollege(tenantId, r.linkedId);
    if (p.role === 'counsellor' && kind === 'student' && subject?.assignedTo !== p.userId) continue; // a counsellor only sees their own students
    items.push({ ...view(r), subjectName: subject?.name });
  }
  return { items, total, page: q.page, limit: q.limit };
};

export const disableInvite = async (p: Principal, kind: 'student' | 'college', id: string) => {
  const tenantId = p.tenantId!;
  const M = InviteModel(tenantId);
  const inv: any = OBJECT_ID.test(id) ? await M.findOne({ _id: id, kind }).lean() : null;
  if (!inv) throw notFound('Invite');
  if (inv.status === 'disabled') return view(inv);
  const upd: any = await M.findOneAndUpdate({ _id: id }, { $set: { status: 'disabled', disabledAt: new Date(), disabledBy: p.userId } }, { new: true }).lean();
  // Block the login itself when no other active invite shares this person/college link (a college may have several employees).
  const others = await M.countDocuments({ linkedId: inv.linkedId, status: 'active', _id: { $ne: inv._id } });
  const loginsDisabled = others === 0 ? await getPlatform().disablePortalUsers(tenantId, inv.linkedId) : 0;
  await audit(tenantId, { action: 'portal.invite_disabled', entity: 'portal_invite', entityId: id, meta: { kind, linkedId: inv.linkedId, loginsDisabled } });
  return view(upd);
};

/** The portal gate uses this: a disabled invite blocks the person even if their login were still alive. */
export const isInviteDisabled = async (tenantId: string, userId: string): Promise<boolean> => !!(await InviteModel(tenantId).exists({ userId, status: 'disabled' }));

export const registerEvents = (): void => {
  subscribe('student.erased', async ({ tenantId, studentId }) => {
    await InviteModel(tenantId).updateMany({ kind: 'student', linkedId: studentId, status: 'active' }, { $set: { status: 'disabled', disabledAt: new Date() } });
  });
};
