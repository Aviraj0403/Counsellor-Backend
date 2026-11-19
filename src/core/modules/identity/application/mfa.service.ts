import { AppError, badRequest, conflict, unauthorized } from '../../../../shared/kernel/errors.js';
import { decryptString, encryptString, sha256Hex } from '../../../../shared/infra/crypto.js';
import { recordPlatformAudit } from '../../audit/index.js';
import { generateRecoveryCodes, generateSecret, normalizeRecoveryCode, otpauthUrl, verifyTotp } from '../domain/mfa.js';
import { User } from '../infrastructure/user.model.js';
import { signMfaToken, verifyMfaToken, verifyPassword } from '../infrastructure/security.js';
import { issueSession, type SessionContext } from './session.service.js';

const ISSUER = 'Counsellor Platform';
export const MFA_MAX_ATTEMPTS = 5;
const LOCK_MS = 15 * 60_000;

export const createMfaToken = (userId: string) => signMfaToken(userId);

export const getMfaStatus = async (userId: string) => {
  const u = await User.findById(userId).select('mfaEnabled').lean();
  return { enabled: !!u?.mfaEnabled };
};

const loadUser = async (userId: string) => {
  const u = await User.findById(userId).select('+passwordHash +mfaSecretEnc +mfaPendingSecretEnc +mfaRecoveryHashes');
  if (!u || u.status !== 'active') throw unauthorized('This account is no longer active.');
  return u;
};

type Loaded = Awaited<ReturnType<typeof loadUser>>;

const assertNotLocked = (u: Loaded) => {
  if (u.mfaLockedUntil && u.mfaLockedUntil.getTime() > Date.now()) {
    throw new AppError(429, 'MFA_LOCKED', 'Too many wrong codes. Try again in a few minutes.');
  }
};

const recordFailure = async (u: Loaded) => {
  const count = (u.mfaFailCount ?? 0) + 1;
  const lock = count >= MFA_MAX_ATTEMPTS;
  await User.updateOne({ _id: u._id }, { $set: { mfaFailCount: lock ? 0 : count, mfaLockedUntil: lock ? new Date(Date.now() + LOCK_MS) : null } });
  if (lock) await recordPlatformAudit({ action: 'user.mfa_locked', targetType: 'user', targetId: String(u._id), tenantId: u.tenantId ?? undefined });
};

const recordSuccess = (u: Loaded, step?: number) =>
  User.updateOne({ _id: u._id }, { $set: { mfaFailCount: 0, mfaLockedUntil: null, ...(step ? { mfaLastStep: step } : {}) } });

/** TOTP check that also refuses to accept the same 30 s step twice (replay). */
const checkTotp = (u: Loaded, secret: string, code: string): number | null => {
  const step = verifyTotp(secret, code, Date.now());
  if (step === null || step <= (u.mfaLastStep ?? 0)) return null;
  return step;
};

/** Start enrolment: a pending secret is stored (encrypted) and returned once, to be confirmed with enable. */
export const mfaSetup = async (userId: string) => {
  const u = await loadUser(userId);
  if (u.mfaEnabled) throw conflict('Two-step verification is already on. Turn it off first to set it up again.');
  const secret = generateSecret();
  await User.updateOne({ _id: u._id }, { $set: { mfaPendingSecretEnc: encryptString(secret) } });
  return { secret, otpauthUrl: otpauthUrl(secret, u.email, ISSUER) };
};

export const mfaEnable = async (userId: string, code: string) => {
  const u = await loadUser(userId);
  if (u.mfaEnabled) throw conflict('Two-step verification is already on.');
  if (!u.mfaPendingSecretEnc) throw badRequest('Start setup first.');
  assertNotLocked(u);
  const step = checkTotp(u, decryptString(u.mfaPendingSecretEnc), code);
  if (step === null) {
    await recordFailure(u);
    throw badRequest('That code is not correct. Check your authenticator app and try again.');
  }
  const codes = generateRecoveryCodes(10);
  await User.updateOne(
    { _id: u._id },
    { $set: { mfaEnabled: true, mfaSecretEnc: u.mfaPendingSecretEnc, mfaPendingSecretEnc: null, mfaRecoveryHashes: codes.map((c) => sha256Hex(normalizeRecoveryCode(c))), mfaLastStep: step, mfaFailCount: 0, mfaLockedUntil: null } },
  );
  await recordPlatformAudit({ action: 'user.mfa_enabled', targetType: 'user', targetId: userId, tenantId: u.tenantId ?? undefined });
  return { recoveryCodes: codes };
};

export const mfaDisable = async (userId: string, passwordPlain: string, code: string) => {
  const u = await loadUser(userId);
  if (!u.mfaEnabled || !u.mfaSecretEnc) throw badRequest('Two-step verification is not on.');
  assertNotLocked(u);
  if (!(await verifyPassword(passwordPlain, u.passwordHash))) {
    await recordFailure(u);
    throw unauthorized('Password is incorrect.');
  }
  if (checkTotp(u, decryptString(u.mfaSecretEnc), code) === null) {
    await recordFailure(u);
    throw badRequest('That code is not correct.');
  }
  await User.updateOne(
    { _id: u._id },
    { $set: { mfaEnabled: false, mfaSecretEnc: null, mfaPendingSecretEnc: null, mfaRecoveryHashes: [], mfaLastStep: 0, mfaFailCount: 0, mfaLockedUntil: null } },
  );
  await recordPlatformAudit({ action: 'user.mfa_disabled', targetType: 'user', targetId: userId, tenantId: u.tenantId ?? undefined });
  return { enabled: false };
};

/** Login step two: a valid mfaToken plus a TOTP code or a (single-use) recovery code. */
export const mfaVerifyLogin = async (mfaToken: string, input: { code?: string; recoveryCode?: string }, ctx: SessionContext) => {
  let userId: string;
  try {
    userId = verifyMfaToken(mfaToken);
  } catch {
    throw unauthorized('This sign-in step expired. Please log in again.');
  }
  const u = await loadUser(userId);
  if (!u.mfaEnabled || !u.mfaSecretEnc) throw unauthorized('Please log in again.');
  assertNotLocked(u);
  let ok = false;
  let step: number | undefined;
  if (input.code) {
    const s = checkTotp(u, decryptString(u.mfaSecretEnc), input.code);
    if (s !== null) {
      ok = true;
      step = s;
    }
  } else if (input.recoveryCode) {
    const h = sha256Hex(normalizeRecoveryCode(input.recoveryCode));
    // $pull is the atomic spend: only one concurrent request can remove it
    const res = await User.updateOne({ _id: u._id, mfaRecoveryHashes: h }, { $pull: { mfaRecoveryHashes: h } });
    ok = res.modifiedCount === 1;
    if (ok) await recordPlatformAudit({ action: 'user.mfa_recovery_used', targetType: 'user', targetId: userId, tenantId: u.tenantId ?? undefined });
  }
  if (!ok) {
    await recordFailure(u);
    throw unauthorized('That code is not correct.');
  }
  await recordSuccess(u, step);
  await User.updateOne({ _id: u._id }, { lastLoginAt: new Date() });
  const s = await issueSession(u, ctx);
  return { ...s, user: { id: String(u._id), name: u.name, email: u.email, role: u.role } };
};
