// PUBLIC API of the `organisations` module: counsellor businesses, their status and their feature switches.
export {
  createTenantRecord,
  findTenantBySlug,
  deleteTenantRecord,
  enabledModules,
  getTenantAccess,
  getTenantRecord,
  getTenantSettings,
  listTenantRecords,
  listTenantSummaries,
  patchPriceOverrides,
  setPlanKey,
  shapeTenant,
  startActing,
  tenantExists,
  tenantSlugTaken,
  updateTenantProfile,
  type TenantRecord,
} from './application/organisations.service.js';
export { organisationsRoutes } from './http/organisations.routes.js';
