import { Router } from 'express';
import { z } from 'zod';
import type { Guards } from '../../../../contracts/guards.js';
import { objectId } from '../../../../shared/http/schemas.js';
import { validate } from '../../../../shared/http/validate.js';
import { deletePage, getPage, getSettings, listPages, previewCollegePage, savePage, updateSettings } from '../application/seo.service.js';
import { renderCollegePage } from '../domain/seo.render.js';

const str = (n: number) => z.string().trim().max(n);
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use a colour like #1d4ed8');

const settingsBody = z.object({
  orgSlug: str(60).regex(/^[a-z0-9-]*$/i, 'Letters, digits and dashes only').optional(),
  siteTitle: str(120).optional(),
  tagline: str(200).optional(),
  logoUrl: z.union([z.literal(''), z.string().url().max(400)]).optional(),
  themeColor: color.optional(),
  contact: z.object({ phone: str(20).optional(), email: z.union([z.literal(''), z.string().email().max(160)]).optional(), whatsapp: str(20).optional() }).optional(),
  enabledColleges: z.array(objectId).max(500).optional(),
  leadFormEnabled: z.boolean().optional(),
  consentText: str(400).min(10).optional(),
});

const pageBody = z.object({
  metaTitle: str(120).optional(),
  metaDescription: str(300).optional(),
  heroText: str(500).optional(),
  faqs: z.array(z.object({ q: str(300).min(1), a: str(2000).min(1) })).max(30).optional(),
  published: z.boolean().optional(),
});

/** Staff endpoints (login + organisation + seoPages module are checked by the composition). Permission: seo:manage. */
export const seoRoutes = (g: Guards): Router => {
  const r = Router();
  const wrap = (fn: (req: any) => Promise<unknown>, status = 200) => async (req: any, res: any, next: any) => {
    try {
      res.status(status).json(await fn(req));
    } catch (e) {
      next(e);
    }
  };
  const can = g.requirePermission('seo:manage');
  const collegeId = z.object({ collegeId: objectId });

  r.get('/settings', can, wrap((req) => getSettings(req.principal)));
  r.put('/settings', can, validate({ body: settingsBody }), wrap((req) => updateSettings(req.principal, req.valid.body)));

  r.get('/pages', can, wrap((req) => listPages(req.principal)));
  r.get('/pages/:collegeId', can, validate({ params: collegeId }), wrap((req) => getPage(req.principal, req.valid.params.collegeId)));
  r.put('/pages/:collegeId', can, validate({ params: collegeId, body: pageBody }), wrap((req) => savePage(req.principal, req.valid.params.collegeId, req.valid.body)));
  r.delete('/pages/:collegeId', can, validate({ params: collegeId }), wrap((req) => deletePage(req.principal, req.valid.params.collegeId)));

  // Preview: the page exactly as visitors will see it (also when unpublished). HTML, or JSON with ?format=json for the admin app.
  r.get('/preview/:collegeSlug', can, validate({ params: z.object({ collegeSlug: str(120).min(1) }) }), async (req: any, res, next) => {
    try {
      const v = await previewCollegePage(req.principal, req.valid.params.collegeSlug);
      const html = renderCollegePage({ ...v, utm: {}, preview: true });
      if (req.query.format === 'json') return void res.json({ html });
      res.type('html').send(html);
    } catch (e) {
      next(e);
    }
  });

  return r;
};
