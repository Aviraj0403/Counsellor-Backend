// PUBLIC API of the `seoPages` module.
import { registerConfigStatus } from '../../../shared/kernel/configStatus.js';
import { configStatus } from './application/config.status.js';

export { configStatus } from './application/config.status.js';
export { seoRoutes } from './http/seo.routes.js';
export { seoPublicRoutes } from './http/seo.public.routes.js';

export const registerHooks = (): void => registerConfigStatus('seoPages', configStatus);
