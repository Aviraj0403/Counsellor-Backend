import { getPlatform } from '../../../../contracts/registry.js';
import { env } from '../../../../config/env.js';
import { logger } from '../../../../shared/infra/logger.js';
import { audit } from '../../audit/index.js';
import { buildTimeRange, istDateString, parseInsightRow, type ParsedInsight, type SyncErrorCode } from '../domain/meta.insights.domain.js';
import { MetaConfigModel, MetaInsightDailyModel } from '../infrastructure/meta.model.js';
import { evaluateAndPersistAlerts } from './meta.alerts.js';
import { GraphError, graphGetAll } from './meta.graph.js';
import { loadConfig, tokenOf } from './meta.config.js';

export const INSIGHT_FIELDS = 'campaign_id,campaign_name,spend,impressions,reach,clicks,actions,date_start,account_currency';

export interface SyncResult {
  ok: boolean;
  days: number;
  rows: number;
  currency?: string;
  currencyMismatch?: boolean;
  error?: string;
  code?: SyncErrorCode;
}

/** Ready to sync: a saved token and at least one ad account. */
export const canSync = (c: any): boolean => Boolean(c?.accessTokenEnc && c?.adAccountIds?.length);

/**
 * Pulls one organisation's campaign insights (day by day). First run: 30 days; later runs: the last 3 days again (Meta restates
 * numbers). Upserts on (date, campaignId), so running it twice changes nothing. Never throws: the outcome is returned and stored
 * (lastSyncAt / lastError / consecutiveFailures), and alerts are re-evaluated.
 */
export const syncTenant = async (tenantId: string, opts: { days?: number; now?: Date } = {}): Promise<SyncResult> => {
  const now = opts.now ?? new Date();
  const Config = MetaConfigModel(tenantId);
  const cfg = await loadConfig(tenantId);
  const finish = async (r: SyncResult): Promise<SyncResult> => {
    const set: Record<string, unknown> = { lastSyncAt: now, lastSyncRows: r.rows };
    const inc: Record<string, number> = {};
    if (r.ok) {
      Object.assign(set, { lastSuccessAt: now, lastError: null, lastErrorCode: null, consecutiveFailures: 0, currency: r.currency, currencyMismatch: Boolean(r.currencyMismatch) });
    } else {
      Object.assign(set, { lastError: r.error, lastErrorCode: r.code });
      inc.consecutiveFailures = 1;
    }
    await Config.updateOne({ key: 'main' }, { $set: set, ...(r.ok ? {} : { $inc: inc }) });
    try {
      await evaluateAndPersistAlerts(tenantId, now);
    } catch (err) {
      logger.error({ err, tenantId }, 'meta alert evaluation failed');
    }
    return r;
  };

  if (!cfg?.accessTokenEnc) return finish({ ok: false, days: 0, rows: 0, code: 'NO_TOKEN', error: 'No access token is saved yet.' });
  if (!cfg.adAccountIds?.length) return finish({ ok: false, days: 0, rows: 0, code: 'NO_ACCOUNT', error: 'No ad account id is saved yet.' });

  const range = buildTimeRange(istDateString(now), Boolean(cfg.lastSuccessAt), opts.days);
  const version: string | undefined = cfg.apiVersion || env.META_GRAPH_VERSION;
  const parsed: ParsedInsight[] = [];
  let failure: { code: SyncErrorCode; message: string } | undefined;
  const token = tokenOf(cfg);
  for (const account of cfg.adAccountIds as string[]) {
    try {
      const rows = await graphGetAll(`${account}/insights`, token, version, {
        level: 'campaign',
        time_increment: 1,
        fields: INSIGHT_FIELDS,
        time_range: JSON.stringify({ since: range.since, until: range.until }),
        limit: 500,
      });
      for (const row of rows) {
        const p = parseInsightRow(row, account);
        if (p) parsed.push(p);
      }
    } catch (e: any) {
      const g = e instanceof GraphError ? e : new GraphError('META_ERROR', 'Unexpected error while reading from Meta.');
      failure = { code: g.code, message: (cfg.adAccountIds.length > 1 ? `${account}: ` : '') + g.message };
      if (g.code === 'TOKEN_INVALID') break; // every account would fail the same way
    }
  }

  if (parsed.length) {
    await MetaInsightDailyModel(tenantId).bulkWrite(
      parsed.map((p) => ({ updateOne: { filter: { date: p.date, campaignId: p.campaignId }, update: { $set: { ...p, syncedAt: now } }, upsert: true } })),
      { ordered: false },
    );
  }
  const base = { days: range.days, rows: parsed.length };
  if (failure) return finish({ ok: false, ...base, code: failure.code, error: failure.message });
  return finish({ ok: true, ...base, currency: parsed.find((p) => p.currency)?.currency ?? cfg.currency ?? 'INR', currencyMismatch: parsed.some((p) => p.currencyMismatch) });
};

/** Manual run from the screen (audited). */
export const syncNow = async (tenantId: string, days?: number): Promise<SyncResult> => {
  const r = await syncTenant(tenantId, { days });
  await audit(tenantId, { action: 'meta.sync_run', entity: 'metaConfig', meta: { trigger: 'manual', ok: r.ok, rows: r.rows, days: r.days, code: r.code } });
  return r;
};

/**
 * The cron job: every organisation that has metaAds switched on and a token + ad account. One organisation failing (or throwing)
 * never stops the others. Safe to run twice.
 */
export const runSyncAll = async (now: Date = new Date()) => {
  const out = { organisations: 0, synced: 0, failed: 0, skipped: 0, results: [] as Array<{ tenantId: string; ok: boolean; code?: string; rows?: number }> };
  const tenants = (await getPlatform().listTenants()).filter((t) => t.status === 'active');
  for (const t of tenants) {
    try {
      if (!(await getPlatform().enabledModules(t.id))['metaAds'] || !canSync(await loadConfig(t.id))) {
        out.skipped++;
        continue;
      }
      out.organisations++;
      const r = await syncTenant(t.id, { now });
      await audit(t.id, { action: 'meta.sync_run', entity: 'metaConfig', meta: { trigger: 'job', ok: r.ok, rows: r.rows, days: r.days, code: r.code } });
      r.ok ? out.synced++ : out.failed++;
      out.results.push({ tenantId: t.id, ok: r.ok, code: r.code, rows: r.rows });
    } catch (err) {
      out.failed++;
      out.results.push({ tenantId: t.id, ok: false, code: 'UNKNOWN' });
      logger.error({ err, tenantId: t.id }, 'meta sync failed for one organisation');
    }
  }
  return out;
};
