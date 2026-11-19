import { Router } from 'express';
import { z } from 'zod';
import type { Guards } from '../../../../contracts/guards.js';
import { validate } from '../../../../shared/http/validate.js';
import { applicationsReport, counsellorsReport, funnelReport, revenueReport, sourcesReport } from '../application/reports.service.js';

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the format 2026-11-30').refine((s) => {
    const d = new Date(s);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  },'That date does not exist.');
const range = z
  .object({ from: day.optional(), to: day.optional() })
  .refine((q) => !q.from || !q.to || q.from <= q.to, 'The start date must be before the end date.');

export const reportsRoutes = (g: Guards): Router => {
  const r = Router();
  const wrap = (fn: (req: any) => Promise<unknown>) => async (req: any, res: any, next: any) => {
    try {
      res.json(await fn(req));
    } catch (e) {
      next(e);
    }
  };
  const read = g.requirePermission('reports:read');

  r.get('/funnel', read, validate({ query: range }), wrap((req) => funnelReport(req.principal.tenantId)));
  r.get('/sources', read, validate({ query: range }), wrap((req) => sourcesReport(req.principal.tenantId)));
  r.get('/counsellors', read, validate({ query: range }), wrap((req) => counsellorsReport(req.principal.tenantId)));
  r.get('/applications', read, validate({ query: range }), wrap((req) => applicationsReport(req.principal.tenantId)));
  r.get('/revenue', read, validate({ query: range }), wrap((req) => revenueReport(req.principal.tenantId, req.valid.query.from, req.valid.query.to)));

  return r;
};
