// PUBLIC API of the `commissions` module.
import { registerConfigStatus } from '../../../shared/kernel/configStatus.js';
import { registerEvents as registerCommissionEvents } from './application/commission.service.js';
import { configStatus } from './application/config.status.js';

export { commissionTotals } from './application/commission.service.js';
export { configStatus } from './application/config.status.js';
export { commissionRoutes } from './http/commission.routes.js';

export const registerEvents = (): void => registerCommissionEvents();
/** Commissions registers no guards or export contributors, only its setup status for the platform staff workspace. */
export const registerHooks = (): void => registerConfigStatus('commissions', configStatus);
