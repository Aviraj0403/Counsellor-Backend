import { Router } from 'express';
import { z } from 'zod';
import type { Guards } from '../../../../contracts/guards.js';
import { objectId, paging } from '../../../../shared/http/schemas.js';
import { validate } from '../../../../shared/http/validate.js';
import { listPlatformAudit } from '../application/platformAudit.service.js';

export const platformAuditRoutes = (g: Guards): Router => {
  const r = Router();
  r.get(
    '/platform/audit',
    g.authenticate,
    g.requirePermission('platform:audit:read'),
    validate({ query: paging.extend({ tenantId: objectId.optional() }) }),
    async (req, res, next) => {
      try {
        res.json(await listPlatformAudit(req.valid.query));
      } catch (e) {
        next(e);
      }
    },
  );
  return r;
};
