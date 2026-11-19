// PUBLIC API of the `portal` module (student portal + college portal; one folder, two surfaces).
import { registerConfigStatus } from '../../../shared/kernel/configStatus.js';
import { registerEvents as registerInviteEvents } from './application/invite.service.js';
import { collegePortalStatus, studentPortalStatus } from './application/config.status.js';

export { portalGate, portalRoutes } from './http/portal.routes.js';
export { collegeMayMoveTo, generateTempPassword } from './domain/portal.domain.js';
export { collegePortalStatus as collegePortalConfigStatus, studentPortalStatus as studentPortalConfigStatus } from './application/config.status.js';

export const registerEvents = (): void => registerInviteEvents();
export const registerHooks = (): void => {
  registerConfigStatus('studentPortal', studentPortalStatus);
  registerConfigStatus('collegePortal', collegePortalStatus);
};
