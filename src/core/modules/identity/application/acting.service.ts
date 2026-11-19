import { isValidObjectId } from 'mongoose';
import type { Principal } from '../../../../contracts/port.js';
import { forbidden, notFound } from '../../../../shared/kernel/errors.js';
import { recordPlatformAudit } from '../../audit/index.js';
import { ACTING_ROLE, permissionsFor } from '../../catalog/index.js';
import { getTenantRecord } from '../../organisations/index.js';

/**
 * Platform staff acting inside an organisation (docs/adr/0004-acting-as-organisation.md).
 * Honoured ONLY for a verified platform principal holding platform:tenants:impersonate (superadmin). Everything else is refused and audited.
 * The result is a normal tenant principal (so every tenant route, module gate and visibility rule works unchanged), tagged with actingAs.
 */
export const resolveActing = async (principal: Principal, tenantId: string): Promise<Principal> => {
  const allowed = principal.scope === 'platform' && principal.permissions.includes('platform:tenants:impersonate');
  if (!allowed) {
    await recordPlatformAudit({ action: 'tenant.acting_denied', targetType: 'tenant', meta: { attemptedTenantId: tenantId.slice(0, 64), role: principal.role } });
    throw forbidden('Only platform administrators may act inside an organisation.');
  }
  if (!isValidObjectId(tenantId)) throw notFound('Organisation');
  const t = await getTenantRecord(tenantId);
  if (!t) throw notFound('Organisation');
  return {
    userId: principal.userId,
    email: principal.email,
    name: principal.name,
    role: ACTING_ROLE,
    scope: 'tenant',
    tenantId: String(t._id),
    permissions: permissionsFor(ACTING_ROLE),
    linkedId: null,
    actingAs: { tenantId: String(t._id), tenantName: t.name, byUserId: principal.userId },
    platformPermissions: principal.permissions,
  };
};
