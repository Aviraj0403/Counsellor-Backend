// PUBLIC API of the `domains` module: which browser origins may call this API (server config + superadmin list).
export { clearOriginCache, configuredOrigins, isAllowedOrigin } from './application/domains.service.js';
export { normalizeOrigin, parseOriginList } from './domain/origin.js';
export { domainsRoutes } from './http/domains.routes.js';
