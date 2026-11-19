import { MODULE_CATALOG, resolveModules } from '../../catalog/index.js';
import { listTenantRecords } from '../../organisations/index.js';
import { CostEntry } from '../infrastructure/cost.model.js';
import { Invoice } from '../infrastructure/invoice.model.js';
import { Plan } from '../infrastructure/plan.model.js';
import { monthlyChargeFor } from './billing.service.js';

/**
 * Super-admin financial and adoption overview. Reads ONLY master data (organisations, plans, invoices, costs):
 * no student or lead data ever leaves an organisation's database for this screen.
 * `activeStaffAccounts` is passed in by the composition root, so billing does not depend on the identity module.
 */
export const platformDashboard = async (month: string, activeStaffAccounts: number) => {
  const [tenants, plans, invoices, costs] = await Promise.all([
    listTenantRecords(),
    Plan.find().lean(),
    Invoice.find({ period: month, status: { $ne: 'void' } }).lean(),
    CostEntry.find({ month, voided: false }).lean(),
  ]);
  const planByKey = new Map(plans.map((p) => [p.key, p]));
  const active = tenants.filter((t) => t.status === 'active');

  // MRR = what active organisations would be billed per month right now (before GST)
  const perTenant = active.map((t) => {
    const id = String(t._id);
    const mrrPaise = monthlyChargeFor(t, t.planKey ? planByKey.get(t.planKey) : null).subtotalPaise;
    const costPaise = costs.filter((c) => c.tenantId === id).reduce((s, c) => s + c.amountPaise, 0);
    return { tenantId: id, name: t.name, mrrPaise, costPaise };
  });

  const adoption: Record<string, number> = {};
  for (const t of active) {
    const on = resolveModules(MODULE_CATALOG, t.modules ?? {});
    for (const m of MODULE_CATALOG) if (!m.core && on[m.key]) adoption[m.key] = (adoption[m.key] ?? 0) + 1;
  }

  const invoicedSubtotal = invoices.reduce((s, i) => s + i.subtotalPaise, 0);
  const collectedTotal = invoices.filter((i) => i.status === 'paid').reduce((s, i) => s + i.totalPaise, 0);
  const outstandingTotal = invoices.filter((i) => i.status === 'issued').reduce((s, i) => s + i.totalPaise, 0);
  const costTotal = costs.reduce((s, c) => s + c.amountPaise, 0);
  const byCategory: Record<string, number> = {};
  for (const c of costs) byCategory[c.category] = (byCategory[c.category] ?? 0) + c.amountPaise;
  const since = Date.now() - 30 * 86_400_000;

  return {
    month,
    organisations: {
      total: tenants.length,
      active: active.length,
      suspended: tenants.length - active.length,
      newLast30Days: tenants.filter((t) => new Date(t.createdAt).getTime() >= since).length,
      activeStaffAccounts,
    },
    revenue: {
      mrrPaise: perTenant.reduce((s, t) => s + t.mrrPaise, 0),
      invoicedPaise: invoicedSubtotal, // before GST
      collectedPaise: collectedTotal, // incl. GST, what has actually been received
      outstandingPaise: outstandingTotal, // incl. GST, issued but not paid yet
    },
    costs: { totalPaise: costTotal, byCategory },
    /** invoiced revenue (before GST) minus recorded costs for the month */
    marginPaise: invoicedSubtotal - costTotal,
    moduleAdoption: adoption,
    perOrganisation: perTenant.sort((a, b) => b.mrrPaise - a.mrrPaise),
  };
};
