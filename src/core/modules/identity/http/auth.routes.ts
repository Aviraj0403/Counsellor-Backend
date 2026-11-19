import { Router, type Request } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { env } from '../../../../config/env.js';
import type { Guards } from '../../../../contracts/guards.js';
import { password } from '../../../../shared/http/schemas.js';
import { validate } from '../../../../shared/http/validate.js';
import { ROLES } from '../../catalog/index.js';
import { enabledModules } from '../../organisations/index.js';
import { changeOwnPassword, login, logoutEverywhere } from '../application/auth.service.js';
import { getMfaStatus, mfaDisable, mfaEnable, mfaSetup, mfaVerifyLogin } from '../application/mfa.service.js';
import { refreshSession, revokeSession } from '../application/session.service.js';

const ctxOf = (req: Request) => ({ userAgent: req.get('user-agent') ?? undefined, ip: req.ip });

export const authRoutes = (g: Guards): Router => {
  const r = Router();

  // Slows password guessing: N attempts / 15 min / IP (N = LOGIN_RATE_LIMIT_MAX, default 10).
  const loginLimiter = rateLimit({ windowMs: 15 * 60_000, limit: env.LOGIN_RATE_LIMIT_MAX, standardHeaders: 'draft-7', legacyHeaders: false });

  const refreshLimiter = rateLimit({ windowMs: 15 * 60_000, limit: env.LOGIN_RATE_LIMIT_MAX * 6, standardHeaders: 'draft-7', legacyHeaders: false });
  // Per-IP brake on top of the per-account lockout inside the MFA service.
  const mfaLimiter = rateLimit({ windowMs: 15 * 60_000, limit: env.LOGIN_RATE_LIMIT_MAX * 3, standardHeaders: 'draft-7', legacyHeaders: false });

  r.post('/auth/login', loginLimiter, validate({ body: z.object({ email: z.string().email(), password: z.string().min(1).max(128) }) }), async (req, res, next) => {
    try {
      res.json(await login(req.valid.body.email, req.valid.body.password, ctxOf(req)));
    } catch (e) {
      next(e);
    }
  });

  r.post(
    '/auth/change-password',
    g.authenticate,
    validate({ body: z.object({ currentPassword: z.string().min(1).max(128), newPassword: password }) }),
    async (req, res, next) => {
      try {
        res.json(await changeOwnPassword(req.principal!.userId, req.valid.body.currentPassword, req.valid.body.newPassword, ctxOf(req)));
      } catch (e) {
        next(e);
      }
    },
  );

  r.post('/auth/refresh', refreshLimiter, validate({ body: z.object({ refreshToken: z.string().min(10).max(200) }) }), async (req, res, next) => {
    try {
      res.json(await refreshSession(req.valid.body.refreshToken, ctxOf(req)));
    } catch (e) {
      next(e);
    }
  });

  // Ends this login. Always 200: it must be harmless to call with an old or unknown token.
  r.post('/auth/logout', validate({ body: z.object({ refreshToken: z.string().max(200).optional() }) }), async (req, res, next) => {
    try {
      if (req.valid.body.refreshToken) await revokeSession(req.valid.body.refreshToken);
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  const code = z.string().trim().regex(/^[0-9]{6}$/, 'Enter the 6-digit code.');
  r.post('/auth/mfa/verify', mfaLimiter, validate({ body: z.object({ mfaToken: z.string().min(10).max(1000), code: code.optional(), recoveryCode: z.string().trim().min(8).max(20).optional() }).refine((b) => !!b.code !== !!b.recoveryCode, { message: 'Send either code or recoveryCode.' }) }), async (req, res, next) => {
    try {
      res.json(await mfaVerifyLogin(req.valid.body.mfaToken, req.valid.body, ctxOf(req)));
    } catch (e) {
      next(e);
    }
  });
  r.post('/auth/mfa/setup', g.authenticate, async (req, res, next) => {
    try {
      res.json(await mfaSetup(req.principal!.userId));
    } catch (e) {
      next(e);
    }
  });
  r.post('/auth/mfa/enable', g.authenticate, mfaLimiter, validate({ body: z.object({ code }) }), async (req, res, next) => {
    try {
      res.json(await mfaEnable(req.principal!.userId, req.valid.body.code));
    } catch (e) {
      next(e);
    }
  });
  r.post('/auth/mfa/disable', g.authenticate, mfaLimiter, validate({ body: z.object({ password: z.string().min(1).max(128), code }) }), async (req, res, next) => {
    try {
      res.json(await mfaDisable(req.principal!.userId, req.valid.body.password, req.valid.body.code));
    } catch (e) {
      next(e);
    }
  });

  r.post('/auth/logout-all', g.authenticate, async (req, res, next) => {
    try {
      await logoutEverywhere(req.principal!.userId);
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  // "Who am I and what can I do?" The admin UI builds its whole menu from this single call.
  r.get('/me', g.authenticate, async (req, res, next) => {
    try {
      const p = req.principal!;
      const mfa = await getMfaStatus(p.userId);
      const modules = p.tenantId ? await enabledModules(p.tenantId) : null;
      res.json({
        user: { id: p.userId, name: p.name, email: p.email, role: p.role, roleLabel: (ROLES as any)[p.role]?.label },
        scope: p.scope,
        tenantId: p.tenantId,
        permissions: p.permissions,
        modules,
        mfa,
      });
    } catch (e) {
      next(e);
    }
  });

  return r;
};
