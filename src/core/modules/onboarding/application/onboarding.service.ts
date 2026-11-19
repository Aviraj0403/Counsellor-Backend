import { conflict, notFound } from '../../../../shared/kernel/errors.js';
import { recordPlatformAudit } from '../../audit/index.js';
import { countStaff, createOwner, emailTaken } from '../../identity/index.js';
import { createTenantRecord, deleteTenantRecord, getTenantRecord, shapeTenant, tenantSlugTaken } from '../../organisations/index.js';

/**
 * Use cases that span two modules. They live here, above both, so `organisations` and `identity`
 * never depend on each other in a circle.
 */
export interface CreateTenantInput {
  name: string;
  slug: string;
  ownerName: string;
  ownerEmail: string;
  ownerPassword: string;
}

export const createTenant = async (input: CreateTenantInput) => {
  if (await emailTaken(input.ownerEmail)) throw conflict('A user with this email already exists.');
  if (await tenantSlugTaken(input.slug)) throw conflict('This organisation address (slug) is already taken.');
  const tenantId = await createTenantRecord({ name: input.name, slug: input.slug });
  try {
    const owner = await createOwner(tenantId, { name: input.ownerName, email: input.ownerEmail, password: input.ownerPassword });
    await recordPlatformAudit({ action: 'tenant.created', targetType: 'tenant', targetId: tenantId, tenantId, meta: { name: input.name, slug: input.slug } });
    return { tenantId, ownerId: owner.id };
  } catch (e) {
    await deleteTenantRecord(tenantId); // no half-created organisations
    throw e;
  }
};

export const getTenantDetail = async (tenantId: string) => {
  const t = await getTenantRecord(tenantId);
  if (!t) throw notFound('Organisation');
  return { ...shapeTenant(t), staff: await countStaff(tenantId) };
};
