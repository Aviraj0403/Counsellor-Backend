// PUBLIC API of the `commissions` module.
import { registerEvents as registerCommissionEvents } from './application/commission.service.js';

export { commissionTotals } from './application/commission.service.js';
export { commissionRoutes } from './http/commission.routes.js';

export const registerEvents = (): void => registerCommissionEvents();
/** Commissions registers no guards or export contributors. */
export const registerHooks = (): void => {};
