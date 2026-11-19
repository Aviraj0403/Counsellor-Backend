// PUBLIC API of the `onboarding` module: use cases that span organisations + identity (create an organisation with its owner).
export { createTenant, getTenantDetail, type CreateTenantInput } from './application/onboarding.service.js';
export { onboardingRoutes } from './http/onboarding.routes.js';
