import { Router } from 'express';
import { z } from 'zod';
import type { Guards } from '../../../../contracts/guards.js';
import { env } from '../../../../config/env.js';
import { validate } from '../../../../shared/http/validate.js';
import { AppError, unauthorized, notFound } from '../../../../shared/kernel/errors.js';
import { isValidSignature } from '../domain/meta.domain.js';
import { getConfigView, putConfig } from '../application/meta.config.js';
import { listEvents, sendTestEvent } from '../application/meta.conversions.js';
import { handleLeadgen, verifyHandshake, webhookAvailable } from '../application/meta.webhook.js';
import { audit } from '../../audit/index.js';
import { safeEqual } from '../../../../shared/infra/crypto.js';
import { performance } from '../application/meta.performance.js';
import { getStatus, platformOverview, testConnection } from '../application/meta.status.js';
import { runSyncAll, canSync, syncNow } from '../application/meta.sync.js';
import { loadConfig } from '../application/meta.config.js';
import { badRequest } from '../../../../shared/kernel/errors.js';

const clean = (r: any) => ({ id: String(r._id), kind: r.kind, leadId: r.leadId, eventName: r.eventName, eventId: r.eventId, status: r.status, attempts: r.attempts, httpStatus: r.httpStatus, error: r.error, at: r.at });

/** Staff settings, mounted at /integrations/meta behind requireModule('metaAds'). */
export const metaAdsRoutes = (g: Guards): Router => {
  const r = Router();

  r.get('/config', g.requirePermission('integrations:manage'), async (req, res, next) => {
    try {
      res.json(await getConfigView(req.principal!.tenantId!));
    } catch (e) {
      next(e);
    }
  });

  r.put(
    '/config',
    g.requirePermission('integrations:manage'),
    validate({
      body: z.object({
        pixelId: z.string().trim().regex(/^\d{0,32}$/, 'The Pixel ID is digits only.').optional(),
        pageId: z.string().trim().max(40).optional(),
        accessToken: z.string().trim().max(1000).optional(),
        verifyToken: z.string().trim().min(8).max(100).optional(),
        testEventCode: z.string().trim().max(40).optional(),
        enabled: z.boolean().optional(),
        adAccountIds: z.array(z.string().trim().max(40)).max(10).optional(),
        apiVersion: z.string().trim().max(10).optional(),
        eventMap: z.record(z.string(), z.string().max(40)).optional(),
      }),
    }),
    async (req, res, next) => {
      try {
        res.json(await putConfig(req.principal!, req.valid.body));
      } catch (e) {
        next(e);
      }
    },
  );

  r.post('/test', g.requirePermission('integrations:manage'), async (req, res, next) => {
    try {
      const out = await sendTestEvent(req.principal!.tenantId!);
      await audit(req.principal!.tenantId!, { action: 'meta.test_event', entity: 'metaConfig', meta: { ok: out.ok } });
      res.status(out.ok ? 200 : 400).json(out);
    } catch (e) {
      next(e);
    }
  });

  r.get('/events', g.requirePermission('integrations:manage'), async (req, res, next) => {
    try {
      res.json({ items: (await listEvents(req.principal!.tenantId!)).map(clean) });
    } catch (e) {
      next(e);
    }
  });

  // ---- insights sync (ad accounts, token and status live in the same connection)
  r.post('/connection/test', g.requirePermission('integrations:manage'), async (req, res, next) => {
    try {
      res.json(await testConnection(req.principal!.tenantId!));
    } catch (e) {
      next(e);
    }
  });

  r.get('/status', g.requirePermission('integrations:manage'), async (req, res, next) => {
    try {
      res.json(await getStatus(req.principal!.tenantId!));
    } catch (e) {
      next(e);
    }
  });

  r.post('/sync', g.requirePermission('integrations:manage'), validate({ body: z.object({ days: z.number().int().min(1).max(90).optional() }).default({}) }), async (req, res, next) => {
    try {
      const tenantId = req.principal!.tenantId!;
      if (!canSync(await loadConfig(tenantId))) throw badRequest('Save the access token and at least one ad account id first.');
      res.json(await syncNow(tenantId, req.valid.body?.days));
    } catch (e) {
      next(e);
    }
  });

  r.get('/performance', g.requirePermission('integrations:manage'), validate({ query: z.object({ from: z.string().optional(), to: z.string().optional() }) }), async (req, res, next) => {
    try {
      res.json(await performance(req.principal!.tenantId!, req.valid.query));
    } catch (e) {
      next(e);
    }
  });

  return r;
};

/** Platform staff overview across organisations (mounted at /api/v1/platform/meta). Money and counts only, never a token. */
export const metaPlatformRoutes = (g: Guards): Router => {
  const r = Router();
  r.use(g.authenticate, g.requirePermission('platform:insights:read'));
  r.get('/overview', async (_req, res, next) => {
    try {
      res.json(await platformOverview());
    } catch (e) {
      next(e);
    }
  });
  return r;
};

/** Cron job (mounted at /public/meta). Not tied to a login or an organisation: guarded by the shared JOBS_SECRET, like the appointment reminders. */
export const metaJobsRoutes = (): Router => {
  const r = Router();
  r.post('/jobs/sync-all', async (req, res, next) => {
    try {
      const secret = env.JOBS_SECRET;
      if (!secret || secret.length < 16) throw new AppError(503, 'JOBS_NOT_CONFIGURED', 'Scheduled jobs are not configured on this server (JOBS_SECRET is missing or too short).');
      const given = String(req.headers['x-jobs-secret'] ?? '');
      if (!given || !safeEqual(given, secret)) throw unauthorized('Invalid job secret.');
      res.json(await runSyncAll());
    } catch (e) {
      next(e);
    }
  });
  return r;
};

/** Public webhook, mounted at /hooks/meta under /public. No login: the verify token and the app-secret signature are the auth. */
export const metaWebhookRoutes = (): Router => {
  const r = Router();

  r.get('/:tenantId', async (req, res, next) => {
    try {
      const q = req.query as Record<string, string | undefined>;
      const challenge = await verifyHandshake(String(req.params.tenantId), { mode: q['hub.mode'], token: q['hub.verify_token'], challenge: q['hub.challenge'] });
      if (challenge === null) return next(new AppError(403, 'FORBIDDEN', 'Verification failed.'));
      res.type('text/plain').send(challenge);
    } catch (e) {
      next(e);
    }
  });

  r.post('/:tenantId', async (req, res, next) => {
    try {
      const tenantId = String(req.params.tenantId);
      if (!isValidSignature((req as any).rawBody, req.header('x-hub-signature-256'), env.META_APP_SECRET)) throw unauthorized('Invalid signature.');
      if (!(await webhookAvailable(tenantId))) throw notFound('Webhook');
      const out = await handleLeadgen(tenantId, req.body);
      res.json({ received: true, ...out });
    } catch (e) {
      next(e);
    }
  });

  return r;
};
