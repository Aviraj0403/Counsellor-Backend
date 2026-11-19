// PUBLIC API of the `colleges` module.
import { registerConfigStatus } from '../../../shared/kernel/configStatus.js';
import { configStatus } from './application/config.status.js';

export { getCollege, getCourse, getRequiredDocuments, listActiveColleges } from './application/college.service.js';
export { configStatus } from './application/config.status.js';
export { collegeRoutes } from './http/college.routes.js';

export const registerHooks = (): void => registerConfigStatus('colleges', configStatus);
