// PUBLIC API of the `metaAds` module.
export { registerEvents, settle as settleMetaAds } from './application/meta.conversions.js';
export { metaAdsRoutes, metaWebhookRoutes } from './http/meta.routes.js';
export { metaJobsRoutes, metaPlatformRoutes } from './http/meta.routes.js';
export { runSyncAll } from './application/meta.sync.js';
