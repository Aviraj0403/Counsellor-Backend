import { Router } from 'express';
import type { Guards } from '../../../../contracts/guards.js';
import { MODULE_CATALOG } from '../domain/moduleCatalog.js';
import { ROLES } from '../domain/roles.js';

/** Plain-language lists for the admin screens. The UI renders every module/role list from these, never from hard-coded text. */
export const catalogRoutes = (g: Guards): Router => {
  const r = Router();
  r.get('/catalog/modules', g.authenticate, (_req, res) => res.json({ modules: MODULE_CATALOG }));
  r.get('/catalog/roles', g.authenticate, (_req, res) =>
    res.json({ roles: Object.entries(ROLES).map(([key, d]) => ({ key, label: d.label, scope: d.scope, description: d.description, permissions: d.permissions })) }),
  );
  return r;
};
