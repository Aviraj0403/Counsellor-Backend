import { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import type { Guards } from '../../../../contracts/guards.js';
import { objectId, paging } from '../../../../shared/http/schemas.js';
import { validate } from '../../../../shared/http/validate.js';
import { authenticateKey, createKey, listKeys, requireScope, revokeKey, type KeyContext } from '../application/apiKey.service.js';
import { publicChangeStatus, publicCreateLead, publicListApplications, publicListColleges } from '../application/public.service.js';
import { createWebhook, deleteWebhook, listDeliveries, listWebhooks, retryDelivery, retryDueDeliveries, updateWebhook } from '../application/webhook.service.js';
import { bearerToken, SCOPES, WEBHOOK_EVENTS } from '../domain/publicApi.domain.js';

const wrap = (fn: (req: Request, res: Response) => Promise<void>): RequestHandler => (req, res, next) => {
  fn(req, res).catch(next);
};
const id = z.object({ id: objectId });
const scopes = z.array(z.enum(SCOPES)).min(1, 'Choose at least one permission.');
const events = z.array(z.enum(WEBHOOK_EVENTS)).min(1, 'Choose at least one event.');

/** Staff management, mounted at /integrations/api behind requireModule('publicApi'). */
export const publicApiRoutes = (g: Guards): Router => {
  const r = Router();
  const manage = g.requirePermission('integrations:manage');

  r.get('/meta', manage, wrap(async (_req, res) => void res.json({ scopes: SCOPES, events: WEBHOOK_EVENTS })));

  r.get('/keys', manage, wrap(async (req, res) => void res.json({ items: await listKeys(req.principal!.tenantId!) })));
  r.post(
    '/keys',
    manage,
    validate({ body: z.object({ name: z.string().trim().min(2).max(60), scopes, collegeId: objectId.optional() }) }),
    wrap(async (req, res) => void res.status(201).json(await createKey(req.principal!, req.valid.body))),
  );
  r.post('/keys/:id/revoke', manage, validate({ params: id }), wrap(async (req, res) => void res.json(await revokeKey(req.principal!, req.valid.params.id))));

  r.get('/webhooks', manage, wrap(async (req, res) => void res.json({ items: await listWebhooks(req.principal!.tenantId!) })));
  r.post(
    '/webhooks',
    manage,
    validate({ body: z.object({ url: z.string().trim().max(500), events }) }),
    wrap(async (req, res) => void res.status(201).json(await createWebhook(req.principal!, req.valid.body))),
  );
  r.post('/webhooks/retry', manage, wrap(async (req, res) => void res.json(await retryDueDeliveries(req.principal!.tenantId!))));
  r.patch(
    '/webhooks/:id',
    manage,
    validate({ params: id, body: z.object({ url: z.string().trim().max(500).optional(), events: events.optional(), active: z.boolean().optional() }) }),
    wrap(async (req, res) => void res.json(await updateWebhook(req.principal!, req.valid.params.id, req.valid.body))),
  );
  r.delete('/webhooks/:id', manage, validate({ params: id }), wrap(async (req, res) => void res.json(await deleteWebhook(req.principal!, req.valid.params.id))));

  r.get(
    '/deliveries',
    manage,
    validate({ query: z.object({ webhookId: objectId.optional(), status: z.enum(['retrying', 'delivered', 'failed']).optional() }) }),
    wrap(async (req, res) => void res.json({ items: await listDeliveries(req.principal!.tenantId!, req.valid.query) })),
  );
  r.post('/deliveries/:id/retry', manage, validate({ params: id }), wrap(async (req, res) => void res.json(await retryDelivery(req.principal!, req.valid.params.id))));

  return r;
};

// ---------------------------------------------------------------- public (API key)
const keyAuth = (req: Request, res: Response, next: NextFunction) => {
  authenticateKey(bearerToken(req.header('authorization')))
    .then((ctx) => {
      res.locals.key = ctx;
      next();
    })
    .catch(next);
};
const ctxOf = (res: Response) => res.locals.key as KeyContext;

/** Mounted at /public/v1 by product/publicRoutes.ts. Authenticated only by the API key; the organisation comes from the key. */
export const publicApiPublicRoutes = (): Router => {
  const r = Router();
  r.use(keyAuth);

  r.post(
    '/leads',
    validate({
      body: z.object({
        name: z.string().trim().min(2).max(120),
        phone: z.string().trim().min(5).max(20),
        email: z.string().trim().toLowerCase().email().max(160).optional(),
        city: z.string().trim().max(80).optional(),
        interestedCourse: z.string().trim().max(120).optional(),
        utmSource: z.string().trim().max(80).optional(),
        utmMedium: z.string().trim().max(80).optional(),
        utmCampaign: z.string().trim().max(80).optional(),
        consent: z.object({ given: z.literal(true, { errorMap: () => ({ message: 'Consent from the student is required.' }) }), source: z.string().trim().max(120).optional() }),
      }),
    }),
    wrap(async (req, res) => {
      requireScope(ctxOf(res), 'leads:create');
      const out = await publicCreateLead(ctxOf(res), req.valid.body);
      res.status(out.duplicate ? 200 : 201).json({ ...out, message: out.duplicate ? 'We already have an enquiry for this phone number. No new lead was created.' : 'Lead created.' });
    }),
  );

  r.get('/colleges', wrap(async (_req, res) => {
    requireScope(ctxOf(res), 'colleges:read');
    res.json(await publicListColleges(ctxOf(res)));
  }));

  r.get(
    '/applications',
    validate({ query: paging.extend({ status: z.string().trim().max(30).optional() }) }),
    wrap(async (req, res) => {
      requireScope(ctxOf(res), 'applications:read');
      res.json(await publicListApplications(ctxOf(res), req.valid.query));
    }),
  );

  r.patch(
    '/applications/:id/status',
    validate({ params: id, body: z.object({ status: z.string().trim().min(2).max(30), note: z.string().trim().max(500).optional() }) }),
    wrap(async (req, res) => {
      requireScope(ctxOf(res), 'applications:update');
      res.json(await publicChangeStatus(ctxOf(res), req.valid.params.id, req.valid.body.status, req.valid.body.note));
    }),
  );

  return r;
};
