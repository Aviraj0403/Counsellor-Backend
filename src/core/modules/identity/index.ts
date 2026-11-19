// PUBLIC API of the `identity` module: users, login/sessions, an organisation's staff, and portal logins.
export { resolveActing } from './application/acting.service.js';
export { principalFromToken } from './application/auth.service.js';
export { countActiveStaffAccounts, countStaff, countStaffByRole, createOwner, createPortalUser, disablePortalUsers, emailTaken, listTeam } from './application/team.service.js';
export { authRoutes } from './http/auth.routes.js';
export { teamRoutes } from './http/team.routes.js';
