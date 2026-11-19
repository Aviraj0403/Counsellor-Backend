import { registerConfigStatus, type ModuleConfigStatus } from '../../../../shared/kernel/configStatus.js';
import { loadConfig } from './meta.config.js';
import { listOpenAlerts } from './meta.alerts.js';

/** Setup and health only: yes/no facts, counts and dates. Never the token, token hint, ad account ids or campaign data. */
export const configStatus = async (tenantId: string): Promise<ModuleConfigStatus> => {
  const c = await loadConfig(tenantId);
  const tokenSet = Boolean(c?.accessTokenEnc);
  const accounts = (c?.adAccountIds ?? []).length;
  const alerts = (await listOpenAlerts(tenantId)).length;
  const items = [
    { label: 'Meta credential saved', value: tokenSet },
    { label: 'Ad accounts linked', value: accounts },
    { label: 'Last successful sync', value: c?.lastSuccessAt ? new Date(c.lastSuccessAt).toISOString().slice(0, 10) : null },
    { label: 'Open alerts', value: alerts },
  ];
  if (!tokenSet || !accounts) return { configured: false, health: 'attention', summary: 'Meta Ads is on but the connection is not finished (credential or ad account missing).', items, nextStep: 'Ask the organisation to open Meta Ads, save the Meta credential and ad account id, then press Test connection.' };
  if (alerts > 0 || (c?.consecutiveFailures ?? 0) >= 2) return { configured: true, health: 'attention', summary: `Meta Ads is connected but ${alerts || 'a'} sync problem${alerts === 1 ? '' : 's'} need attention.`, items, nextStep: 'Open the organisation\'s Meta Ads screen and read the alerts; an expired credential is the most common cause.' };
  return { configured: true, health: 'ok', summary: 'Meta Ads is connected and syncing.', items };
};

export const registerMetaConfigStatus = (): void => registerConfigStatus('metaAds', configStatus);
