import type { ModuleConfigStatus } from '../../../../shared/kernel/configStatus.js';
import { ApiKeyModel, WebhookDeliveryModel, WebhookModel } from '../infrastructure/publicApi.model.js';

/** Counts only: never key prefixes, hashes, webhook URLs or secrets. */
export const configStatus = async (tenantId: string): Promise<ModuleConfigStatus> => {
  const [keys, webhooks, lastFailure] = await Promise.all([
    ApiKeyModel(tenantId).countDocuments({ revokedAt: { $exists: false } }),
    WebhookModel(tenantId).countDocuments({ active: true }),
    WebhookDeliveryModel(tenantId).findOne({ status: 'failed' }).sort({ at: -1 }).select('at').lean<{ at?: Date } | null>(),
  ]);
  const lastFailureAt = lastFailure?.at ? new Date(lastFailure.at).toISOString() : null;
  const items = [
    { label: 'Active API keys', value: keys },
    { label: 'Active webhooks', value: webhooks },
    { label: 'Last webhook delivery failure', value: lastFailureAt ?? 'none' },
  ];
  if (keys === 0 && webhooks === 0) return { configured: false, health: 'attention', summary: 'API & webhooks is on but no key or webhook has been created yet.', items, nextStep: 'Ask the organisation to create an API key (API & webhooks > Keys) or add a webhook.' };
  const recent = lastFailureAt !== null && Date.now() - new Date(lastFailureAt).getTime() < 7 * 24 * 3600 * 1000;
  if (recent) return { configured: true, health: 'attention', summary: 'A webhook delivery failed in the last 7 days.', items, nextStep: 'Ask the organisation to check that their webhook address is reachable.' };
  return { configured: true, health: 'ok', summary: `${keys} active key(s) and ${webhooks} active webhook(s).`, items };
};
