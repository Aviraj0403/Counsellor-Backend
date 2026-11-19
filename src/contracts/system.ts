import type { Principal } from './port.js';

/**
 * A stand-in "person" for work done by the system itself (a Meta lead webhook, a public API key, an automation rule),
 * so services that expect a Principal keep working and the audit trail shows WHO it was ("system:meta-ads").
 * It has no permissions on purpose: the CALLER decides what the system may do; this only carries identity.
 */
export const systemPrincipal = (tenantId: string, label: string): Principal => ({
  userId: `system:${label}`,
  email: '',
  name: label,
  role: 'system',
  scope: 'tenant',
  tenantId,
  permissions: [],
});
