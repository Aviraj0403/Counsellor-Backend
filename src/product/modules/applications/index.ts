// PUBLIC API of the `applications` module.
import { registerEvents as registerApplicationEvents, registerHooks as registerApplicationHooks } from './application/application.service.js';

export {
  applicationCountsByCollege,
  applicationCountsByCounsellor,
  applicationCountsByStatus,
  changeApplicationStatus,
  getApplication,
  getApplicationDetail,
  listApplicationsForCollege,
  listApplicationsForCentral,
  listApplicationsForStudent,
} from './application/application.service.js';
export type { ApplicationSummary, CentralApplicationRow } from './application/application.service.js';
export { applicationRoutes } from './http/application.routes.js';

export const registerHooks = (): void => registerApplicationHooks();
export const registerEvents = (): void => registerApplicationEvents();
