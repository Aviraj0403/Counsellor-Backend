// Public surface of the contract between the counselling product and the platform core.
export * from './port.js';
export { createGuards, type Guards } from './guards.js';
export { getPlatform, setPlatform } from './registry.js';
export { systemPrincipal } from './system.js';
