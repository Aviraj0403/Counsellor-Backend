import { Router } from 'express';
import { z } from 'zod';
import type { Guards } from '../../../../contracts/guards.js';
import { objectId, paging } from '../../../../shared/http/schemas.js';
import { validate } from '../../../../shared/http/validate.js';
import { collect, createRule, deleteRule, listAccruals, listRules, payout, reverse, summaryPerCounsellor, updateRule } from '../application/commission.service.js';

const id = z.object({ id: objectId });
const bps = z.number().int().min(0).max(10000);
const paise = z.number().int().min(0).max(1_000_000_000_00);
const ruleBody = {
  mode: z.enum(['percent_of_fee', 'flat', 'none']),
  percentBps: bps.optional(),
  flatPaise: paise.optional(),
  trigger: z.enum(['fee_paid', 'admitted']),
  counsellorShareBps: bps.optional(),
  active: z.boolean().optional(),
};

export const commissionRoutes = (g: Guards): Router => {
  const r = Router();
  const wrap = (fn: (req: any) => Promise<unknown>, status = 200) => async (req: any, res: any, next: any) => {
    try {
      res.status(status).json(await fn(req));
    } catch (e) {
      next(e);
    }
  };

  r.get('/rules', g.requirePermission('commissions:read'), wrap((req) => listRules(req.principal.tenantId)));
  r.post('/rules', g.requirePermission('commissions:manage'), validate({ body: z.object({ collegeId: objectId, ...ruleBody }) }), wrap((req) => createRule(req.principal, req.valid.body), 201));
  r.patch('/rules/:id', g.requirePermission('commissions:manage'), validate({ params: id, body: z.object(ruleBody).partial() }), wrap((req) => updateRule(req.principal, req.valid.params.id, req.valid.body)));
  r.delete('/rules/:id', g.requirePermission('commissions:manage'), validate({ params: id }), wrap((req) => deleteRule(req.principal, req.valid.params.id)));

  r.get('/summary', g.requirePermission('commissions:read'), wrap((req) => summaryPerCounsellor(req.principal)));

  r.post(
    '/payouts',
    g.requirePermission('commissions:manage'),
    validate({ body: z.object({ counsellorId: objectId, amountPaise: paise.refine((n) => n > 0, 'Enter an amount greater than zero.'), reference: z.string().trim().min(2).max(80) }) }),
    wrap(async (req) => {
      const out = await payout(req.principal, req.valid.body);
      return out;
    }, 201),
  );

  r.get(
    '/',
    g.requirePermission('commissions:read'),
    validate({ query: paging.extend({ status: z.enum(['accrued', 'collected', 'reversed']).optional(), collegeId: objectId.optional(), counsellorId: objectId.optional() }) }),
    wrap((req) => listAccruals(req.principal, req.valid.query)),
  );

  r.post('/:id/collect', g.requirePermission('commissions:manage'), validate({ params: id, body: z.object({ reference: z.string().trim().min(2).max(80) }) }), wrap((req) => collect(req.principal, req.valid.params.id, req.valid.body.reference)));
  r.post('/:id/reverse', g.requirePermission('commissions:manage'), validate({ params: id, body: z.object({ reason: z.string().trim().min(3).max(500) }) }), wrap((req) => reverse(req.principal, req.valid.params.id, req.valid.body.reason)));

  return r;
};
