import { Router } from 'express';
import { PORTAL_ROLES } from '../contracts/port.js';
import { forbidden } from '../shared/kernel/errors.js';
import type { Guards } from '../contracts/guards.js';
import { auditRoutes } from './modules/audit/index.js';
import { applicationRoutes } from './modules/applications/index.js';
import { collegeRoutes } from './modules/colleges/index.js';
import { commissionRoutes } from './modules/commissions/index.js';
import { followupRoutes } from './modules/followups/index.js';
import { leadRoutes } from './modules/leads/index.js';
import { metaAdsRoutes } from './modules/metaAds/index.js';
import { portalRoutes } from './modules/portal/index.js';
import { publicApiRoutes } from './modules/publicApi/index.js';
import { ledgerRoutes } from './modules/ledger/index.js';
import { reportsRoutes } from './modules/reports/index.js';
import { seoRoutes } from './modules/seoPages/index.js';
import { documentRoutes } from './modules/documents/index.js';
import { studentRoutes } from './modules/students/index.js';
import { whatsappRoutes } from './modules/whatsapp/index.js';
import { appointmentRoutes } from './modules/appointments/index.js';
import { botsRoutes } from './modules/bots/index.js';

/**
 * Composition of the counselling product (organisation-scoped API). Every route here already passed:
 *   login (authenticate) -> belongs to an organisation (requireTenant) -> feature switched on (requireModule)
 * and then each endpoint checks its own permission.
 * NEW FEATURE = new folder in ./modules + one line below (+ a module key in contracts/port.ts and the core catalogue).
 */
export const buildProductRouter = (g: Guards): Router => {
  const r = Router();
  r.use(g.authenticate, g.requireTenant);

  // Portal people (students, college users) reach ONLY /portal/*; every staff endpoint is closed to them, whatever it checks itself.
  r.use((req, _res, next) => ((PORTAL_ROLES as readonly string[]).includes(req.principal!.role) && !req.path.startsWith('/portal/') ? next(forbidden('Portal accounts can only use the portal.')) : next()));

  r.use('/leads', g.requireModule('leads'), leadRoutes(g));
  r.use('/followups', g.requireModule('followups'), followupRoutes(g));
  r.use('/ledger',g.requireModule('ledger'), ledgerRoutes(g));
  r.use('/students', g.requireModule('students'), studentRoutes(g));
  r.use('/colleges', g.requireModule('colleges'), collegeRoutes(g));
  r.use('/applications', g.requireModule('applications'), applicationRoutes(g));
  r.use('/commissions', g.requireModule('commissions'), commissionRoutes(g));
  r.use('/documents', g.requireModule('documents'), documentRoutes(g));
  r.use('/integrations/meta', g.requireModule('metaAds'), metaAdsRoutes(g));
  r.use('/integrations/api', g.requireModule('publicApi'), publicApiRoutes(g));
  r.use('/whatsapp', g.requireModule('whatsapp'), whatsappRoutes(g));
  r.use('/seo', g.requireModule('seoPages'), seoRoutes(g));
  r.use('/appointments', g.requireModule('appointments'), appointmentRoutes(g));
  r.use('/bots', g.requireModule('aiBot'), botsRoutes(g));
  r.use('/portal', portalRoutes(g)); // each surface checks its own module (studentPortal / collegePortal) in the portal gate
  r.use('/reports', g.requireModule('reports'), reportsRoutes(g));
  r.use(auditRoutes(g)); // permission-gated, not a sellable module

  return r;
};
