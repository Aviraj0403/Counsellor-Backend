import { Router } from 'express';
import { z } from 'zod';
import type { Guards } from '../../../../contracts/guards.js';
import { validate } from '../../../../shared/http/validate.js';
import { getWorkspace } from '../application/workspace.service.js';

/** Platform staff: one organisation's modules, setup and health. Switching a module on or off reuses PATCH /platform/tenants/:id/modules. */
export const workspaceRoutes = (g: Guards): Router => {
  const r = Router();
  r.get('/platform/tenants/:id/workspace', g.authenticate, g.requirePermission('platform:tenants:manage'), validate({ params: z.object({ id: z.string().min(1).max(64) }) }), async (req, res, next) => {
    try {
      res.json(await getWorkspace(req.valid.params.id));
    } catch (e) {
      next(e);
    }
  });
  return r;
};
