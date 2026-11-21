import { Router } from 'express';
import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { validate } from '../../../../shared/http/validate.js';
import { getPublicPoptinConfig, recordImpression, capturePoptinLead } from '../application/poptin.service.js';

const slugParam = z.object({
  slug: z.string().trim().toLowerCase(),
});

export const poptinPublicRoutes = (): Router => {
  const r = Router();

  // Serve client popup embed SDK
  r.get('/poptin/poptin-sdk.js', async (_req, res, next) => {
    try {
      const sdkPath = join(process.cwd(), 'public', 'sdk', 'poptin-sdk.js');
      const script = await readFile(sdkPath, 'utf8');
      res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
      res.setHeader('Cache-Control', 'public, max-age=3600');
      res.send(script);
    } catch (e) {
      next(e);
    }
  });

  // Get active config for embed script
  r.get('/poptin/:slug/config', validate({ params: slugParam }), async (req, res, next) => {
    try {
      const origin = req.headers.origin || req.headers.referer || '';
      const config = await getPublicPoptinConfig(req.valid.params.slug, origin);
      if (!config) {
        return res.status(204).end(); // No Content if disabled or origin not allowed
      }
      res.json(config);
    } catch (e) {
      next(e);
    }
  });

  // Track popup impression
  r.post('/poptin/:slug/impression', validate({ params: slugParam }), async (req, res, next) => {
    try {
      await recordImpression(req.valid.params.slug);
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  // Public lead capture
  r.post(
    '/poptin/:slug/enquiry',
    validate({
      params: slugParam,
      body: z.object({
        name: z.string().min(2).max(120),
        phone: z.string().min(10).max(20),
        email: z.string().email().optional(),
        city: z.string().max(80).optional(),
        interestedCourse: z.string().max(120).optional(),
        sourceUrl: z.string().max(500).optional(),
      }),
    }),
    async (req, res, next) => {
      try {
        const out = await capturePoptinLead(req.valid.params.slug, req.valid.body);
        res.status(out.duplicate ? 200 : 201).json(out);
      } catch (e) {
        next(e);
      }
    },
  );

  return r;
};

