import { isValidObjectId } from 'mongoose';
import { notFound } from '../../../../shared/kernel/errors.js';
import { collectConfigStatus, type ModuleConfigStatus } from '../../../../shared/kernel/configStatus.js';
import { getPlanSummary } from '../../billing/index.js';
import { MODULE_CATALOG, resolveModules } from '../../catalog/index.js';
import { countStaff, countStaffByRole } from '../../identity/index.js';
import { getTenantRecord } from '../../organisations/index.js';
import { rollUpHealth, teamStatus, unmetDependencies } from '../domain/workspace.domain.js';

/**
 * Everything platform staff may see about one organisation. CONFIGURATION and HEALTH only: names, slugs, switches, counts and
 * yes/no facts. Never a student, lead, application, document or ledger value, never a phone/e-mail/name of anyone, never a secret.
 */
export const getWorkspace = async (tenantId: string) => {
  if (!isValidObjectId(tenantId)) throw notFound('Organisation');
  const t = await getTenantRecord(tenantId);
  if (!t) throw notFound('Organisation');

  const effective = resolveModules(MODULE_CATALOG, t.modules ?? {});
  const enabledKeys = MODULE_CATALOG.filter((m) => effective[m.key] && !m.core).map((m) => m.key);
  const [plan, staff, byRole, collected] = await Promise.all([
    getPlanSummary(tenantId),
    countStaff(tenantId),
    countStaffByRole(tenantId),
    collectConfigStatus(tenantId, enabledKeys),
  ]);
  const configs: Record<string, ModuleConfigStatus> = { ...collected };
  configs.team = teamStatus(staff.active, staff.blocked, plan.maxStaff);

  const modules = MODULE_CATALOG.map((m) => {
    const enabled = !!effective[m.key];
    const override = t.priceOverrides?.[m.key];
    return {
      key: m.key,
      label: m.label,
      whatItDoes: m.whatItDoes,
      group: m.group,
      core: !!m.core,
      stage: m.stage,
      dependsOn: m.dependsOn ?? [],
      dependsOnUnmet: unmetDependencies(m.dependsOn, effective),
      priceMonthlyInr: override ?? m.priceMonthlyInr ?? 0,
      priceOverridden: override !== undefined,
      /** switched on by staff but forced off because a required module is off */
      requested: m.core ? true : m.optIn ? t.modules?.[m.key] === true : t.modules?.[m.key] !== false,
      enabled,
      config: enabled ? (configs[m.key] ?? null) : null,
    };
  });

  return {
    organisation: { id: String(t._id), name: t.name, slug: t.slug, status: t.status, createdAt: t.createdAt },
    plan: { key: plan.planKey, name: plan.planName, monthlySubtotalPaise: plan.monthlySubtotalPaise },
    team: { active: staff.active, blocked: staff.blocked, maxStaff: plan.maxStaff, byRole },
    health: rollUpHealth(modules),
    modules,
  };
};
