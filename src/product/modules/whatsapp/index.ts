// PUBLIC API of the `whatsapp` module.
import { registerConfigStatus } from '../../../shared/kernel/configStatus.js';
import { configStatus } from './application/config.status.js';

export { sendMessage, dispatchDue, type SendInput } from './application/whatsapp.service.js';
export { registerEvents } from './application/whatsapp.rules.js';
export { configStatus } from './application/config.status.js';
export { whatsappRoutes } from './http/whatsapp.routes.js';
export { whatsappPublicRoutes } from './http/whatsapp.public.routes.js';

/** Registers what the platform staff workspace may know about this module (setup and health only). */
export const registerHooks = (): void => registerConfigStatus('whatsapp', configStatus);
