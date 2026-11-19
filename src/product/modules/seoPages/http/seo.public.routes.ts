import express, { Router, type NextFunction, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { AppError, notFound } from '../../../../shared/kernel/errors.js';
import { getPublicCollegePage, listPublicColleges, loadPublicSite, submitWebsiteLead, type PublicSite } from '../application/seo.service.js';
import { buildRobots, buildSitemap, collegeUrl, renderCollegePage, renderIndexPage, renderMessagePage, type UtmView } from '../domain/seo.render.js';

/** At most this many form posts per IP per window (the router's own limiter, on top of the global /public one). */
export const LEAD_FORM_LIMIT = 20;
export const LEAD_FORM_WINDOW_MS = 10 * 60_000;

const CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src https: data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

const str = (n: number) => z.string().trim().max(n);
const optStr = (n: number) => str(n).optional().transform((v) => v || undefined);
const utmSchema = z.object({ utm_source: optStr(100), utm_medium: optStr(100), utm_campaign: optStr(100) });
const leadForm = z.object({
  name: str(120).min(2, 'Please enter your name.'),
  phone: str(20).min(6, 'Please enter your mobile number.'),
  email: z.union([z.literal(''), z.string().trim().email().max(160)]).optional(),
  city: optStr(80),
  course: optStr(120),
  collegeSlug: optStr(120),
  company_url: z.string().max(500).optional(), // honeypot: real people never see or fill it
  consent: z.any(),
});
const CONSENT_VALUES = new Set([true, 'yes', 'on', 'true', '1']);

const utmFrom = (req: Request): UtmView => {
  const q = utmSchema.safeParse({ ...(typeof req.body === 'object' && req.body ? req.body : {}), ...req.query });
  return q.success ? q.data : {};
};

const sendHtml = (res: Response, html: string, status = 200) => void res.status(status).type('html').set('Content-Security-Policy', CSP).set('Cache-Control', 'public, max-age=300').send(html);

type SiteRequest = Request & { site: PublicSite };

/** PUBLIC (no login). Organisation comes from the slug in the URL; unknown, suspended or module-off = 404. */
export const seoPublicRoutes = (): Router => {
  const r = Router();
  const wrap = (fn: (req: SiteRequest, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => void fn(req as unknown as SiteRequest, res).catch(next);

  r.use('/sites/:slug', async (req, _res, next) => {
    try {
      const site = await loadPublicSite(String(req.params.slug));
      if (!site) throw notFound('Site');
      (req as unknown as SiteRequest).site = site;
      next();
    } catch (e) {
      next(e);
    }
  });

  r.get('/sites/:slug/', wrap(async (req, res) => sendHtml(res, renderIndexPage({ site: req.site.site, colleges: await listPublicColleges(req.site), utm: utmFrom(req) }))));

  r.get('/sites/:slug/sitemap.xml', wrap(async (req, res) => {
    const list = await listPublicColleges(req.site);
    res.type('application/xml').send(buildSitemap(req.site.site, list.map((c) => c.slug)));
  }));

  r.get('/sites/:slug/robots.txt', (req, res) => void res.type('text/plain').send(buildRobots((req as unknown as SiteRequest).site.site)));

  // /colleges/:collegeSlug serves HTML; /colleges/:collegeSlug.json serves public data
  r.get('/sites/:slug/colleges/:collegeSlug', wrap(async (req, res) => {
    let slug = String(req.params.collegeSlug);
    const asJson = slug.endsWith('.json');
    if (asJson) slug = slug.slice(0, -5);
    const page = await getPublicCollegePage(req.site, slug);
    if (!page) throw notFound('College');
    if (asJson) {
      return void res.json({
        url: collegeUrl(req.site.site, page.college.slug),
        college: page.college,
        courses: page.courses,
        faqs: page.override?.faqs ?? [],
      });
    }
    sendHtml(res, renderCollegePage({ site: req.site.site, ...page, utm: utmFrom(req) }));
  }));

  // ---- enquiry form
  const limiter = rateLimit({
    windowMs: LEAD_FORM_WINDOW_MS,
    limit: LEAD_FORM_LIMIT,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (_req, _res, next) => next(new AppError(429, 'RATE_LIMITED', 'Too many enquiries from this connection. Please try again later.')),
  });

  r.post('/sites/:slug/lead', limiter, express.urlencoded({ extended: false, limit: '20kb' }), async (req: Request, res: Response, next: NextFunction) => {
    const site = (req as unknown as SiteRequest).site;
    const wantsJson = !!req.is('application/json') || req.accepts(['html', 'json']) === 'json';
    const done = (status: number, body: { ok: boolean; message: string }) =>
      wantsJson ? void res.status(status).json(body) : void sendHtml(res.set('Cache-Control', 'no-store'), renderMessagePage({ site: site.site, title: body.ok ? 'Thank you' : 'Please check your details', message: body.message }), status);
    try {
      const form = leadForm.parse(req.body ?? {});
      // Honeypot: pretend success so bots learn nothing, create nothing.
      if (form.company_url && form.company_url.trim()) return done(200, { ok: true, message: 'Thank you! Our counsellor will call you soon.' });
      if (!CONSENT_VALUES.has(form.consent)) throw new AppError(400, 'CONSENT_REQUIRED', 'Please tick the consent box so we can contact you.');
      const result = await submitWebsiteLead(site, { ...form, email: form.email || undefined, utm: utmFrom(req) });
      return done(200, { ok: true, message: result.duplicate ? 'Thank you! We already have your details and a counsellor will contact you soon.' : 'Thank you! Our counsellor will call you soon.' });
    } catch (e) {
      if (wantsJson) return next(e);
      if (e instanceof z.ZodError) return done(400, { ok: false, message: e.issues[0]?.message ?? 'Please check the form and try again.' });
      if (e instanceof AppError && e.status < 500) return done(e.status, { ok: false, message: e.message });
      next(e);
    }
  });

  return r;
};
