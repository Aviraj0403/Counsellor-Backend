import cors from 'cors';
import express from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import mongoose from 'mongoose';
import { env } from '../config/env.js';
import { isAllowedOrigin } from '../core/modules/domains/index.js';
import { buildCoreRouter } from '../core/routes.js';
import { recordPlatformAudit } from '../core/modules/audit/index.js';
import { razorpayWebhookRoutes } from '../core/modules/billing/index.js';
import { centralRoutes } from '../product/modules/central/index.js';
import { insightsRoutes } from '../product/modules/insights/index.js';
import { metaPlatformRoutes } from '../product/modules/metaAds/index.js';
import { buildPublicRouter } from '../product/publicRoutes.js';
import { buildProductRouter } from '../product/routes.js';
import { errorHandler } from '../shared/http/errorHandler.js';
import { logger } from '../shared/infra/logger.js';
import { requestContext } from '../shared/kernel/context.js';
import { AppError } from '../shared/kernel/errors.js';
import { actingAudit } from './actingAudit.js';
import { registerCrossModuleWiring } from './events.js';
import { wirePlatform } from './platform.js';

/** Composition root: builds the HTTP app from the core and the product. Contains no business rules. */
export const buildApp = () => {
  const { guards } = wirePlatform();
  registerCrossModuleWiring();
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // behind one load balancer / reverse proxy

  app.use(requestContext);
  app.use(helmet());
  // exposedHeaders: lets browser code (the admin app) read the request id from the response headers.
  // Origin whitelist = server config (PLATFORM_ORIGINS, CORS_ORIGINS) + domains the superadmin added in the console + localhost outside production.
  app.use(
    cors({
      origin: (origin, cb) => {
        if (!origin) return cb(null, true); // not a browser (curl, server to server): CORS does not apply
        isAllowedOrigin(origin).then((ok) => cb(null, ok), () => cb(null, false));
      },
      credentials: false,
      exposedHeaders: ['x-request-id'],
    }),
  );
  // rawBody: webhooks (Meta, WhatsApp, Razorpay) are signed over the exact bytes, so keep them next to the parsed JSON.
  app.use(express.json({ limit: '100kb', verify: (req, _res, buf) => void ((req as any).rawBody = buf) }));

  app.use((req, res, next) => {
    const started = Date.now();
    res.on('finish', () => logger.info({ method: req.method, path: req.path, status: res.statusCode, ms: Date.now() - started }, 'request'));
    next();
  });

  // Liveness: is the process up? Readiness: can it serve (database connected)?
  app.get('/health', (_req, res) => res.json({ status: 'ok' }));
  app.get('/ready', (_req, res) => {
    const ok = mongoose.connection.readyState === 1;
    res.status(ok ? 200 : 503).json({ status: ok ? 'ready' : 'database_unavailable' });
  });

  app.use('/public', razorpayWebhookRoutes()); // signed payment webhooks; before the generic public router
  // Public surface (API keys, webhooks, SEO pages): no login, so a stricter per-IP limit.
  app.use('/public', rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: 'draft-7', legacyHeaders: false }), buildPublicRouter());

  app.use('/api/v1', actingAudit); // platform staff acting inside an organisation: audit every write and blocked attempt
  app.use('/api/v1', rateLimit({ windowMs: 60_000, limit: 300, standardHeaders: 'draft-7', legacyHeaders: false }));
  app.use('/api/v1', buildCoreRouter(guards)); // identity, organisations, billing, catalogue, platform audit
  app.use('/api/v1/platform/insights', insightsRoutes(guards)); // platform research: must come BEFORE the organisation router
  app.use('/api/v1/platform/meta', metaPlatformRoutes(guards)); // platform view of every organisation's Meta sync (before the organisation router)
  // platform view across organisations (superadmin only, masked, audited). The audit writer comes from the core, injected here because product code may not import it.
  app.use('/api/v1/platform/central', centralRoutes(guards, { recordView: ({ resource, tenantId, filters }) => recordPlatformAudit({ action: 'central.viewed', targetType: 'tenant', targetId: tenantId, tenantId, meta: { resource, filters } }) }));
  app.use('/api/v1', buildProductRouter(guards)); // leads, ledger, audit, ... (add product features in product/routes.ts)

  app.use((_req, _res, next) => next(new AppError(404, 'NOT_FOUND', 'This endpoint does not exist.')));
  app.use(errorHandler);
  return app;
};
