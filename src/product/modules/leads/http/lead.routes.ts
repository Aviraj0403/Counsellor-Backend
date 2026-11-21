import { Router } from 'express';
import { z } from 'zod';
import type { Guards } from '../../../../contracts/guards.js';
import { validate } from '../../../../shared/http/validate.js';
import { LEAD_STAGES } from '../domain/lead.domain.js';
import { importLeads } from '../application/lead.import.js';
import { assignLead, changeStage, createLead, getLead, listLeads } from '../application/lead.service.js';
import { getPoptinConfig, savePoptinConfig } from '../application/poptin.service.js';
import { getReferralConfig, listReferrals, updateReferralConfig, updateReferralStatus } from '../application/referral.service.js';

const id = z.object({ id: z.string().regex(/^[a-f\d]{24}$/i, 'Invalid id') });

export const leadRoutes = (g: Guards): Router => {
  const r = Router();

  r.get('/poptin/config', g.requirePermission('leads:read'), async (req, res, next) => {
    try {
      res.json(await getPoptinConfig(req.principal!.tenantId!));
    } catch (e) {
      next(e);
    }
  });

  r.put(
    '/poptin/config',
    g.requirePermission('leads:write'),
    validate({
      body: z.object({
        enabled: z.boolean().optional(),
        headline: z.string().max(140).optional(),
        subheadline: z.string().max(300).optional(),
        allowedDomains: z.array(z.string().trim()).optional(),
        triggers: z
          .object({
            exitIntent: z.boolean().optional(),
            timeDelaySeconds: z.number().min(0).max(300).optional(),
            scrollPercentage: z.number().min(0).max(100).optional(),
          })
          .optional(),
        design: z
          .object({
            themeColor: z.string().optional(),
            buttonText: z.string().optional(),
            buttonColor: z.string().optional(),
            buttonTextColor: z.string().optional(),
            backgroundColor: z.string().optional(),
            textColor: z.string().optional(),
          })
          .optional(),
      }),
    }),
    async (req, res, next) => {
      try {
        res.json(await savePoptinConfig(req.principal!.tenantId!, req.valid.body, req.principal!.userId));
      } catch (e) {
        next(e);
      }
    },
  );

  // Referral program management
  r.get('/referrals/config', g.requirePermission('leads:read'), async (req, res, next) => {
    try {
      res.json(await getReferralConfig(req.principal!.tenantId!));
    } catch (e) {
      next(e);
    }
  });

  r.put(
    '/referrals/config',
    g.requirePermission('leads:write'),
    validate({
      body: z.object({
        enabled: z.boolean().optional(),
        rewardAmountRupees: z.number().min(0).optional(),
        rewardDescription: z.string().max(250).optional(),
        termsAndConditions: z.string().max(500).optional(),
      }),
    }),
    async (req, res, next) => {
      try {
        res.json(await updateReferralConfig(req.principal!.tenantId!, req.valid.body, req.principal!.userId));
      } catch (e) {
        next(e);
      }
    },
  );

  r.get(
    '/referrals',
    g.requirePermission('leads:read'),
    validate({
      query: z.object({
        status: z.enum(['pending', 'enrolled', 'rewarded', 'rejected']).optional(),
        studentId: z.string().optional(),
      }),
    }),
    async (req, res, next) => {
      try {
        res.json({ items: await listReferrals(req.principal!.tenantId!, req.valid.query) });
      } catch (e) {
        next(e);
      }
    },
  );

  r.patch(
    '/referrals/:id/status',
    g.requirePermission('leads:write'),
    validate({
      params: id,
      body: z.object({
        status: z.enum(['pending', 'enrolled', 'rewarded', 'rejected']),
        notes: z.string().max(200).optional(),
      }),
    }),
    async (req, res, next) => {
      try {
        res.json(await updateReferralStatus(req.principal!.tenantId!, req.valid.params.id, req.valid.body.status, req.valid.body.notes));
      } catch (e) {
        next(e);
      }
    },
  );

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
