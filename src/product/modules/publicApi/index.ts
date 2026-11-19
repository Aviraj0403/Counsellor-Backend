// PUBLIC API of the `publicApi` module.
import { registerConfigStatus } from '../../../shared/kernel/configStatus.js';
import { configStatus } from './application/config.status.js';

export { registerEvents, retryDueDeliveries, settle as settlePublicApi } from './application/webhook.service.js';
export { resetRateLimits as resetPublicApiRateLimits } from './application/apiKey.service.js';
export { configStatus } from './application/config.status.js';
export { publicApiRoutes, publicApiPublicRoutes } from './http/publicApi.routes.js';

export const registerHooks = (): void => registerConfigStatus('publicApi', configStatus);
