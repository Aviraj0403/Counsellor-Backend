import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import type { Guards } from '../../../../contracts/guards.js';
import { objectId, paging } from '../../../../shared/http/schemas.js';
import { validate } from '../../../../shared/http/validate.js';
import { centralSummary, listCentral, type CentralQuery } from '../application/central.service.js';
import { CENTRAL_RESOURCES } from '../domain/central.domain.js';

/** Writes the platform audit row. Handed in by the composition root (product code may not import the core). */
export interface CentralDeps {
  recordView: (entry: { resource: string; tenantId?: string; filters: Record<string, unknown> }) => Promise<void>;
}

const text = (max: number) => z.string().trim().min(1).max(max).optional();
const listQuery = paging.extend({
  limit: z.coerce.number().int().min(1).max(50).default(25),
  tenantId: objectId.optional(),
  status: text(40),
  stage: text(40), // alias of status, reads naturally for leads
  q: text(80),
  createdFrom: text(40),
  createdTo: text(40),
  counsellor: text(80),
});
const summaryQuery = z.object({ tenantId: objectId.optional() });

/**
 * Platform staff view across organisations (mounted at /api/v1/platform/central, BEFORE the organisation router).
 * Permission platform:central:read = superadmin only. Every request is audited (what was asked, never the results).
 */
export const centralRoutes = (g: Guards, deps: CentralDeps): Router => {
  const r = Router();
  r.use(g.authenticate, g.requirePermission('platform:central:read'));
  r.use(rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: 'draft-7', legacyHeaders: false }));

  r.get('/summary', validate({ query: summaryQuery }), async (req, res, next) => {
    try {
      const { tenantId } = req.valid.query as z.infer<typeof summaryQuery>;
      await deps.recordView({ resource: 'summary', tenantId, filters: { tenantId } });
      res.json(await centralSummary(tenantId));
    } catch (e) {
      next(e);
    }
  });

  for (const resource of CENTRAL_RESOURCES) {
    r.get(`/${resource}`, validate({ query: listQuery }), async (req, res, next) => {
      try {
        const { stage, ...rest } = req.valid.query as z.infer<typeof listQuery>;
        const query: CentralQuery = { ...rest, status: rest.status ?? stage };
        const { page, limit, ...filters } = query;
        await deps.recordView({ resource, tenantId: query.tenantId, filters: { ...filters, page, limit } });
        res.json(await listCentral(resource, query));
      } catch (e) {
        next(e);
      }
    });
  }
  return r;
};
