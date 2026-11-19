import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { AppError, forbidden, unauthorized } from '../shared/kernel/errors.js';
import { getContext } from '../shared/kernel/context.js';
import type { ModuleKey, Permission, PlatformPort } from './port.js';

/**
 * The 4 checks every protected route is built from, in plain words:
 *   authenticate      -> "who are you?"
 *   requireTenant     -> "are you part of a counsellor organisation?"
 *   requireModule     -> "has this feature been switched on for your organisation?"
 *   requirePermission -> "does your role allow this action?"
 */

/** Request header with which platform staff (permission platform:tenants:impersonate) act inside one organisation. */
export const ACTING_HEADER = 'x-acting-tenant';
const AUTH_PATH = /^\/api\/v1\/auth\//;

export const createGuards = (port: PlatformPort) => {
  const authenticate: RequestHandler = async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const header = req.headers.authorization;
      if (!header?.startsWith('Bearer ')) throw unauthorized();
      let principal = await port.verifyAccessToken(header.slice(7));
      const ctx = getContext();
      if (ctx) ctx.userId = principal.userId; // set early so a refused acting attempt is audited against the real person
      // Platform staff acting inside an organisation (docs/adr/0004). Never on /auth/*: login, refresh, password and MFA always act on the real user.
      const acting = req.header(ACTING_HEADER)?.trim();
      if (acting && !AUTH_PATH.test(req.originalUrl.split('?')[0]!)) principal = await port.resolveActing(principal, acting);
      req.principal = principal;
      if (ctx) {
        ctx.tenantId = principal.tenantId ?? undefined;
        if (principal.actingAs) ctx.actingAs = true;
      }
      next();
    } catch (e) {
      next(e);
    }
  };

  const requireTenant: RequestHandler = (req, _res, next) => {
    const p = req.principal;
    if (!p) return next(unauthorized());
    if (p.scope !== 'tenant' || !p.tenantId) {
      return next(forbidden('This action is only for counsellor-organisation accounts.'));
    }
    next();
  };

  const requirePermission =
    (...needed: Permission[]): RequestHandler =>
    (req, _res, next) => {
      const p = req.principal;
      if (!p) return next(unauthorized());
      // while acting, platform:* checks use the staff member's ORIGINAL platform permissions, everything else the acting set
      const missing = needed.filter((x) => !(x.startsWith('platform:') ? (p.platformPermissions ?? p.permissions) : p.permissions).includes(x));
      if (missing.length) return next(forbidden(`Your role (${p.role}) is not allowed to do this.`));
      next();
    };

  const requireModule =
    (key: ModuleKey): RequestHandler =>
    async (req, _res, next) => {
      try {
        const tenantId = req.principal?.tenantId;
        if (!tenantId) throw forbidden();
        const enabled = await port.enabledModules(tenantId);
        if (!enabled[key]) {
          throw new AppError(
            403,
            'MODULE_NOT_ENABLED',
            `The "${key}" feature is not enabled for your organisation. Please contact support to switch it on.`,
          );
        }
        next();
      } catch (e) {
        next(e);
      }
    };

  return { authenticate, requireTenant, requirePermission, requireModule };
};

export type Guards = ReturnType<typeof createGuards>;
