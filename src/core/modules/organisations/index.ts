// PUBLIC API of the `organisations` module: counsellor businesses, their status and their feature switches.
export {
  createTenantRecord,
  findTenantBySlug,
  deleteTenantRecord,
  enabledModules,
  getTenantAccess,
  getTenantRecord,
  listTenantRecords,
  listTenantSummaries,
  patchPriceOverrides,
  setPlanKey,
  shapeTenant,
  tenantExists,
  tenantSlugTaken,
  type TenantRecord,
} from './application/organisations.service.js';
export { organisationsRoutes } from './http/organisations.routes.js';
