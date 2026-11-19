/** Pure rules of the Meta insights sync: parsing Graph rows, money, IST dates, sync window, alerts, performance maths. No database, no HTTP. */

// ---------- ad account id ----------
/** "123456" | "act_123456" -> "act_123456". null when it is not digits. */
export const normaliseAdAccountId = (v: unknown): string | null => {
  const s = String(v ?? '').trim().replace(/^act_/i, '');
  return /^\d{3,25}$/.test(s) ? `act_${s}` : null;
};

export const normaliseGraphVersion = (v: unknown): string | null => {
  const s = String(v ?? '').trim();
  return /^v\d{1,2}\.\d{1,2}$/.test(s) ? s : null;
};

/** Only the last 4 characters are ever shown, so a token cannot be rebuilt from its hint. */
export const maskToken = (token: string): string => `••••••••${token.slice(-4)}`;

// ---------- IST dates ----------
const IST_MS = 330 * 60_000; // India: UTC+05:30, no daylight saving
const DAY_MS = 86_400_000;

/** The IST calendar day (yyyy-mm-dd) containing this instant. */
export const istDateString = (d: Date): string => new Date(d.getTime() + IST_MS).toISOString().slice(0, 10);

export const isDateString = (s: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;

export const addDays = (date: string, n: number): string => new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

/** Midnight IST of a yyyy-mm-dd day, as a UTC instant. */
export const istDayStart = (date: string): Date => new Date(Date.parse(`${date}T00:00:00Z`) - IST_MS);

// ---------- sync window ----------
/** First sync pulls this many days; every later run re-pulls the last RESYNC_DAYS (Meta restates numbers inside its attribution window). */
export const BACKFILL_DAYS = 30;
export const RESYNC_DAYS = 3;
export const MAX_DAYS = 90;

export const buildTimeRange = (today: string, hasHistory: boolean, days?: number) => {
  const n = days && days > 0 ? Math.min(Math.floor(days), MAX_DAYS) : hasHistory ? RESYNC_DAYS : BACKFILL_DAYS;
  return { since: addDays(today, -(n - 1)), until: today, days: n };
};

// ---------- parsing ----------
/** Lead action types in priority order. They overlap (the first is a roll-up of the others), so the FIRST one present is used and they are never summed. */
export const LEAD_ACTIONS = ['lead', 'onsite_conversion.lead_grouped', 'offsite_conversion.fb_pixel_lead', 'leadgen_grouped'];

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

export const pickAction = (list: unknown, types: string[]): number => {
  if (!Array.isArray(list)) return 0;
  for (const t of types) {
    const hit = list.find((a) => a && a.action_type === t);
    if (hit) return Math.round(num(hit.value));
  }
  return 0;
};

/** Meta reports money as a decimal string in the account currency ("123.45"). Stored as integer minor units (paise for INR). */
export const toMinorUnits = (v: unknown): number => Math.round(num(v) * 100);

export interface ParsedInsight {
  date: string;
  campaignId: string;
  campaignName: string;
  accountId?: string;
  /** integer minor units of `currency` (paise when INR) */
  spend: number;
  currency: string;
  /** true when the account currency is not INR: the spend is kept but excluded from cost metrics */
  currencyMismatch: boolean;
  impressions: number;
  reach: number;
  clicks: number;
  leads: number;
}

export const parseInsightRow = (row: any, accountId?: string): ParsedInsight | null => {
  const campaignId = String(row?.campaign_id ?? '').trim();
  const date = String(row?.date_start ?? '').trim();
  if (!campaignId || !isDateString(date)) return null;
  const currency = String(row?.account_currency || 'INR').toUpperCase().slice(0, 3);
  return {
    date,
    campaignId,
    campaignName: String(row?.campaign_name ?? '').slice(0, 300),
    accountId,
    spend: toMinorUnits(row?.spend),
    currency,
    currencyMismatch: currency !== 'INR',
    impressions: Math.round(num(row?.impressions)),
    reach: Math.round(num(row?.reach)),
    clicks: Math.round(num(row?.clicks)),
    leads: pickAction(row?.actions, LEAD_ACTIONS),
  };
};

// ---------- Graph errors in plain language ----------
export type SyncErrorCode = 'TOKEN_INVALID' | 'PERMISSION' | 'RATE_LIMIT' | 'NETWORK' | 'META_ERROR' | 'NO_TOKEN' | 'NO_ACCOUNT';
const TOKEN_CODES = [190, 102];
const RATE_CODES = [4, 17, 32, 613];
const PERMISSION_CODES = [10, 200, 278];

export const classifyGraphError = (httpStatus: number, error: { code?: number; message?: string } | undefined): { code: SyncErrorCode; message: string } => {
  const c = Number(error?.code) || 0;
  if (TOKEN_CODES.includes(c)) return { code: 'TOKEN_INVALID', message: 'Meta says the access token is invalid or has expired (error 190). Create a new system-user token and save it here.' };
  if (PERMISSION_CODES.includes(c)) return { code: 'PERMISSION', message: 'The token does not have permission to read this ad account. Give the system user access to the ad account and the ads_read permission.' };
  if (RATE_CODES.includes(c) || httpStatus === 429) return { code: 'RATE_LIMIT', message: 'Meta is limiting how often we can ask (rate limit). It will be tried again on the next run.' };
  return { code: 'META_ERROR', message: `Meta returned an error${c ? ` ${c}` : httpStatus ? ` (HTTP ${httpStatus})` : ''}: ${String(error?.message ?? 'no details').slice(0, 200)}` };
};

// ---------- alerts ----------
export type MetaAlertCode = 'SYNC_FAILING' | 'TOKEN_INVALID' | 'SPEND_NO_LEADS';
export interface MetaAlert {
  code: MetaAlertCode;
  severity: 'warning' | 'critical';
  title: string;
  detail: string;
}

export const ALERT_RULES = { FAILING_RUNS: 2, NO_LEADS_WINDOW_DAYS: 3 } as const;

export interface AlertInputs {
  consecutiveFailures: number;
  lastErrorCode?: string | null;
  lastError?: string | null;
  /** today's (IST) spend, INR paise; currency-mismatch rows are not counted */
  spendTodayPaise: number;
  /** leads Meta reported over the last NO_LEADS_WINDOW_DAYS days (today included) */
  metaLeads3d: number;
  /** leads that arrived through the lead-ads webhook over the same window */
  platformLeads3d: number;
}

export const computeAlerts = (i: AlertInputs): MetaAlert[] => {
  const out: MetaAlert[] = [];
  if (i.lastErrorCode === 'TOKEN_INVALID' && i.consecutiveFailures > 0) {
    out.push({ code: 'TOKEN_INVALID', severity: 'critical', title: 'Meta access token is invalid or expired', detail: 'Meta rejected the saved token (error 190). Nothing can be synced until a new token is saved.' });
  }
  if (i.consecutiveFailures >= ALERT_RULES.FAILING_RUNS && i.lastErrorCode !== 'TOKEN_INVALID') {
    out.push({ code: 'SYNC_FAILING', severity: 'warning', title: `Meta sync has failed ${i.consecutiveFailures} times in a row`, detail: String(i.lastError ?? 'Unknown error').slice(0, 300) });
  }
  if (i.spendTodayPaise > 0 && i.metaLeads3d === 0 && i.platformLeads3d === 0) {
    out.push({ code: 'SPEND_NO_LEADS', severity: 'warning', title: 'Ads are spending but no leads in 3 days', detail: `Money was spent today and no lead was reported in the last ${ALERT_RULES.NO_LEADS_WINDOW_DAYS} days. Check the lead form, the ad and the audience.` });
  }
  return out;
};

// ---------- performance ----------
/** whole paise per lead, null when it cannot be computed */
export const costPerLead = (spendPaise: number, leads: number): number | null => (leads > 0 && spendPaise >= 0 ? Math.round(spendPaise / leads) : null);

export interface PerfRow {
  campaignId: string;
  campaignName: string;
  spend: number;
  impressions: number;
  clicks: number;
  metaLeads: number;
  platformLeads: number;
  currencyMismatch: boolean;
  /** spend in another currency (minor units), kept but never used for cost metrics */
  otherCurrencySpend: number;
  costPerLead: number | null;
  costPerPlatformLead: number | null;
}

export interface DailyRow { campaignId: string; campaignName?: string; spend: number; impressions: number; clicks: number; leads: number; currencyMismatch?: boolean }

/** Per-campaign performance from stored daily rows plus the count of platform leads linked to each campaign. */
export const buildPerformance = (daily: DailyRow[], platformLeadsByCampaign: Record<string, number>, names: Record<string, string> = {}) => {
  const map = new Map<string, PerfRow>();
  const get = (id: string, name?: string) => {
    let r = map.get(id);
    if (!r) {
      r = { campaignId: id, campaignName: name || names[id] || '', spend: 0, impressions: 0, clicks: 0, metaLeads: 0, platformLeads: 0, currencyMismatch: false, otherCurrencySpend: 0, costPerLead: null, costPerPlatformLead: null };
      map.set(id, r);
    }
    if (name) r.campaignName = name;
    return r;
  };
  for (const d of daily) {
    const r = get(d.campaignId, d.campaignName);
    r.impressions += d.impressions;
    r.clicks += d.clicks;
    r.metaLeads += d.leads;
    if (d.currencyMismatch) {
      r.currencyMismatch = true;
      r.otherCurrencySpend += d.spend;
    } else r.spend += d.spend;
  }
  for (const [id, n] of Object.entries(platformLeadsByCampaign)) get(id).platformLeads = n;
  const items = [...map.values()].map((r) => ({
    ...r,
    costPerLead: r.currencyMismatch ? null : costPerLead(r.spend, r.metaLeads),
    costPerPlatformLead: r.currencyMismatch ? null : costPerLead(r.spend, r.platformLeads),
  }));
  items.sort((a, b) => b.spend - a.spend || a.campaignId.localeCompare(b.campaignId));
  const sum = (k: 'spend' | 'impressions' | 'clicks' | 'metaLeads' | 'platformLeads') => items.reduce((s, r) => s + r[k], 0);
  const totals = {
    spend: sum('spend'),
    impressions: sum('impressions'),
    clicks: sum('clicks'),
    metaLeads: sum('metaLeads'),
    platformLeads: sum('platformLeads'),
    currencyMismatch: items.some((r) => r.currencyMismatch),
    costPerLead: null as number | null,
    costPerPlatformLead: null as number | null,
  };
  // cost metrics only over campaigns whose spend is INR
  const clean = items.filter((r) => !r.currencyMismatch);
  totals.costPerLead = costPerLead(clean.reduce((s, r) => s + r.spend, 0), clean.reduce((s, r) => s + r.metaLeads, 0));
  totals.costPerPlatformLead = costPerLead(clean.reduce((s, r) => s + r.spend, 0), clean.reduce((s, r) => s + r.platformLeads, 0));
  return { items, totals };
};
