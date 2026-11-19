import { getPlatform } from '../../../../contracts/registry.js';
import { audit } from '../../audit/index.js';
import { badRequest } from '../../../../shared/kernel/errors.js';
import { env } from '../../../../config/env.js';
import { GraphError, graphGet, graphGetAll } from './meta.graph.js';
import { listOpenAlerts } from './meta.alerts.js';
import { loadConfig, tokenOf } from './meta.config.js';
import { spendAndLeads30d } from './meta.performance.js';

export const getStatus = async (tenantId: string) => {
  const c = await loadConfig(tenantId);
  return {
    connected: Boolean(c?.accessTokenEnc && c?.adAccountIds?.length),
    tokenSet: Boolean(c?.accessTokenEnc),
    tokenHint: c?.accessTokenEnc ? (c.tokenHint ?? '') : '',
    adAccountIds: (c?.adAccountIds ?? []) as string[],
    apiVersion: c?.apiVersion || env.META_GRAPH_VERSION,
    lastSyncAt: c?.lastSyncAt ?? null,
    lastSuccessAt: c?.lastSuccessAt ?? null,
    lastError: c?.lastError ?? null,
    lastErrorCode: c?.lastErrorCode ?? null,
    consecutiveFailures: c?.consecutiveFailures ?? 0,
    lastSyncRows: c?.lastSyncRows ?? 0,
    currency: c?.currency ?? null,
    currencyMismatch: Boolean(c?.currencyMismatch),
    alerts: await listOpenAlerts(tenantId),
  };
};

/** Asks Meta who the token belongs to (/me) and which ad accounts it can see (/me/adaccounts). Never returns the token. */
export const testConnection = async (tenantId: string) => {
  const c = await loadConfig(tenantId);
  if (!c?.accessTokenEnc) throw badRequest('Save the access token first.');
  const version: string = c.apiVersion || env.META_GRAPH_VERSION;
  let out: Record<string, unknown>;
  try {
    const token = tokenOf(c);
    const me = await graphGet('me', token, version, { fields: 'id,name' });
    const accounts = await graphGetAll('me/adaccounts', token, version, { fields: 'account_id,name,currency,account_status', limit: 200 }, 10);
    const visible = accounts.map((a) => ({ id: `act_${String(a.account_id ?? a.id ?? '').replace(/^act_/, '')}`, name: String(a.name ?? ''), currency: String(a.currency ?? ''), active: a.account_status === 1 }));
    const configured = ((c.adAccountIds ?? []) as string[]).map((id) => {
      const hit = visible.find((v) => v.id === id);
      return { id, found: Boolean(hit), name: hit?.name ?? '', currency: hit?.currency ?? '' };
    });
    const missing = configured.filter((x) => !x.found);
    const notInr = configured.filter((x) => x.found && x.currency && x.currency !== 'INR');
    const notes = [
      missing.length ? `The token cannot see ${missing.map((m) => m.id).join(', ')}. Give the system user access to that ad account.` : '',
      notInr.length ? `${notInr.map((m) => m.id).join(', ')} is not in INR: its spend is kept but left out of cost figures.` : '',
      !configured.length ? 'No ad account id is saved yet. Pick one from the list and save it.' : '',
    ].filter(Boolean);
    out = {
      ok: true,
      message: `Connected as ${me?.name ?? 'your Meta user'}. The token can see ${visible.length} ad account${visible.length === 1 ? '' : 's'}.${notes.length ? ' ' + notes.join(' ') : ''}`,
      me: { id: String(me?.id ?? ''), name: String(me?.name ?? '') },
      adAccounts: visible,
      configuredAccounts: configured,
      apiVersion: version,
    };
  } catch (e: any) {
    out = { ok: false, message: e instanceof GraphError ? e.message : 'The connection test failed.', code: e instanceof GraphError ? e.code : 'UNKNOWN' };
  }
  await audit(tenantId, { action: 'meta.connection_tested', entity: 'metaConfig', meta: { ok: out.ok, code: out.code } });
  return out;
};

/** Platform staff: one row per organisation that has metaAds on. Counts and money only, read through this module's own models. */
const CONCURRENCY = 5;
export const platformOverview = async () => {
  const tenants = (await getPlatform().listTenants()).filter((t) => t.status === 'active');
  const rows: Array<Record<string, unknown>> = [];
  for (let i = 0; i < tenants.length; i += CONCURRENCY) {
    const chunk = await Promise.all(
      tenants.slice(i, i + CONCURRENCY).map(async (t) => {
        if (!(await getPlatform().enabledModules(t.id))['metaAds']) return null;
        const [c, m] = await Promise.all([loadConfig(t.id), spendAndLeads30d(t.id)]);
        return {
          tenantId: t.id,
          name: t.name,
          connected: Boolean(c?.accessTokenEnc && c?.adAccountIds?.length),
          lastSyncAt: c?.lastSyncAt ?? null,
          lastError: c?.lastError ?? null,
          spend30dPaise: m.spendPaise,
          leads30d: m.leads,
        };
      }),
    );
    rows.push(...chunk.filter((x): x is NonNullable<typeof x> => x !== null));
  }
  return { organisations: rows.sort((a, b) => String(a.name).localeCompare(String(b.name))) };
};
