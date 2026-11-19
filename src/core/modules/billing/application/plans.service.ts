import { isValidObjectId } from 'mongoose';
import { badRequest, conflict, notFound } from '../../../../shared/kernel/errors.js';
import { recordPlatformAudit } from '../../audit/index.js';
import { MODULE_BY_KEY } from '../../catalog/index.js';
import { getTenantRecord, setPlanKey } from '../../organisations/index.js';
import { Plan } from '../infrastructure/plan.model.js';

const checkModules = (keys: string[]) => {
  for (const k of keys) {
    const def = MODULE_BY_KEY.get(k as any);
    if (!def) throw badRequest(`Unknown module "${k}".`);
    if (def.core) throw badRequest(`"${def.label}" is a core feature, it cannot be listed in a plan.`);
  }
};

export const shapePlan = (p: any) => ({
  id: String(p._id),
  key: p.key,
  name: p.name,
  description: p.description,
  basePricePaise: p.basePricePaise,
  includedModules: p.includedModules,
  maxStaff: p.maxStaff ?? null,
  active: p.active,
});

export const listPlans = async () => (await Plan.find().sort({ basePricePaise: 1 }).lean()).map(shapePlan);

export const createPlan = async (input: { key: string; name: string; description?: string; basePricePaise: number; includedModules: string[]; maxStaff?: number | null }) => {
  checkModules(input.includedModules);
  if (await Plan.exists({ key: input.key })) throw conflict('A plan with this key already exists.');
  const p = await Plan.create(input);
  await recordPlatformAudit({ action: 'plan.created', targetType: 'plan', targetId: String(p._id), meta: { key: input.key } });
  return shapePlan(p.toObject());
};

export const updatePlan = async (
  id: string,
  input: Partial<{ name: string; description: string; basePricePaise: number; includedModules: string[]; maxStaff: number | null; active: boolean }>,
) => {
  if (!isValidObjectId(id)) throw notFound('Plan');
  if (input.includedModules) checkModules(input.includedModules);
  const p = await Plan.findByIdAndUpdate(id, { $set: input }, { new: true }).lean();
  if (!p) throw notFound('Plan');
  await recordPlatformAudit({ action: 'plan.updated', targetType: 'plan', targetId: id, meta: { fields: Object.keys(input) } });
  return shapePlan(p);
};

export const assignPlan = async (tenantId: string, planKey: string | null) => {
  if (planKey && !(await Plan.exists({ key: planKey, active: true }))) throw badRequest('That plan does not exist or is not active.');
  const t = await setPlanKey(tenantId, planKey);
  await recordPlatformAudit({ action: 'tenant.plan_changed', targetType: 'tenant', targetId: tenantId, tenantId, meta: { planKey } });
  return { planKey: t.planKey ?? null };
};

/** The staff limit of an organisation's plan, or null when it has no plan / no limit. Used by `identity` when adding staff. */
export const getStaffLimit = async (tenantId: string): Promise<{ planName: string; maxStaff: number } | null> => {
  const t = await getTenantRecord(tenantId);
  if (!t?.planKey) return null;
  const plan = await Plan.findOne({ key: t.planKey }).lean();
  return plan?.maxStaff ? { planName: plan.name, maxStaff: plan.maxStaff } : null;
};
