import { Router } from 'express';
import { z } from 'zod';
import type { Guards } from '../../../../contracts/guards.js';
import { objectId } from '../../../../shared/http/schemas.js';
import { validate } from '../../../../shared/http/validate.js';
import { addDomain, listDomains, removeDomain, updateDomain } from '../application/domains.service.js';
import { DOMAIN_KINDS } from '../infrastructure/allowedDomain.model.js';

/** Superadmin console: which websites (admin, portals, organisation domains) the browser is allowed to call this API from. */
export const domainsRoutes = (g: Guards): Router => {
  const r = Router();
  const gate = [g.authenticate, g.requirePermission('platform:domains:manage')];
  const idParam = z.object({ id: objectId });

  r.get('/platform/domains', ...gate, async (_req, res, next) => {
    try {
      res.json(await listDomains());
    } catch (e) {
      next(e);
    }
  });

  r.post(
    '/platform/domains',
    ...gate,
    validate({
      body: z.object({
        origin: z.string().min(3).max(300),
        label: z.string().max(120).optional(),
        kind: z.enum(DOMAIN_KINDS).default('admin'),
        tenantId: objectId.nullable().optional(),
        note: z.string().max(300).optional(),
      }),
    }),
    async (req, res, next) => {
      try {
        res.status(201).json(await addDomain(req.valid.body));
      } catch (e) {
        next(e);
      }
    },
  );

  r.patch(
    '/platform/domains/:id',
    ...gate,
    validate({
      params: idParam,
      body: z
        .object({ active: z.boolean(), label: z.string().max(120), kind: z.enum(DOMAIN_KINDS), note: z.string().max(300), tenantId: objectId.nullable() })
        .partial()
        .refine((b) => Object.keys(b).length > 0, 'Nothing to update'),
    }),
    async (req, res, next) => {
      try {
        res.json(await updateDomain(req.valid.params.id, req.valid.body));
      } catch (e) {
        next(e);
      }
    },
  );

  r.delete('/platform/domains/:id', ...gate, validate({ params: idParam }), async (req, res, next) => {
    try {
      res.json(await removeDomain(req.valid.params.id));
    } catch (e) {
      next(e);
    }
  });

  return r;
};
