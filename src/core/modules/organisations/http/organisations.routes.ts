import { Router } from 'express';
import { z } from 'zod';
import type { Guards } from '../../../../contracts/guards.js';
import { objectId, paging } from '../../../../shared/http/schemas.js';
import { validate } from '../../../../shared/http/validate.js';
import { listTenants, renameTenant, setTenantModules, setTenantStatus } from '../application/organisations.service.js';

/** Platform staff: list / rename / suspend organisations and switch their modules. (Creating one lives in `onboarding`.) */
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

  r.patch('/platform/tenants/:id', ...tenantAdmin, validate({ params: idParam, body: z.object({ name: z.string().min(2).max(120) }) }), async (req, res, next) => {
    try {
      res.json(await renameTenant(req.valid.params.id, req.valid.body.name));
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

  return r;
};
