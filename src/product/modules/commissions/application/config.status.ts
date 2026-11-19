import type { ModuleConfigStatus } from '../../../../shared/kernel/configStatus.js';
import { CommissionRuleModel } from '../infrastructure/commission.model.js';

/** Rule counts only: no amounts, payouts or ledger values. */
export const configStatus = async (tenantId: string): Promise<ModuleConfigStatus> => {
  const rules = await CommissionRuleModel(tenantId).countDocuments({ active: true });
  const items = [{ label: 'Active commission rules', value: rules }];
  if (rules === 0) return { configured: false, health: 'attention', summary: 'Commissions is on but no commission rule exists, so nothing will accrue.', items, nextStep: 'Ask the organisation to set a commission rule for each college.' };
  return { configured: true, health: 'ok', summary: `${rules} commission rule(s) active.`, items };
};
