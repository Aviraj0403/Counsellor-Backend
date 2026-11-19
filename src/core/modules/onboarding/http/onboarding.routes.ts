import { Router } from 'express';
import { z } from 'zod';
import type { Guards } from '../../../../contracts/guards.js';
import { objectId, password } from '../../../../shared/http/schemas.js';
import { validate } from '../../../../shared/http/validate.js';
import { createTenant, getTenantDetail } from '../application/onboarding.service.js';

export const onboardingRoutes = (g: Guards): Router => {
  const r = Router();
  const tenantAdmin = [g.authenticate, g.requirePermission('platform:tenants:manage')];

  r.post(
    '/platform/tenants',
    ...tenantAdmin,
    validate({
      body: z.object({
        name: z.string().min(2).max(120),
        slug: z.string().regex(/^[a-z0-9-]{3,40}$/, 'Use 3-40 lowercase letters, numbers or hyphens'),
        ownerName: z.string().min(2).max(120),
        ownerEmail: z.string().email(),
        ownerPassword: password,
      }),
    }),
    async (req, res, next) => {
      try {
        res.status(201).json(await createTenant(req.valid.body));
      } catch (e) {
        next(e);
      }
    },
  );

  r.get('/platform/tenants/:id', ...tenantAdmin, validate({ params: z.object({ id: objectId }) }), async (req, res, next) => {
    try {
      res.json(await getTenantDetail(req.valid.params.id));
    } catch (e) {
      next(e);
    }
  });

  return r;
};
