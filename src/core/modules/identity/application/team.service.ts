import { isValidObjectId } from 'mongoose';
import type { TeamMember } from '../../../../contracts/port.js';
import { AppError, badRequest, conflict, notFound } from '../../../../shared/kernel/errors.js';
import { recordPlatformAudit } from '../../audit/index.js';
import type { PortalRole } from '../../../../contracts/port.js';
import { PORTAL_ROLE_KEYS, ROLES, STAFF_ROLE_KEYS } from '../../catalog/index.js';
import { getStaffLimit } from '../../billing/index.js';
import { User } from '../infrastructure/user.model.js';
import { hashPassword } from '../infrastructure/security.js';
import { revokeAllSessions, revokeSessionsForUsers } from './session.service.js';

/** Enforces the plan's staff limit (active accounts, owner included). No plan or no limit = unlimited. */
const assertStaffRoom = async (tenantId: string) => {
  const limit = await getStaffLimit(tenantId);
  if (!limit) return;
  const active = await User.countDocuments({ tenantId, status: 'active', role: { $nin: PORTAL_ROLE_KEYS } }); // portal users never take a staff seat
  if (active >= limit.maxStaff) {
    throw new AppError(403, 'PLAN_LIMIT', `Your ${limit.planName} plan allows ${limit.maxStaff} active staff accounts and all are in use. Block an account or ask support to upgrade your plan.`);
  }
};

const rolesError = (role: string) => badRequest(`"${role}" cannot be given to staff. Allowed: ${STAFF_ROLE_KEYS.join(', ')}.`);

// ------------------------------------------------------------------ reads
/** Used by the product to pick assignees: active people only. */
export const listTeam = async (tenantId: string, roles?: string[]): Promise<TeamMember[]> => {
  const rows = await User.find({ tenantId, status: 'active', role: roles?.length ? { $in: roles } : { $nin: PORTAL_ROLE_KEYS } }).sort({ name: 1 }).lean();
  return rows.map((u) => ({ id: String(u._id), name: u.name, role: u.role }));
};

/** Admin view: everyone including blocked staff, with email and last login. */
export const listTeamAdmin = async (tenantId: string) => {
  const rows = await User.find({ tenantId, role: { $nin: PORTAL_ROLE_KEYS } }).sort({ status: 1, name: 1 }).lean();
  return rows.map((u) => ({ id: String(u._id), name: u.name, email: u.email, role: u.role, roleLabel: (ROLES as any)[u.role]?.label, status: u.status, lastLoginAt: u.lastLoginAt }));
};

export const emailTaken = async (email: string): Promise<boolean> => !!(await User.exists({ email: email.toLowerCase() }));

export const countStaff = async (tenantId: string) => {
  const staff = { tenantId, role: { $nin: PORTAL_ROLE_KEYS } };
  const [active, blocked] = await Promise.all([User.countDocuments({ ...staff, status: 'active' }), User.countDocuments({ ...staff, status: 'blocked' })]);
  return { active, blocked };
};

/** All active organisation staff accounts on the platform (for the financial dashboard). Portal logins are not staff. */
export const countActiveStaffAccounts = async (): Promise<number> => User.countDocuments({ tenantId: { $ne: null }, status: 'active', role: { $nin: PORTAL_ROLE_KEYS } });

// ------------------------------------------------------------------ portal users (students, college employees)
/** Invite someone from outside the organisation. They never use a staff seat and only see what their `linkedId` allows. */
export const createPortalUser = async (tenantId: string, input: { role: PortalRole; name: string; email: string; password: string; linkedId: string }) => {
  if (!(PORTAL_ROLE_KEYS as readonly string[]).includes(input.role)) throw badRequest(`"${input.role}" is not a portal role.`);
  if (await emailTaken(input.email)) throw conflict('A user with this email already exists.');
  const u = await User.create({ email: input.email, name: input.name, passwordHash: await hashPassword(input.password), role: input.role, tenantId, linkedId: input.linkedId });
  await recordPlatformAudit({ action: 'portal_user.created', targetType: 'user', targetId: String(u._id), tenantId, meta: { role: input.role, linkedId: input.linkedId } });
  return { id: String(u._id) };
};

/** Turn off (and sign out) every portal login tied to a student/college. */
export const disablePortalUsers = async (tenantId: string, linkedId: string): Promise<number> => {
  const ids = (await User.find({ tenantId, linkedId, role: { $in: PORTAL_ROLE_KEYS } }).select('_id').lean()).map((x) => String(x._id));
  const res = await User.updateMany({ tenantId, linkedId, role: { $in: PORTAL_ROLE_KEYS } }, { $set: { status: 'blocked' }, $inc: { tokenVersion: 1 } });
  await revokeSessionsForUsers(ids);
  if (res.modifiedCount) await recordPlatformAudit({ action: 'portal_user.disabled', targetType: 'user', tenantId, meta: { linkedId, count: res.modifiedCount } });
  return res.modifiedCount;
};

// ------------------------------------------------------------------ writes
/** The single owner of an organisation, created together with it (by `onboarding`). */
export const createOwner = async (tenantId: string, input: { name: string; email: string; password: string }) => {
  const u = await User.create({ email: input.email, name: input.name, passwordHash: await hashPassword(input.password), role: 'owner', tenantId });
  return { id: String(u._id) };
};

export const addTeamMember = async (tenantId: string, input: { name: string; email: string; password: string; role: string }) => {
  if (!(STAFF_ROLE_KEYS as string[]).includes(input.role)) throw rolesError(input.role);
  if (await emailTaken(input.email)) throw conflict('A user with this email already exists.');
  await assertStaffRoom(tenantId);
  const u = await User.create({ email: input.email, name: input.name, passwordHash: await hashPassword(input.password), role: input.role, tenantId });
  await recordPlatformAudit({ action: 'user.created', targetType: 'user', targetId: String(u._id), tenantId, meta: { role: input.role } });
  return { id: String(u._id), name: u.name, role: u.role };
};

const findStaff = async (tenantId: string, userId: string) => {
  if (!isValidObjectId(userId)) throw notFound('Team member');
  const u = await User.findOne({ _id: userId, tenantId });
  if (!u) throw notFound('Team member');
  return u;
};

export const setTeamMemberStatus = async (tenantId: string, userId: string, status: 'active' | 'blocked') => {
  const u = await findStaff(tenantId, userId);
  if (u.role === 'owner' && status === 'blocked') throw badRequest('The organisation owner cannot be blocked.');
  if (status === 'active' && u.status !== 'active') await assertStaffRoom(tenantId); // unblocking uses a seat too
  u.status = status;
  if (status === 'blocked') u.tokenVersion = (u.tokenVersion ?? 0) + 1;
  await u.save();
  if (status === 'blocked') await revokeAllSessions(String(u._id));
  await recordPlatformAudit({ action: status === 'blocked' ? 'user.blocked' : 'user.unblocked', targetType: 'user', targetId: userId, tenantId });
  return { id: String(u._id), status: u.status };
};

export const changeTeamRole = async (tenantId: string, userId: string, role: string) => {
  if (!(STAFF_ROLE_KEYS as string[]).includes(role)) throw rolesError(role);
  const u = await findStaff(tenantId, userId);
  if (u.role === 'owner') throw badRequest("The owner's role cannot be changed.");
  const from = u.role;
  u.role = role;
  await u.save();
  await recordPlatformAudit({ action: 'user.role_changed', targetType: 'user', targetId: userId, tenantId, meta: { from, to: role } });
  return { id: String(u._id), role: u.role };
};

/** Owner sets a new password for a staff member. Their old sessions end immediately. */
export const resetTeamPassword = async (tenantId: string, userId: string, newPassword: string) => {
  const u = await findStaff(tenantId, userId);
  if (u.role === 'owner') throw badRequest('Owners change their own password from their account.');
  u.passwordHash = await hashPassword(newPassword);
  u.tokenVersion = (u.tokenVersion ?? 0) + 1;
  await u.save();
  await revokeAllSessions(String(u._id));
  await recordPlatformAudit({ action: 'user.password_reset', targetType: 'user', targetId: userId, tenantId });
  return { id: String(u._id), sessionsEnded: true };
};
