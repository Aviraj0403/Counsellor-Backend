import type { PlatformPort } from '../contracts/port.js';
import { recordUsageCost } from './modules/billing/index.js';
import { createPortalUser, disablePortalUsers, listTeam, principalFromToken, resolveActing } from './modules/identity/index.js';
import { enabledModules, findTenantBySlug, getTenantSettings, listTenantSummaries } from './modules/organisations/index.js';

/** Serves the platform contract from this repo's own code and database. Replace with an HTTP client to move to a separate core service. */
export const localPlatform: PlatformPort = {
  verifyAccessToken: principalFromToken,
  resolveActing,
  enabledModules,
  listTeam,
  listTenants: listTenantSummaries,
  findTenantBySlug,
  createPortalUser,
  disablePortalUsers,
  recordUsage: recordUsageCost,
  getTenantSettings,
};
