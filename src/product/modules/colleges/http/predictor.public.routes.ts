import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../../../../shared/http/validate.js';
import { getPlatform } from '../../../../contracts/registry.js';
import { systemPrincipal } from '../../../../contracts/system.js';
import { notFound } from '../../../../shared/kernel/errors.js';
import { predictBTechAdmission } from '../application/college.service.js';
import { createLead } from '../../leads/application/lead.service.js';

const str = (n: number) => z.string().trim().max(n);

export const collegePredictorPublicRoutes = (): Router => {
  const r = Router();

  /**
   * Public B.Tech College & Cutoff Predictor endpoint (Lead Magnet).
   * Generates admission probabilities and automatically captures high-intent student leads into the CRM.
   */
  r.post(
    '/predict/:slug',
    validate({
      params: z.object({ slug: str(40).toLowerCase() }),
      body: z.object({
        name: str(120).min(2),
        phone: str(20).min(10),
        exam: z.enum(['jee_main', 'mht_cet', 'wbjee', 'kcet', 'direct_12th']),
        rank: z.number().int().min(1).max(2_000_000).optional(),
        percentile: z.number().min(0).max(100).optional(),
        percentage: z.number().min(0).max(100).optional(),
        category: z.enum(['general', 'obc', 'sc', 'st', 'ews', 'management']),
        preferredBranches: z.array(str(80)).optional(),
        preferredCities: z.array(str(80)).optional(),
        budgetMaxPaise: z.number().int().min(0).optional(),
      }),
    }),
    async (req, res, next) => {
      try {
        const tenant = await getPlatform().findTenantBySlug(req.valid.params.slug);
        if (!tenant || tenant.status === 'suspended') throw notFound('Organisation');

        const { name, phone, ...criteria } = req.valid.body;

        // 1. Calculate predictions
        const result = await predictBTechAdmission(tenant.id, criteria);

        // 2. Ingest student lead into CRM pipeline
        const branches = criteria.preferredBranches?.join(', ');
        await createLead(systemPrincipal(tenant.id, 'college-predictor'), {
          name,
          phone,
          interestedCourse: branches ? `B.Tech (${branches})` : 'B.Tech Engineering',
          city: criteria.preferredCities?.[0],
          source: {
            channel: 'website',
            utmSource: 'btech_rank_predictor',
            utmMedium: criteria.exam,
          },
          consent: {
            given: true,
            source: 'public_rank_calculator',
          },
          autoAssign: true,
        });

        res.json({
          predictions: result.predictions,
          total: result.total,
        });
      } catch (e) {
        next(e);
      }
    },
  );

  return r;
};

