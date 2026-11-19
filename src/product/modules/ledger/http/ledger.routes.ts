import { Router } from 'express';
import { z } from 'zod';
import type { Guards } from '../../../../contracts/guards.js';
import { validate } from '../../../../shared/http/validate.js';
import { balanceOf, getTrialBalance, listEntries, postEntry, reverseEntry } from '../application/ledger.service.js';

const key = z.string().min(8).max(80);

export const ledgerRoutes = (g: Guards): Router => {
  const r = Router();

  r.get(
    '/entries',
    g.requirePermission('ledger:read'),
    validate({ query: z.object({ page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(100).default(25), account: z.string().max(80).optional() }) }),
    async (req, res, next) => {
      try {
        res.json(await listEntries(req.principal!, req.valid.query));
      } catch (e) {
        next(e);
      }
    },
  );

  r.post(
    '/entries',
    g.requirePermission('ledger:post'),
    validate({
      body: z.object({
        idempotencyKey: key,
        reference: z.string().min(1).max(120),
        description: z.string().max(300).optional(),
        lines: z.array(z.object({ account: z.string(), debit: z.number().int().min(0), credit: z.number().int().min(0) })).min(2).max(50),
      }),
    }),
    async (req, res, next) => {
      try {
        const out = await postEntry(req.principal!, req.valid.body);
        res.status(out.replayed ? 200 : 201).json(out);
      } catch (e) {
        next(e);
      }
    },
  );

  r.post(
    '/entries/:id/reverse',
    g.requirePermission('ledger:post'),
    validate({
      params: z.object({ id: z.string().regex(/^[a-f\d]{24}$/i) }),
      body: z.object({ idempotencyKey: key, reason: z.string().min(3).max(300) }),
    }),
    async (req, res, next) => {
      try {
        res.status(201).json(await reverseEntry(req.principal!, req.valid.params.id, req.valid.body.idempotencyKey, req.valid.body.reason));
      } catch (e) {
        next(e);
      }
    },
  );

  r.get('/balance', g.requirePermission('ledger:read'), validate({ query: z.object({ account: z.string().min(3).max(80) }) }), async (req, res, next) => {
    try {
      res.json(await balanceOf(req.principal!, req.valid.query.account));
    } catch (e) {
      next(e);
    }
  });

  r.get('/trial-balance', g.requirePermission('ledger:read'), async (req, res, next) => {
    try {
      res.json(await getTrialBalance(req.principal!));
    } catch (e) {
      next(e);
    }
  });

  return r;
};
