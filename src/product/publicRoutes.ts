import { Router } from 'express';
import { seoPublicRoutes } from './modules/seoPages/index.js';
import { whatsappPublicRoutes } from './modules/whatsapp/index.js';
import { metaWebhookRoutes } from './modules/metaAds/index.js';
import { publicApiPublicRoutes } from './modules/publicApi/index.js';
import { documentPublicRoutes } from './modules/documents/index.js';

/**
 * Composition of the PUBLIC surface (no login): API-key endpoints for websites and colleges, webhooks from Meta / WhatsApp /
 * Razorpay, and SEO pages. Mounted at /public by the composition root with its own stricter rate limit.
 * Every route here must authenticate itself (API key, webhook signature, signed link) or serve only public data, and must
 * resolve the organisation from the request itself (API key prefix, slug, webhook path), never from a login.
 * NEW PUBLIC FEATURE = a router in its module's http/ folder + one `r.use(...)` line below.
 */
export const buildPublicRouter = (): Router => {
  const r = Router();
  r.use(whatsappPublicRoutes());
  r.use(seoPublicRoutes());
  r.use('/hooks/meta', metaWebhookRoutes());
  r.use('/v1', publicApiPublicRoutes());
  r.use(documentPublicRoutes());
  return r;
};
