import { badRequest, notFound } from '../../../../shared/kernel/errors.js';
import { recordPlatformAudit } from '../../audit/index.js';
import { MODULE_BY_KEY, MODULE_CATALOG, resolveModules } from '../../catalog/index.js';
import { getTenantRecord, patchPriceOverrides, type TenantRecord } from '../../organisations/index.js';
import { computeCharge, type PlanLike } from '../domain/billing.domain.js';
import { Invoice } from '../infrastructure/invoice.model.js';
import { Plan } from '../infrastructure/plan.model.js';
import { shapeInvoice } from './invoice.shape.js';
import { shapePlan } from './plans.service.js';
import { getBillingDetails, getSettings } from './settings.service.js';

/** Negotiated monthly prices (in rupees) for one customer; 0 = free for them; null removes the override. */
export const setPriceOverrides = async (tenantId: string, overrides: Record<string, number | null>) => {
  const set: Record<string, number> = {};
  const unset: string[] = [];
  for (const [k, v] of Object.entries(overrides)) {
    const def = MODULE_BY_KEY.get(k as any);
    if (!def || def.core || !def.optIn) throw badRequest(`"${k}" is not a priced add-on module.`);
    if (v === null) unset.push(k);
    else set[k] = v;
  }
  const t = await patchPriceOverrides(tenantId, set, unset);
  await recordPlatformAudit({ action: 'tenant.pricing_changed', targetType: 'tenant', targetId: tenantId, tenantId, meta: { overrides } });
  return { priceOverrides: t.priceOverrides ?? {} };
};

/** Monthly charge (before GST is added on top) for one organisation from its current plan, modules and negotiated prices. */
export const monthlyChargeFor = (tenant: TenantRecord, plan: { name: string; basePricePaise: number; includedModules: string[] } | null | undefined) =>
  computeCharge({
    plan: plan ? { name: plan.name, basePricePaise: plan.basePricePaise, includedModules: plan.includedModules } : null,
    enabled: resolveModules(MODULE_CATALOG, tenant.modules ?? {}),
    catalog: MODULE_CATALOG,
    priceOverridesInr: tenant.priceOverrides ?? {},
  });

export const loadBillingContext = async (tenantId: string) => {
  const tenant = await getTenantRecord(tenantId);
  if (!tenant) throw notFound('Organisation');
  const plan = tenant.planKey ? await Plan.findOne({ key: tenant.planKey }).lean() : null;
  const planLike: PlanLike | null = plan ? { name: plan.name, basePricePaise: plan.basePricePaise, includedModules: plan.includedModules } : null;
  const [settings, details] = await Promise.all([getSettings(), getBillingDetails(tenantId)]);
  const charge = computeCharge({
    plan: planLike,
    enabled: resolveModules(MODULE_CATALOG, tenant.modules ?? {}),
    catalog: MODULE_CATALOG,
    priceOverridesInr: tenant.priceOverrides ?? {},
    gstRateBps: settings.gstRateBps,
    sellerState: settings.state,
    buyerState: details.state,
  });
  return { tenant, plan, charge, settings, details };
};

export const getBillingView = async (tenantId: string) => {
  const { tenant, plan, charge, details } = await loadBillingContext(tenantId);
  const invoices = await Invoice.find({ tenantId }).sort({ period: -1 }).limit(24).lean();
  return {
    plan: plan ? shapePlan(plan) : null,
    priceOverrides: tenant.priceOverrides ?? {},
    billingDetails: details,
    /** what would be billed for the current configuration (preview, not an invoice) */
    currentCharge: charge,
    invoices: invoices.map(shapeInvoice),
  };
};

/** Plan name and what the current set-up would cost per month (before GST), for the platform staff workspace. */
export const getPlanSummary = async (tenantId: string) => {
  const { plan, charge } = await loadBillingContext(tenantId);
  return { planKey: plan?.key ?? null, planName: plan?.name ?? null, maxStaff: plan?.maxStaff ?? null, monthlySubtotalPaise: charge.subtotalPaise };
};
