import type { Principal } from '../../../../contracts/port.js';
import { badRequest, forbidden, unauthorized } from '../../../../shared/kernel/errors.js';
import { recordPlatformAudit } from '../../audit/index.js';
import { ROLES, isRoleKey, permissionsFor } from '../../catalog/index.js';
import { getTenantAccess } from '../../organisations/index.js';
import { User } from '../infrastructure/user.model.js';
import { DUMMY_HASH, hashPassword, verifyPassword, verifyToken } from '../infrastructure/security.js';
import { createMfaToken } from './mfa.service.js';
import { issueSession, revokeAllSessions, type SessionContext } from './session.service.js';

export const login = async (identifier: string, password: string, ctx: SessionContext = {}) => {
  const clean = identifier.trim().toLowerCase();
  // Find by email OR by phone number (+91...)
  const query = clean.includes('@')
    ? { email: clean }
    : { $or: [{ email: clean }, { phone: clean }, { phone: clean.replace(/\D/g, '') }, { phone: `+91${clean.slice(-10)}` }] };

  const user = await User.findOne(query).select('+passwordHash');
  const ok = await verifyPassword(password, user?.passwordHash ?? DUMMY_HASH);
  if (!user || !ok || user.status !== 'active') throw unauthorized('Email or password is incorrect.');
  if (user.tenantId && !(await getTenantAccess(user.tenantId)).active) {
    throw forbidden('Your organisation account is suspended. Please contact support.');
  }
  const profile = { id: String(user._id), name: user.name, email: user.email, role: user.role };
  if (user.mfaEnabled) return { mfaRequired: true as const, mfaToken: createMfaToken(String(user._id)) };
  await User.updateOne({ _id: user._id }, { lastLoginAt: new Date() });
  return { ...(await issueSession(user, ctx)), user: profile };
};

export const principalFromToken = async (token: string): Promise<Principal> => {
  let claims;
  try {
    claims = verifyToken(token);
  } catch {
    throw unauthorized('Your session has expired. Please log in again.');
  }
  // Always re-read the user: blocking someone or changing their role takes effect immediately.
  const user = await User.findById(claims.sub).lean();
  if (!user || user.status !== 'active') throw unauthorized('This account is no longer active.');
  if ((claims as { typ?: string }).typ) throw unauthorized('Your session has expired. Please log in again.'); // e.g. an MFA step token is not an access token
  if ((claims.tv ?? 0) !== (user.tokenVersion ?? 0)) throw unauthorized('Your session was ended. Please log in again.');
  if (user.tenantId && !(await getTenantAccess(user.tenantId)).active) throw forbidden('Your organisation account is suspended.');
  const def = isRoleKey(user.role) ? ROLES[user.role] : undefined;
  return {
    userId: String(user._id),
    email: user.email,
    name: user.name,
    role: user.role,
    scope: def?.scope ?? 'tenant',
    tenantId: user.tenantId,
    permissions: permissionsFor(user.role),
    linkedId: user.linkedId ?? null,
  };
};

/** Changing your password ends every other session and returns a fresh token for this one. */
export const changeOwnPassword = async (userId: string, current: string, next: string, ctx: SessionContext = {}) => {
  const user = await User.findById(userId).select('+passwordHash');
  if (!user || !(await verifyPassword(current, user.passwordHash))) throw unauthorized('Current password is incorrect.');
  if (current === next) throw badRequest('Choose a password different from the current one.');
  user.passwordHash = await hashPassword(next);
  user.tokenVersion = (user.tokenVersion ?? 0) + 1;
  await user.save();
  await recordPlatformAudit({ action: 'user.password_changed', targetType: 'user', targetId: userId, tenantId: user.tenantId ?? undefined });
  await revokeAllSessions(userId);
  return issueSession(user, ctx); // this device stays signed in on a fresh refresh family
};

/** "Log out everywhere": every existing token of this user stops working now. */
export const logoutEverywhere = async (userId: string) => {
  await User.updateOne({ _id: userId }, { $inc: { tokenVersion: 1 } });
  await revokeAllSessions(userId);
};
