// PUBLIC API of the `catalog` module (what can be sold / switched on, and who may do what). Other modules import ONLY from here.
export { MODULE_BY_KEY, MODULE_CATALOG, type ModuleDef } from './domain/moduleCatalog.js';
export { resolveModules } from './domain/resolve.js';
export { PLATFORM_ROLE_KEYS, PORTAL_ROLE_KEYS, ROLES, ROLE_KEYS, STAFF_ROLE_KEYS, TENANT_ROLE_KEYS, isRoleKey, permissionsFor, type RoleDef, type RoleKey } from './domain/roles.js';
export { catalogRoutes } from './http/catalog.routes.js';
