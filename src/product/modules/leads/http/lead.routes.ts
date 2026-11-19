import { Router } from 'express';
import { z } from 'zod';
import type { Guards } from '../../../../contracts/guards.js';
import { validate } from '../../../../shared/http/validate.js';
import { LEAD_STAGES } from '../domain/lead.domain.js';
import { importLeads } from '../application/lead.import.js';
import { assignLead, changeStage, createLead, getLead, listLeads } from '../application/lead.service.js';

const id = z.object({ id: z.string().regex(/^[a-f\d]{24}$/i, 'Invalid id') });

export const leadRoutes = (g: Guards): Router => {
  const r = Router();

  r.post(
    '/',
    g.requirePermission('leads:write'),
    validate({
      body: z.object({
        name: z.string().min(2).max(120),
        phone: z.string().min(10).max(20),
        email: z.string().email().optional(),
        city: z.string().max(80).optional(),
        interestedCourse: z.string().max(120).optional(),
        source: z.object({
          channel: z.enum(['meta_ads', 'google_ads', 'website', 'whatsapp', 'walk_in', 'import', 'api', 'referral']),
          utmSource: z.string().max(80).optional(),
          utmMedium: z.string().max(80).optional(),
          utmCampaign: z.string().max(120).optional(),
        }),
        consent: z.object({ given: z.boolean(), source: z.string().max(80).optional() }),
        autoAssign: z.boolean().optional(),
      }),
    }),
    async (req, res, next) => {
      try {
        const out = await createLead(req.principal!, req.valid.body);
        res.status(out.duplicate ? 200 : 201).json(out);
      } catch (e) {
        next(e);
      }
    },
  );

  r.post(
    '/import',
    g.requirePermission('leads:import'),
    validate({
      body: z.object({
        rows: z
          .array(
            z.object({
              name: z.any().optional(),
              phone: z.any().optional(),
              email: z.any().optional(),
              city: z.any().optional(),
              interestedCourse: z.any().optional(),
            }),
          )
          .min(1, 'The file has no rows.')
          .max(1000, 'Import at most 1000 rows at a time.'),
        channel: z.literal('import'),
        autoAssign: z.boolean().optional(),
        consentGiven: z.literal(true, { message: 'Confirm that these people agreed to be contacted.' }),
        dryRun: z.boolean().optional(),
      }),
    }),
    async (req, res, next) => {
      try {
        res.json(await importLeads(req.principal!, req.valid.body));
      } catch (e) {
        next(e);
      }
    },
  );

  r.get(
    '/',
    g.requirePermission('leads:read'),
    validate({
      query: z.object({
        page: z.coerce.number().int().min(1).default(1),
        limit: z.coerce.number().int().min(1).max(100).default(25),
        stage: z.enum(LEAD_STAGES).optional(),
        assignedTo: z.string().regex(/^[a-f\d]{24}$/i).optional(),
        search: z.string().max(60).optional(),
      }),
    }),
    async (req, res, next) => {
      try {
        res.json(await listLeads(req.principal!, req.valid.query));
      } catch (e) {
        next(e);
      }
    },
  );

  r.get('/:id', g.requirePermission('leads:read'), validate({ params: id }), async (req, res, next) => {
    try {
      res.json(await getLead(req.principal!, req.valid.params.id));
    } catch (e) {
      next(e);
    }
  });

  r.patch(
    '/:id/stage',
    g.requirePermission('leads:write'),
    validate({ params: id, body: z.object({ stage: z.enum(LEAD_STAGES), note: z.string().max(500).optional() }) }),
    async (req, res, next) => {
      try {
        res.json(await changeStage(req.principal!, req.valid.params.id, req.valid.body.stage, req.valid.body.note));
      } catch (e) {
        next(e);
      }
    },
  );

  r.patch(
    '/:id/assign',
    g.requirePermission('leads:assign'),
    validate({
      params: id,
      body: z
        .object({ assigneeId: z.string().regex(/^[a-f\d]{24}$/i).optional(), auto: z.boolean().optional() })
        .refine((b) => b.assigneeId || b.auto, 'Provide assigneeId or auto: true'),
    }),
    async (req, res, next) => {
      try {
        res.json(await assignLead(req.principal!, req.valid.params.id, req.valid.body));
      } catch (e) {
        next(e);
      }
    },
  );

  return r;
};
