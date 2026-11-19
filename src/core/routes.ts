import { Router } from 'express';
import type { Guards } from '../contracts/guards.js';
import { platformAuditRoutes } from './modules/audit/index.js';
import { billingRoutes } from './modules/billing/index.js';
import { catalogRoutes } from './modules/catalog/index.js';
import { authRoutes, countActiveStaffAccounts, teamRoutes } from './modules/identity/index.js';
import { onboardingRoutes } from './modules/onboarding/index.js';
import { organisationsRoutes } from './modules/organisations/index.js';

/**
 * Composition of the platform core: the ONLY place that knows every core module.
 * Cross-module wiring (like giving billing a staff counter) happens here, not inside the modules.
 */
export const buildCoreRouter = (g: Guards): Router => {
  const r = Router();
  r.use(catalogRoutes(g));
  r.use(authRoutes(g));
  r.use(onboardingRoutes(g));
  r.use(organisationsRoutes(g));
  r.use(billingRoutes(g, { countActiveStaffAccounts }));
  r.use(platformAuditRoutes(g));
  r.use(teamRoutes(g));
  return r;
};
