import type { ModuleConfigStatus } from '../../../../shared/kernel/configStatus.js';
import { MessageModel, RuleModel, TemplateModel } from '../infrastructure/whatsapp.model.js';
import { isConfigured } from './whatsapp.service.js';

const WEEK_MS = 7 * 24 * 3600 * 1000;

/** Setup and health for the platform staff workspace: counts and yes/no only. No numbers, tokens or message text. */
export const configStatus = async (tenantId: string): Promise<ModuleConfigStatus> => {
  const provider = isConfigured();
  const [templates, rules, failedLastWeek] = await Promise.all([
    TemplateModel(tenantId).countDocuments({ active: true }),
    RuleModel(tenantId).countDocuments({ active: true }),
    MessageModel(tenantId).countDocuments({ direction: 'out', status: 'failed', at: { $gte: new Date(Date.now() - WEEK_MS) } }),
  ]);
  const items = [
    { label: 'WhatsApp number connected on the platform', value: provider },
    { label: 'Active message templates', value: templates },
    { label: 'Active automation rules', value: rules },
    { label: 'Failed messages in the last 7 days', value: failedLastWeek },
  ];
  if (!provider) return { configured: false, health: 'attention', summary: 'WhatsApp is on but no number is connected on the platform.', items, nextStep: 'Add the WhatsApp credentials to the platform settings (server), then add a template for this organisation.' };
  if (templates === 0) return { configured: false, health: 'attention', summary: 'WhatsApp is connected but this organisation has no message template yet.', items, nextStep: 'Ask the organisation to add an approved template under WhatsApp > Templates.' };
  if (failedLastWeek > 0) return { configured: true, health: 'attention', summary: `${failedLastWeek} message(s) failed to send in the last 7 days.`, items, nextStep: 'Check that the template names match the approved templates at Meta.' };
  return { configured: true, health: 'ok', summary: `Connected, ${templates} template(s) and ${rules} automation rule(s).`, items };
};
