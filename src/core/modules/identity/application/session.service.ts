import { randomUUID } from 'node:crypto';
import { env } from '../../../../config/env.js';
import { forbidden, unauthorized } from '../../../../shared/kernel/errors.js';
import { randomToken, sha256Hex } from '../../../../shared/infra/crypto.js';
import { getTenantAccess } from '../../organisations/index.js';
import { RefreshToken } from '../infrastructure/refreshToken.model.js';
import { signToken, tokenLifetimeSeconds } from '../infrastructure/security.js';
import { User, type UserDoc } from '../infrastructure/user.model.js';

export interface SessionContext {
  userAgent?: string;
  ip?: string;
}

const REFRESH_TTL_MS = () => env.REFRESH_TOKEN_TTL_DAYS * 86_400_000;

/** Issues an access token + a new opaque refresh token (stored only as a hash). Same family = same login. */
export const issueSession = async (user: Pick<UserDoc, '_id' | 'role' | 'tenantId' | 'tokenVersion'>, ctx: SessionContext = {}, familyId: string = randomUUID()) => {
  const userId = String(user._id);
  const token = signToken({ sub: userId, role: user.role, tid: user.tenantId, tv: user.tokenVersion ?? 0 });
  const refreshToken = randomToken(32);
  await RefreshToken.create({
    userId,
    familyId,
    hash: sha256Hex(refreshToken),
    expiresAt: new Date(Date.now() + REFRESH_TTL_MS()),
    userAgent: ctx.userAgent?.slice(0, 300),
    ip: ctx.ip?.slice(0, 64),
  });
  return { token, refreshToken, expiresIn: tokenLifetimeSeconds(token) };
};

const revokeFamily = (familyId: string) => RefreshToken.updateMany({ familyId, revokedAt: null }, { $set: { revokedAt: new Date() } });

/** Rotation: the presented token is spent and a new one in the same family is returned. Presenting a spent token again = theft signal, the whole family dies. */
export const refreshSession = async (presented: string, ctx: SessionContext = {}) => {
  const invalid = () => unauthorized('Your session has expired. Please log in again.');
  const row = await RefreshToken.findOne({ hash: sha256Hex(presented) });
  if (!row || row.revokedAt || row.expiresAt.getTime() <= Date.now()) throw invalid();
  const claimed = await RefreshToken.findOneAndUpdate({ _id: row._id, usedAt: null, revokedAt: null }, { $set: { usedAt: new Date() } });
  if (!claimed) {
    await revokeFamily(row.familyId); // already used (or a parallel replay): assume it leaked
    throw invalid();
  }
  const user = await User.findById(row.userId).lean();
  if (!user || user.status !== 'active') {
    await revokeFamily(row.familyId);
    throw unauthorized('This account is no longer active.');
  }
  if (user.tenantId && !(await getTenantAccess(user.tenantId)).active) throw forbidden('Your organisation account is suspended.');
  const s = await issueSession(user, ctx, row.familyId);
  return { token: s.token, refreshToken: s.refreshToken, expiresIn: s.expiresIn };
};

/** Logout: ends this login (its refresh family). Unknown tokens are ignored on purpose. */
export const revokeSession = async (presented: string) => {
  const row = await RefreshToken.findOne({ hash: sha256Hex(presented) }).lean();
  if (row) await revokeFamily(row.familyId);
};

export const revokeAllSessions = async (userId: string) => {
  await RefreshToken.updateMany({ userId, revokedAt: null }, { $set: { revokedAt: new Date() } });
};

export const revokeSessionsForUsers = async (userIds: string[]) => {
  if (userIds.length) await RefreshToken.updateMany({ userId: { $in: userIds }, revokedAt: null }, { $set: { revokedAt: new Date() } });
};
