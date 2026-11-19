import { Router } from 'express';
import { z } from 'zod';
import type { Guards } from '../../../../contracts/guards.js';
import { paging } from '../../../../shared/http/schemas.js';
import { validate } from '../../../../shared/http/validate.js';
import { listAudit } from '../application/audit.service.js';

export const auditRoutes = (g: Guards): Router => {
  const r = Router();
  r.get(
    '/audit',
    g.requirePermission('audit:read'),
    validate({ query: paging.extend({ limit: z.coerce.number().int().min(1).max(100).default(50), entityId: z.string().max(40).optional() }) }),
    async (req, res, next) => {
      try {
        res.json(await listAudit(req.principal!.tenantId!, req.valid.query));
      } catch (e) {
        next(e);
      }
    },
  );
  return r;
};
