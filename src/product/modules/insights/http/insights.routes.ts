import { Router } from 'express';
import type { Guards } from '../../../../contracts/guards.js';
import { funnelAcrossOrganisations, usageAcrossOrganisations } from '../application/insights.service.js';

/** Platform-staff research endpoints (not tied to one organisation). Mounted before the organisation router. */
export const insightsRoutes = (g: Guards): Router => {
  const r = Router();
  r.use(g.authenticate, g.requirePermission('platform:insights:read'));

  r.get('/funnel', async (_req, res, next) => {
    try {
      res.json(await funnelAcrossOrganisations());
    } catch (e) {
      next(e);
    }
  });

  r.get('/usage', async (_req, res, next) => {
    try {
      res.json(await usageAcrossOrganisations());
    } catch (e) {
      next(e);
    }
  });

  return r;
};
