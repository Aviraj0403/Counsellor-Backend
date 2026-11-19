import { describe, expect, it } from 'vitest';
import {
  ALERT_RULES,
  BACKFILL_DAYS,
  RESYNC_DAYS,
  addDays,
  buildPerformance,
  buildTimeRange,
  classifyGraphError,
  computeAlerts,
  costPerLead,
  istDateString,
  maskToken,
  normaliseAdAccountId,
  parseInsightRow,
  pickAction,
  toMinorUnits,
} from '../src/product/modules/metaAds/domain/meta.insights.domain.js';

describe('ad account id', () => {
  it('accepts digits with or without act_ and refuses the rest', () => {
    expect(normaliseAdAccountId('1234567890')).toBe('act_1234567890');
    expect(normaliseAdAccountId(' act_123456 ')).toBe('act_123456');
    expect(normaliseAdAccountId('abc')).toBeNull();
    expect(normaliseAdAccountId('12')).toBeNull();
    expect(normaliseAdAccountId('')).toBeNull();
  });
  it('shows only the last 4 characters of a token', () => {
    const t = 'EAAB-super-secret-access-token';
    expect(maskToken(t)).toBe('••••••••oken');
    expect(maskToken(t)).not.toContain('super');
  });
});

describe('actions (leads are never summed)', () => {
  const list = [
    { action_type: 'link_click', value: '40' },
    { action_type: 'onsite_conversion.lead_grouped', value: '4' },
    { action_type: 'lead', value: '5' },
    { action_type: 'offsite_conversion.fb_pixel_lead', value: '3' },
  ];
  it('uses the first action type present in priority order', () => {
    expect(pickAction(list, ['lead', 'onsite_conversion.lead_grouped'])).toBe(5);
    expect(pickAction(list.filter((a) => a.action_type !== 'lead'), ['lead', 'onsite_conversion.lead_grouped', 'offsite_conversion.fb_pixel_lead'])).toBe(4);
  });
  it('is 0 for missing or odd input', () => {
    expect(pickAction(undefined, ['lead'])).toBe(0);
    expect(pickAction([{ action_type: 'lead', value: 'x' }], ['lead'])).toBe(0);
    expect(pickAction([], ['lead'])).toBe(0);
  });
});

describe('parsing a Graph insights row', () => {
  const row = { campaign_id: '111', campaign_name: 'Admissions Nov', date_start: '2026-11-18', spend: '1234.56', impressions: '10000', reach: '8000', clicks: '250', account_currency: 'INR', actions: [{ action_type: 'lead', value: '12' }, { action_type: 'onsite_conversion.lead_grouped', value: '10' }] };
  it('turns money into integer paise and picks the lead count', () => {
    expect(parseInsightRow(row, 'act_9')).toEqual({ date: '2026-11-18', campaignId: '111', campaignName: 'Admissions Nov', accountId: 'act_9', spend: 123456, currency: 'INR', currencyMismatch: false, impressions: 10000, reach: 8000, clicks: 250, leads: 12 });
  });
  it('has no floating point drift in paise', () => {
    expect(toMinorUnits('12.35')).toBe(1235);
    expect(toMinorUnits('0.29')).toBe(29);
    expect(toMinorUnits('19.99')).toBe(1999);
    expect(toMinorUnits(undefined)).toBe(0);
  });
  it('flags a currency that is not INR but keeps the spend in minor units', () => {
    const p = parseInsightRow({ ...row, account_currency: 'usd', spend: '10.50' })!;
    expect(p.currencyMismatch).toBe(true);
    expect(p.currency).toBe('USD');
    expect(p.spend).toBe(1050);
  });
  it('skips rows without a campaign or with a bad date', () => {
    expect(parseInsightRow({ ...row, campaign_id: '' })).toBeNull();
    expect(parseInsightRow({ ...row, date_start: '18-11-2026' })).toBeNull();
    expect(parseInsightRow({ ...row, date_start: '2026-02-31' })).toBeNull();
  });
});

describe('IST dates and the sync window', () => {
  it('uses the IST calendar day (UTC+05:30)', () => {
    expect(istDateString(new Date('2026-11-18T18:29:00Z'))).toBe('2026-11-18');
    expect(istDateString(new Date('2026-11-18T18:31:00Z'))).toBe('2026-11-19');
  });
  it('adds days across month and year ends', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });
  it('first sync backfills 30 days, later runs re-pull the last 3', () => {
    expect(BACKFILL_DAYS).toBe(30);
    expect(RESYNC_DAYS).toBe(3);
    expect(buildTimeRange('2026-11-30', false)).toEqual({ since: '2026-11-01', until: '2026-11-30', days: 30 });
    expect(buildTimeRange('2026-11-30', true)).toEqual({ since: '2026-11-28', until: '2026-11-30', days: 3 });
  });
  it('an explicit window wins but is capped at 90 days', () => {
    expect(buildTimeRange('2026-11-30', true, 7).days).toBe(7);
    expect(buildTimeRange('2026-11-30', true, 500).days).toBe(90);
  });
});

describe('Graph errors in plain language', () => {
  it('error 190 means the token is invalid', () => {
    const c = classifyGraphError(400, { code: 190, message: 'Error validating access token' });
    expect(c.code).toBe('TOKEN_INVALID');
    expect(c.message).toContain('token');
  });
  it('classifies rate limit, permission and the rest', () => {
    expect(classifyGraphError(400, { code: 17 }).code).toBe('RATE_LIMIT');
    expect(classifyGraphError(429, undefined).code).toBe('RATE_LIMIT');
    expect(classifyGraphError(403, { code: 200 }).code).toBe('PERMISSION');
    expect(classifyGraphError(500, { code: 1, message: 'boom' })).toMatchObject({ code: 'META_ERROR' });
  });
});

describe('alerts', () => {
  const calm = { consecutiveFailures: 0, spendTodayPaise: 0, metaLeads3d: 5, platformLeads3d: 0 };
  it('raises nothing when all is well', () => {
    expect(computeAlerts(calm)).toEqual([]);
  });
  it('sync failing only from the 2nd failed run in a row', () => {
    expect(computeAlerts({ ...calm, consecutiveFailures: 1, lastError: 'x' })).toEqual([]);
    const a = computeAlerts({ ...calm, consecutiveFailures: ALERT_RULES.FAILING_RUNS, lastError: 'Meta returned an error', lastErrorCode: 'META_ERROR' });
    expect(a.map((x) => x.code)).toEqual(['SYNC_FAILING']);
    expect(a[0]!.detail).toContain('Meta returned an error');
  });
  it('an invalid token alerts at once (critical) and replaces the generic failing alert', () => {
    const a = computeAlerts({ ...calm, consecutiveFailures: 3, lastErrorCode: 'TOKEN_INVALID', lastError: 'x' });
    expect(a.map((x) => x.code)).toEqual(['TOKEN_INVALID']);
    expect(a[0]!.severity).toBe('critical');
    expect(computeAlerts({ ...calm, consecutiveFailures: 1, lastErrorCode: 'TOKEN_INVALID' }).map((x) => x.code)).toEqual(['TOKEN_INVALID']);
  });
  it('spend today with no leads in 3 days; leads from either source calm it', () => {
    expect(computeAlerts({ ...calm, spendTodayPaise: 50000, metaLeads3d: 0 }).map((x) => x.code)).toEqual(['SPEND_NO_LEADS']);
    expect(computeAlerts({ ...calm, spendTodayPaise: 50000, metaLeads3d: 0, platformLeads3d: 1 })).toEqual([]);
    expect(computeAlerts({ ...calm, spendTodayPaise: 0, metaLeads3d: 0 })).toEqual([]);
  });
});

describe('performance', () => {
  it('cost per lead is whole paise, null without leads', () => {
    expect(costPerLead(100000, 3)).toBe(33333);
    expect(costPerLead(100000, 0)).toBeNull();
  });
  it('groups by campaign, adds platform leads, totals and cost per lead', () => {
    const r = buildPerformance(
      [
        { campaignId: 'A', campaignName: 'Alpha', spend: 100000, impressions: 1000, clicks: 50, leads: 4 },
        { campaignId: 'A', campaignName: 'Alpha', spend: 50000, impressions: 500, clicks: 25, leads: 1 },
        { campaignId: 'B', spend: 20000, impressions: 100, clicks: 5, leads: 0 },
      ],
      { A: 3, C: 2 },
      { C: 'Gamma' },
    );
    expect(r.items.map((i) => i.campaignId)).toEqual(['A', 'B', 'C']);
    const a = r.items[0]!;
    expect(a).toMatchObject({ spend: 150000, impressions: 1500, clicks: 75, metaLeads: 5, platformLeads: 3, costPerLead: 30000, costPerPlatformLead: 50000 });
    expect(r.items[1]!.costPerLead).toBeNull();
    expect(r.items[2]).toMatchObject({ campaignName: 'Gamma', platformLeads: 2, spend: 0 });
    expect(r.totals).toMatchObject({ spend: 170000, impressions: 1600, clicks: 80, metaLeads: 5, platformLeads: 5, costPerLead: 34000, currencyMismatch: false });
  });
  it('a non-INR campaign is flagged and left out of spend and cost figures', () => {
    const r = buildPerformance(
      [
        { campaignId: 'A', spend: 100000, impressions: 10, clicks: 1, leads: 2 },
        { campaignId: 'U', spend: 5000, impressions: 10, clicks: 1, leads: 5, currencyMismatch: true },
      ],
      {},
    );
    const u = r.items.find((i) => i.campaignId === 'U')!;
    expect(u).toMatchObject({ currencyMismatch: true, spend: 0, otherCurrencySpend: 5000, costPerLead: null });
    expect(r.totals).toMatchObject({ spend: 100000, currencyMismatch: true, costPerLead: 50000 });
  });
});
