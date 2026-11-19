// PUBLIC API of the `bots` module (module key `aiBot`).
import { registerConfigStatus } from '../../../shared/kernel/configStatus.js';
import { registerHooks as registerBotExports } from './application/bot.hooks.js';
import { configStatus } from './application/config.status.js';

export { registerEvents } from './application/bot.hooks.js';
export { configStatus } from './application/config.status.js';
export { botsRoutes } from './http/bots.routes.js';
export { botsPublicRoutes } from './http/bots.public.routes.js';

export const registerHooks = (): void => {
  registerBotExports();
  registerConfigStatus('aiBot', configStatus);
};
