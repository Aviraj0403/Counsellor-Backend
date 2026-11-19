import { Router, type NextFunction, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { env } from '../../../../config/env.js';
import { AppError } from '../../../../shared/kernel/errors.js';
import { safeEqual } from '../../../../shared/infra/crypto.js';
import { loadPublicOrg, manageCancel, manageReschedule, manageView, publicBook, publicSlots, publicTypes, type PublicOrg } from '../application/appointment.public.js';
import { runDueReminders } from '../application/appointment.reminders.js';
import { objectId } from '../../../../shared/http/schemas.js';

/** At most this many bookings or changes per IP per window (the router's own limiter, on top of the global /public one). */
export const BOOK_LIMIT = 30;
export const BOOK_WINDOW_MS = 10 * 60_000;
const token = z.object({ token: z.string().regex(/^[a-f0-9]{48}$/, 'Invalid link') });

type OrgRequest = Request & { org: PublicOrg };

/** PUBLIC (no login). Organisation comes from the slug in the URL; unknown, suspended or module-off = 404. */
export const appointmentPublicRoutes = (): Router => {
  const r = Router();
  const wrap = (fn: (req: OrgRequest, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => void fn(req as unknown as OrgRequest, res).catch(next);
  const noStore = (res: Response) => res.set('Cache-Control', 'no-store');

  // Platform job (cron/pm2). Not tied to a login or an organisation: guarded by a shared secret.
  r.post('/appointments/jobs/run-reminders', async (req, res, next) => {
    try {
      const secret = env.JOBS_SECRET;
      if (!secret || secret.length < 16) throw new AppError(503, 'JOBS_NOT_CONFIGURED', 'Scheduled jobs are not configured on this server (JOBS_SECRET is missing or too short).');
      const given = String(req.headers['x-jobs-secret'] ?? '');
      if (!given || !safeEqual(given, secret)) throw new AppError(401, 'UNAUTHORIZED', 'Invalid job secret.');
      res.json(await runDueReminders());
    } catch (e) {
      next(e);
    }
  });

  r.use('/:slug/appointments', async (req, _res, next) => {
    try {
      const org = await loadPublicOrg(String(req.params.slug));
      if (!org) return next('router'); // unknown, suspended or module off: nothing here, the app answers 404
      (req as unknown as OrgRequest).org = org;
      next();
    } catch (e) {
      next(e);
    }
  });

  r.get('/:slug/appointments/types', wrap(async (req, res) => void noStore(res).json(await publicTypes(req.org))));

  r.get('/:slug/appointments/slots', wrap(async (req, res) => {
    const q = z.object({ typeId: objectId, from: z.coerce.date(), to: z.coerce.date() }).parse(req.query);
    noStore(res).json(await publicSlots(req.org, q));
  }));

  const limiter = rateLimit({
    windowMs: BOOK_WINDOW_MS,
    limit: BOOK_LIMIT,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (_req, _res, next) => next(new AppError(429, 'RATE_LIMITED', 'Too many requests from this connection. Please try again later.')),
  });

  r.post('/:slug/appointments/book', limiter, wrap(async (req, res) => {
    const b = z
      .object({
        typeId: objectId,
        start: z.coerce.date(),
        name: z.string().trim().min(2).max(120),
        phone: z.string().trim().min(6).max(20),
        email: z.union([z.literal(''), z.string().trim().email().max(160)]).optional(),
        answers: z.record(z.string().max(40), z.string().max(500)).optional(),
        consentGiven: z.boolean().optional(),
      })
      .parse(req.body ?? {});
    noStore(res).status(201).json(await publicBook(req.org, { ...b, email: b.email || undefined, consentGiven: b.consentGiven === true }));
  }));

  r.get('/:slug/appointments/manage/:token', wrap(async (req, res) => {
    const { token: t } = token.parse(req.params);
    noStore(res).json(await manageView(req.org, t));
  }));

  r.post('/:slug/appointments/manage/:token', limiter, wrap(async (req, res) => {
    const { token: t } = token.parse(req.params);
    const body = z.discriminatedUnion('action', [z.object({ action: z.literal('cancel'), reason: z.string().trim().max(500).optional() }), z.object({ action: z.literal('reschedule'), start: z.coerce.date() })]).parse(req.body ?? {});
    noStore(res).json(body.action === 'cancel' ? await manageCancel(req.org, t, body.reason) : await manageReschedule(req.org, t, body.start));
  }));

  return r;
};
