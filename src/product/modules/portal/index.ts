// PUBLIC API of the `portal` module (student portal + college portal; one folder, two surfaces).
import { registerEvents as registerInviteEvents } from './application/invite.service.js';

export { portalGate, portalRoutes } from './http/portal.routes.js';
export { collegeMayMoveTo, generateTempPassword } from './domain/portal.domain.js';

export const registerEvents = (): void => registerInviteEvents();
