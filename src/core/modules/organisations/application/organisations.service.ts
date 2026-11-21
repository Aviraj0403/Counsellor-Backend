import { isValidObjectId } from 'mongoose';
import type { TenantSummary } from '../../../../contracts/port.js';
import { badRequest, notFound } from '../../../../shared/kernel/errors.js';
import { recordPlatformAudit } from '../../audit/index.js';
import { MODULE_BY_KEY, MODULE_CATALOG, resolveModules } from '../../catalog/index.js';
import { isValidBrandColor, isValidLogoUrl } from '../domain/branding.js';
import { Tenant, type TenantDoc } from '../infrastructure/tenant.model.js';

export type TenantRecord = TenantDoc;

export const shapeTenant = (t: TenantRecord) => ({
  id: String(t._id),
  name: t.name,
  slug: t.slug,
  status: t.status,
  logoUrl: t.logoUrl ?? null,
  brandColor: t.brandColor ?? null,
  settings: {
    counsellorAllStudentsVisible: t.settings?.counsellorAllStudentsVisible ?? true,
  },
  modules: resolveModules(MODULE_CATALOG, t.modules ?? {}),
  createdAt: t.createdAt,
});

// ------------------------------------------------------------------ modules (feature switches)
const MODULES_TTL_MS = 30_000;
const moduleCache = new Map<string, { at: number; value: Record<string, boolean> }>();

export const enabledModules = async (tenantId: string): Promise<Record<string, boolean>> => {
  const hit = moduleCache.get(tenantId);
  if (hit && Date.now() - hit.at < MODULES_TTL_MS) return hit.value;
  const t = await Tenant.findById(tenantId).lean();
  if (!t) throw notFound('Organisation');
  const value = resolveModules(MODULE_CATALOG, t.modules ?? {});
  moduleCache.set(tenantId, { at: Date.now(), value });
  return value;
};

export const setTenantModules = async (tenantId: string, changes: Record<string, boolean>) => {
  for (const key of Object.keys(changes)) {
    const def = MODULE_BY_KEY.get(key as any);
    if (!def) throw badRequest(`Unknown module "${key}".`);
    if (def.core) throw badRequest(`"${def.label}" is a core feature and is always on.`);
  }
  const set = Object.fromEntries(Object.entries(changes).map(([k, v]) => [`modules.${k}`, v]));
  const t = await Tenant.findByIdAndUpdate(tenantId, { $set: set }, { new: true }).lean();
  if (!t) throw notFound('Organisation');
  moduleCache.delete(tenantId);
  const effective = resolveModules(MODULE_CATALOG, t.modules ?? {});
  const notStarted = Object.keys(changes).filter((k) => changes[k] && MODULE_BY_KEY.get(k as any)?.stage === 'soon');
  const blockedByDependency = Object.keys(changes).filter((k) => changes[k] && !effective[k]);
  await recordPlatformAudit({ action: 'tenant.modules_changed', targetType: 'module', tenantId, targetId: tenantId, meta: { changes } });
  return {
    modules: effective,
    // plain-language heads-up for the admin: switching a module on is allowed, but these will not fully work
    warnings: [
      ...notStarted.map((k) => `"${MODULE_BY_KEY.get(k as any)!.label}" is marked as coming soon: the feature is not built yet, do not sell it yet.`),
      ...blockedByDependency.map((k) => `"${MODULE_BY_KEY.get(k as any)!.label}" stays off until its required modules are on: ${(MODULE_BY_KEY.get(k as any)!.dependsOn ?? []).join(', ')}.`),
    ],
  };
};

// ------------------------------------------------------------------ organisations
export const listTenants = async (q: { page: number; limit: number }) => {
  const [rows, total] = await Promise.all([
    Tenant.find().sort({ createdAt: -1 }).skip((q.page - 1) * q.limit).limit(q.limit).lean(),
    Tenant.countDocuments(),
  ]);
  return { tenants: rows.map(shapeTenant), total, page: q.page, limit: q.limit };
};

export const renameTenant = async (tenantId: string, name: string) => updateTenantProfile(tenantId, { name });

/** Name, branding or settings. null clears the logo / colour. Used by platform staff (any organisation) and by an organisation's owner (their own, no name). */
export const updateTenantProfile = async (
  tenantId: string,
  patch: {
    name?: string;
    logoUrl?: string | null;
    brandColor?: string | null;
    settings?: { counsellorAllStudentsVisible?: boolean };
  },
) => {
  if (!isValidObjectId(tenantId)) throw notFound('Organisation');
  if (patch.logoUrl && !isValidLogoUrl(patch.logoUrl)) throw badRequest('The logo must be an https:// link of at most 500 characters.');
  if (patch.brandColor && !isValidBrandColor(patch.brandColor)) throw badRequest('The brand colour must look like #1a2b3c.');
  const set: Record<string, unknown> = {};
  for (const k of ['name', 'logoUrl', 'brandColor'] as const) if (patch[k] !== undefined) set[k] = patch[k];
  if (patch.settings?.counsellorAllStudentsVisible !== undefined) {
    set['settings.counsellorAllStudentsVisible'] = patch.settings.counsellorAllStudentsVisible;
  }
  if (!Object.keys(set).length) throw badRequest('Nothing to change.');
  const t = await Tenant.findByIdAndUpdate(tenantId, { $set: set }, { new: true }).lean();
  if (!t) throw notFound('Organisation');
  if (patch.name !== undefined) await recordPlatformAudit({ action: 'tenant.renamed', targetType: 'tenant', targetId: tenantId, tenantId, meta: { name: patch.name } });
  if (patch.logoUrl !== undefined || patch.brandColor !== undefined || patch.settings !== undefined) {
    await recordPlatformAudit({ action: 'tenant.branding_changed', targetType: 'tenant', targetId: tenantId, tenantId, meta: { logoUrl: patch.logoUrl, brandColor: patch.brandColor, settings: patch.settings } });
  }
  return shapeTenant(t);
};

/** The admin calls this when platform staff switch into an organisation. Audited; refuses nothing for suspended organisations (support needs them). */
export const startActing = async (tenantId: string, reason?: string) => {
  if (!isValidObjectId(tenantId)) throw notFound('Organisation');
  const t = await Tenant.findById(tenantId).lean();
  if (!t) throw notFound('Organisation');
  await recordPlatformAudit({ action: 'tenant.acting_started', targetType: 'tenant', targetId: tenantId, tenantId, meta: reason ? { reason } : undefined });
  return { tenant: { id: String(t._id), name: t.name, slug: t.slug, logoUrl: t.logoUrl ?? null, status: t.status } };
};

export const setTenantStatus = async (tenantId: string, status: 'active' | 'suspended') => {
  if (!isValidObjectId(tenantId)) throw notFound('Organisation');
  const t = await Tenant.findByIdAndUpdate(tenantId, { status }, { new: true }).lean();
  if (!t) throw notFound('Organisation');
  await recordPlatformAudit({ action: status === 'suspended' ? 'tenant.suspended' : 'tenant.reactivated', targetType: 'tenant', targetId: tenantId, tenantId });
  return { id: String(t._id), status: t.status };
};

export const getTenantSettings = async (tenantId: string): Promise<{ counsellorAllStudentsVisible?: boolean }> => {
  const t = await Tenant.findById(tenantId).select('settings').lean();
  return { counsellorAllStudentsVisible: t?.settings?.counsellorAllStudentsVisible ?? true };
};

export const listTenantSummaries = async (): Promise<TenantSummary[]> => {
  const rows = await Tenant.find().sort({ name: 1 }).lean();
  return rows.map((t) => ({ id: String(t._id), name: t.name, status: t.status, slug: t.slug, logoUrl: t.logoUrl ?? null }));
};

// ------------------------------------------------------------------ reads and writes other modules need (their only door into Tenant data)
export const getTenantRecord = async (tenantId: string): Promise<TenantRecord | null> => Tenant.findById(tenantId).lean();
export const listTenantRecords = async (): Promise<TenantRecord[]> => Tenant.find().lean();
export const tenantExists = async (tenantId: string): Promise<boolean> => !!(await Tenant.exists({ _id: tenantId }));
export const tenantSlugTaken = async (slug: string): Promise<boolean> => !!(await Tenant.exists({ slug }));

/** Used by login and by every request: is this organisation allowed to operate right now? */
export const getTenantAccess = async (tenantId: string): Promise<{ exists: boolean; active: boolean }> => {
  const t = await Tenant.findById(tenantId).select('status').lean();
  return { exists: !!t, active: t?.status === 'active' };
};

export const createTenantRecord = async (input: { name: string; slug: string }): Promise<string> => String((await Tenant.create(input))._id);
export const deleteTenantRecord = async (tenantId: string): Promise<void> => {
  await Tenant.deleteOne({ _id: tenantId });
};

export const setPlanKey = async (tenantId: string, planKey: string | null): Promise<TenantRecord> => {
  const t = await Tenant.findByIdAndUpdate(tenantId, { planKey }, { new: true }).lean();
  if (!t) throw notFound('Organisation');
  return t;
};

export const patchPriceOverrides = async (tenantId: string, set: Record<string, number>, unset: string[]): Promise<TenantRecord> => {
  const update: Record<string, unknown> = {};
  if (Object.keys(set).length) update.$set = Object.fromEntries(Object.entries(set).map(([k, v]) => [`priceOverrides.${k}`, v]));
  if (unset.length) update.$unset = Object.fromEntries(unset.map((k) => [`priceOverrides.${k}`, 1]));
  const t = await Tenant.findByIdAndUpdate(tenantId, update, { new: true }).lean();
  if (!t) throw notFound('Organisation');
  return t;
};

/** Public pages and webhooks find their organisation by address. Unknown or suspended organisations are invisible to the public. */
export const findTenantBySlug = async (slug: string): Promise<TenantSummary | null> => {
  const t = await Tenant.findOne({ slug: slug.toLowerCase() }).lean();
  return t && t.status === 'active' ? { id: String(t._id), name: t.name, status: t.status } : null;
};
