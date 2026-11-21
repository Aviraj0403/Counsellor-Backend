import { Router } from 'express';
import { z } from 'zod';
import type { Guards } from '../../../../contracts/guards.js';
import { objectId, paging } from '../../../../shared/http/schemas.js';
import { validate } from '../../../../shared/http/validate.js';
import rateLimit from 'express-rate-limit';
import { LOGO_URL_MAX, isValidBrandColor, isValidLogoUrl } from '../domain/branding.js';
import { listTenants, setTenantModules, setTenantStatus, startActing, updateTenantProfile } from '../application/organisations.service.js';

/** Platform staff: list / rename / suspend organisations and switch their modules. (Creating one lives in `onboarding`.) */
const logoUrl = z.string().max(LOGO_URL_MAX).refine(isValidLogoUrl, 'Use an https:// link.').nullable();
const brandColor = z.string().refine(isValidBrandColor, 'Use a colour like #1a2b3c.').nullable();

export const organisationsRoutes = (g: Guards): Router => {
  const r = Router();
  const tenantAdmin = [g.authenticate, g.requirePermission('platform:tenants:manage')];
  const idParam = z.object({ id: objectId });

  r.get('/platform/tenants', ...tenantAdmin, validate({ query: paging }), async (req, res, next) => {
    try {
      res.json(await listTenants(req.valid.query));
    } catch (e) {
      next(e);
    }
  });

  r.patch('/platform/tenants/:id', ...tenantAdmin, validate({ params: idParam, body: z.object({ name: z.string().min(2).max(120).optional(), logoUrl: logoUrl.optional(), brandColor: brandColor.optional() }).refine((b) => Object.keys(b).length > 0, { message: 'Send name, logoUrl or brandColor.' }) }), async (req, res, next) => {
    try {
      res.json(await updateTenantProfile(req.valid.params.id, req.valid.body));
    } catch (e) {
      next(e);
    }
  });

  r.patch(
    '/platform/tenants/:id/modules',
    g.authenticate,
    g.requirePermission('platform:modules:manage'),
    validate({ params: idParam, body: z.object({ modules: z.record(z.string(), z.boolean()) }) }),
    async (req, res, next) => {
      try {
        res.json(await setTenantModules(req.valid.params.id, req.valid.body.modules));
      } catch (e) {
        next(e);
      }
    },
  );

  r.patch('/platform/tenants/:id/status', ...tenantAdmin, validate({ params: idParam, body: z.object({ status: z.enum(['active', 'suspended']) }) }), async (req, res, next) => {
    try {
      res.json(await setTenantStatus(req.valid.params.id, req.valid.body.status));
    } catch (e) {
      next(e);
    }
  });

  // Platform staff switch into an organisation: the admin calls this once at the switch; it is the audit record of the start.
  const actingLimiter = rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false });
  r.post('/platform/tenants/:id/acting/start', g.authenticate, g.requirePermission('platform:tenants:impersonate'), actingLimiter, validate({ params: idParam, body: z.object({ reason: z.string().trim().max(300).optional() }).default({}) }), async (req, res, next) => {
    try {
      res.json(await startActing(req.valid.params.id, req.valid.body.reason));
    } catch (e) {
      next(e);
    }
  });

  // The organisation's owner sets their own logo, colour and settings. (Staff acting as the organisation cannot: they lack team:manage.)
  r.patch(
    '/organisation/profile',
    g.authenticate,
    g.requireTenant,
    g.requirePermission('team:manage'),
    validate({
      body: z
        .object({
          logoUrl: logoUrl.optional(),
          brandColor: brandColor.optional(),
          settings: z.object({ counsellorAllStudentsVisible: z.boolean().optional() }).optional(),
        })
        .refine((b) => Object.keys(b).length > 0, { message: 'Send logoUrl, brandColor or settings.' }),
    }),
    async (req, res, next) => {
      try {
        const t = await updateTenantProfile(req.principal!.tenantId!, req.valid.body);
        res.json({ logoUrl: t.logoUrl, brandColor: t.brandColor, settings: t.settings });
      } catch (e) {
        next(e);
      }
    },
  );

  return r;
};
