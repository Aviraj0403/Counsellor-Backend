import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { base32Decode, hotp, timeStep } from '../../src/core/modules/identity/domain/mfa.js';

/** Refresh-token rotation + TOTP MFA, against the real app and an in-memory MongoDB. */
let mongod: MongoMemoryServer;
let app: import('express').Express;
let User: typeof import('../../src/core/modules/identity/infrastructure/user.model.js').User;
let RefreshToken: typeof import('../../src/core/modules/identity/infrastructure/refreshToken.model.js').RefreshToken;

const PW = 'Str0ng-Passw0rd!';
const api = () => request(app);
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const doLogin = (email: string, password = PW) => api().post('/api/v1/auth/login').send({ email, password });
const refresh = (refreshToken: string) => api().post('/api/v1/auth/refresh').send({ refreshToken });

// TOTP codes are single-use per 30 s step, so the test moves the clock forward instead of waiting.
const realNow = Date.now.bind(Date);
let skewMs = 0;
const nextStep = () => {
  skewMs += 31_000;
};
const codeFor = (secret: string) => hotp(base32Decode(secret), timeStep(Date.now()));

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri(), { dbName: 'cp_master' });
  const { hashPassword } = await import('../../src/core/modules/identity/infrastructure/security.js');
  ({ User } = await import('../../src/core/modules/identity/infrastructure/user.model.js'));
  ({ RefreshToken } = await import('../../src/core/modules/identity/infrastructure/refreshToken.model.js'));
  app = (await import('../../src/app/app.js')).buildApp();
  const passwordHash = await hashPassword(PW);
  for (const email of ['sess@platform.test', 'pw@platform.test', 'mfa@platform.test', 'lock@platform.test']) {
    await User.create({ email, name: email.split('@')[0], passwordHash, role: 'superadmin', tenantId: null });
  }
  vi.spyOn(Date, 'now').mockImplementation(() => realNow() + skewMs);
});

afterAll(async () => {
  vi.restoreAllMocks();
  await mongoose.disconnect();
  await mongod?.stop();
});

describe('refresh tokens', () => {
  const S = { access: '', r1: '', r2: '', r3: '' };

  it('login stays backwards compatible and adds refreshToken + expiresIn', async () => {
    const res = await doLogin('sess@platform.test');
    expect(res.status).toBe(200);
    S.access = res.body.token;
    S.r1 = res.body.refreshToken;
    expect(S.r1.length).toBeGreaterThan(30);
    expect(res.body.expiresIn).toBe(900);
    expect(res.body.user.email).toBe('sess@platform.test');
    expect((await api().get('/api/v1/me').set(auth(S.access))).body.mfa).toEqual({ enabled: false });
  });

  it('stores only a hash of the refresh token', async () => {
    const rows = await RefreshToken.find({}).lean();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((r) => r.hash === S.r1)).toBe(false);
    expect(JSON.stringify(rows)).not.toContain(S.r1);
  });

  it('rotates: new pair works, the old refresh token is spent', async () => {
    const res = await refresh(S.r1);
    expect(res.status).toBe(200);
    S.r2 = res.body.refreshToken;
    expect(S.r2).not.toBe(S.r1);
    expect((await api().get('/api/v1/me').set(auth(res.body.token))).status).toBe(200);
  });

  it('reuse of a spent token is refused and revokes the whole family', async () => {
    expect((await refresh(S.r1)).status).toBe(401); // replay
    expect((await refresh(S.r2)).status).toBe(401); // the legitimate newest token died with the family
  });

  it('invalid, garbage and expired refresh tokens are 401', async () => {
    expect((await refresh('x'.repeat(40))).status).toBe(401);
    expect((await api().post('/api/v1/auth/refresh').send({})).status).toBe(400);
    const login = await doLogin('sess@platform.test');
    await RefreshToken.updateMany({}, { $set: { expiresAt: new Date(realNow() - 1000) } });
    expect((await refresh(login.body.refreshToken)).status).toBe(401);
  });

  it('logout revokes the refresh token; logout is harmless with junk', async () => {
    const login = await doLogin('sess@platform.test');
    expect((await api().post('/api/v1/auth/logout').send({ refreshToken: login.body.refreshToken })).body.ok).toBe(true);
    expect((await refresh(login.body.refreshToken)).status).toBe(401);
    expect((await api().post('/api/v1/auth/logout').send({ refreshToken: 'nonsense-nonsense' })).status).toBe(200);
  });

  it('logout-all kills every refresh token of the user', async () => {
    const a = await doLogin('sess@platform.test');
    const b = await doLogin('sess@platform.test');
    expect((await api().post('/api/v1/auth/logout-all').set(auth(a.body.token))).status).toBe(200);
    expect((await refresh(a.body.refreshToken)).status).toBe(401);
    expect((await refresh(b.body.refreshToken)).status).toBe(401);
  });

  it('changing the password kills old refresh tokens but returns a fresh working pair', async () => {
    const a = await doLogin('pw@platform.test');
    const other = await doLogin('pw@platform.test');
    const res = await api().post('/api/v1/auth/change-password').set(auth(a.body.token)).send({ currentPassword: PW, newPassword: 'N3w-Passw0rd-Xyz!' });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
    expect((await refresh(a.body.refreshToken)).status).toBe(401);
    expect((await refresh(other.body.refreshToken)).status).toBe(401);
    expect((await refresh(res.body.refreshToken)).status).toBe(200);
  });

  it('a blocked user cannot refresh', async () => {
    const a = await doLogin('sess@platform.test');
    await User.updateOne({ email: 'sess@platform.test' }, { status: 'blocked' });
    expect((await refresh(a.body.refreshToken)).status).toBe(401);
    await User.updateOne({ email: 'sess@platform.test' }, { status: 'active' });
  });
});

describe('MFA (TOTP)', () => {
  const S = { access: '', secret: '', recovery: [] as string[] };
  const email = 'mfa@platform.test';

  it('setup returns a secret + otpauth URL; the secret is encrypted at rest', async () => {
    S.access = (await doLogin(email)).body.token;
    const res = await api().post('/api/v1/auth/mfa/setup').set(auth(S.access));
    expect(res.status).toBe(200);
    S.secret = res.body.secret;
    expect(res.body.otpauthUrl).toContain('otpauth://totp/');
    expect(res.body.otpauthUrl).toContain(S.secret);
    const raw = await User.findOne({ email }).select('+mfaPendingSecretEnc').lean();
    expect(raw?.mfaPendingSecretEnc).toBeTruthy();
    expect(raw?.mfaPendingSecretEnc).not.toContain(S.secret);
    expect((await api().get('/api/v1/me').set(auth(S.access))).body.mfa.enabled).toBe(false);
  });

  it('enable rejects a wrong code, accepts the right one and returns 10 recovery codes', async () => {
    const bad = await api().post('/api/v1/auth/mfa/enable').set(auth(S.access)).send({ code: '000000' });
    expect(bad.status).toBe(400);
    const res = await api().post('/api/v1/auth/mfa/enable').set(auth(S.access)).send({ code: codeFor(S.secret) });
    expect(res.status).toBe(200);
    S.recovery = res.body.recoveryCodes;
    expect(S.recovery).toHaveLength(10);
    expect((await api().get('/api/v1/me').set(auth(S.access))).body.mfa.enabled).toBe(true);
    const raw = await User.findOne({ email }).select('+mfaRecoveryHashes +mfaSecretEnc').lean();
    expect(JSON.stringify(raw)).not.toContain(S.recovery[0]!);
    expect(raw?.mfaRecoveryHashes).toHaveLength(10);
    expect((await api().post('/api/v1/auth/mfa/setup').set(auth(S.access))).status).toBe(409);
  });

  it('login now needs the second step; no tokens before it', async () => {
    const res = await doLogin(email);
    expect(res.status).toBe(200);
    expect(res.body.mfaRequired).toBe(true);
    expect(res.body.mfaToken).toBeTruthy();
    expect(res.body.token).toBeUndefined();
    expect(res.body.refreshToken).toBeUndefined();
    // an mfaToken is not an access token
    expect((await api().get('/api/v1/me').set(auth(res.body.mfaToken))).status).toBe(401);
    // wrong code
    const wrong = await api().post('/api/v1/auth/mfa/verify').send({ mfaToken: res.body.mfaToken, code: '123456' });
    expect(wrong.status).toBe(401);
    // right code (next step, since enable used the current one)
    nextStep();
    const ok = await api().post('/api/v1/auth/mfa/verify').send({ mfaToken: res.body.mfaToken, code: codeFor(S.secret) });
    expect(ok.status).toBe(200);
    expect(ok.body.token).toBeTruthy();
    expect(ok.body.refreshToken).toBeTruthy();
    expect((await api().get('/api/v1/me').set(auth(ok.body.token))).body.mfa.enabled).toBe(true);
    // the same TOTP code cannot be replayed
    const again = await doLogin(email);
    const replay = await api().post('/api/v1/auth/mfa/verify').send({ mfaToken: again.body.mfaToken, code: codeFor(S.secret) });
    expect(replay.status).toBe(401);
  });

  it('a garbage mfaToken is refused', async () => {
    expect((await api().post('/api/v1/auth/mfa/verify').send({ mfaToken: 'garbage-garbage-garbage', code: '123456' })).status).toBe(401);
  });

  it('a recovery code works exactly once', async () => {
    const first = await doLogin(email);
    const ok = await api().post('/api/v1/auth/mfa/verify').send({ mfaToken: first.body.mfaToken, recoveryCode: S.recovery[0] });
    expect(ok.status).toBe(200);
    S.access = ok.body.token;
    const second = await doLogin(email);
    const reuse = await api().post('/api/v1/auth/mfa/verify').send({ mfaToken: second.body.mfaToken, recoveryCode: S.recovery[0] });
    expect(reuse.status).toBe(401);
    const other = await api().post('/api/v1/auth/mfa/verify').send({ mfaToken: second.body.mfaToken, recoveryCode: S.recovery[1]!.toLowerCase() });
    expect(other.status).toBe(200);
  });

  it('disable needs the password and a valid code', async () => {
    nextStep();
    const code = codeFor(S.secret);
    expect((await api().post('/api/v1/auth/mfa/disable').set(auth(S.access)).send({ password: 'wrong-password-1', code })).status).toBe(401);
    expect((await api().post('/api/v1/auth/mfa/disable').set(auth(S.access)).send({ password: PW, code: '111111' })).status).toBe(400);
    const ok = await api().post('/api/v1/auth/mfa/disable').set(auth(S.access)).send({ password: PW, code });
    expect(ok.status).toBe(200);
    expect((await api().get('/api/v1/me').set(auth(S.access))).body.mfa.enabled).toBe(false);
    const login = await doLogin(email);
    expect(login.body.token).toBeTruthy();
    expect(login.body.mfaRequired).toBeUndefined();
  });
});

describe('MFA attempt limiting', () => {
  it('locks after 5 wrong codes, even the correct code is refused (429)', async () => {
    const email = 'lock@platform.test';
    const token = (await doLogin(email)).body.token;
    const { secret } = (await api().post('/api/v1/auth/mfa/setup').set(auth(token))).body;
    nextStep();
    expect((await api().post('/api/v1/auth/mfa/enable').set(auth(token)).send({ code: codeFor(secret) })).status).toBe(200);
    const { mfaToken } = (await doLogin(email)).body;
    for (let i = 0; i < 5; i++) {
      const r = await api().post('/api/v1/auth/mfa/verify').send({ mfaToken, code: '000000' });
      expect(r.status).toBe(401);
    }
    nextStep();
    const locked = await api().post('/api/v1/auth/mfa/verify').send({ mfaToken, code: codeFor(secret) });
    expect(locked.status).toBe(429);
    expect(locked.body.error?.code ?? locked.body.code).toBe('MFA_LOCKED');
    // lock expires (15 min)
    skewMs += 16 * 60_000;
    const fresh = await doLogin(email);
    const ok = await api().post('/api/v1/auth/mfa/verify').send({ mfaToken: fresh.body.mfaToken, code: codeFor(secret) });
    expect(ok.status).toBe(200);
  });
});
