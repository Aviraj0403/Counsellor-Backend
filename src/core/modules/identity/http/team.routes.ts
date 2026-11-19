import { Router } from 'express';
import { z } from 'zod';
import type { Guards } from '../../../../contracts/guards.js';
import { objectId, password } from '../../../../shared/http/schemas.js';
import { validate } from '../../../../shared/http/validate.js';
import { STAFF_ROLE_KEYS } from '../../catalog/index.js';
import { addTeamMember, changeTeamRole, listTeamAdmin, resetTeamPassword, setTeamMemberStatus } from '../application/team.service.js';

const staffRole = z.enum(STAFF_ROLE_KEYS as [string, ...string[]]);

/** Organisation owner: manage their own staff. */
export const teamRoutes = (g: Guards): Router => {
  const r = Router();
  const teamAdmin = [g.authenticate, g.requireTenant, g.requirePermission('team:manage')];
  const userParam = z.object({ userId: objectId });

  r.get('/team', g.authenticate, g.requireTenant, g.requirePermission('team:read'), async (req, res, next) => {
    try {
      res.json({ team: await listTeamAdmin(req.principal!.tenantId!) });
    } catch (e) {
      next(e);
    }
  });

  r.post('/team', ...teamAdmin, validate({ body: z.object({ name: z.string().min(2).max(120), email: z.string().email(), password, role: staffRole }) }), async (req, res, next) => {
    try {
      res.status(201).json(await addTeamMember(req.principal!.tenantId!, req.valid.body));
    } catch (e) {
      next(e);
    }
  });

  r.patch('/team/:userId/status', ...teamAdmin, validate({ params: userParam, body: z.object({ status: z.enum(['active', 'blocked']) }) }), async (req, res, next) => {
    try {
      res.json(await setTeamMemberStatus(req.principal!.tenantId!, req.valid.params.userId, req.valid.body.status));
    } catch (e) {
      next(e);
    }
  });

  r.patch('/team/:userId/role', ...teamAdmin, validate({ params: userParam, body: z.object({ role: staffRole }) }), async (req, res, next) => {
    try {
      res.json(await changeTeamRole(req.principal!.tenantId!, req.valid.params.userId, req.valid.body.role));
    } catch (e) {
      next(e);
    }
  });

  r.post('/team/:userId/reset-password', ...teamAdmin, validate({ params: userParam, body: z.object({ newPassword: password }) }), async (req, res, next) => {
    try {
      res.json(await resetTeamPassword(req.principal!.tenantId!, req.valid.params.userId, req.valid.body.newPassword));
    } catch (e) {
      next(e);
    }
  });

  return r;
};
