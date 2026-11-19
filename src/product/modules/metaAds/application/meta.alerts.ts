import { audit } from '../../audit/index.js';
import { addDays, computeAlerts, istDateString, istDayStart, ALERT_RULES } from '../domain/meta.insights.domain.js';
import { MetaAlertModel, MetaInsightDailyModel, MetaLeadLinkModel } from '../infrastructure/meta.model.js';
import { loadConfig } from './meta.config.js';

/**
 * Evaluates the alert rules for one organisation and stores them: a new condition creates ONE open alert (and one audit row, the
 * first time only); a condition that is still true keeps it; a condition that is gone closes it.
 */
export const evaluateAndPersistAlerts = async (tenantId: string, now: Date = new Date()) => {
  const cfg = await loadConfig(tenantId);
  if (!cfg) return [];
  const today = istDateString(now);
  const from = addDays(today, -(ALERT_RULES.NO_LEADS_WINDOW_DAYS - 1));
  const Insight = MetaInsightDailyModel(tenantId);
  const [todayRows, windowRows, platformLeads3d] = await Promise.all([
    Insight.find({ date: today, currencyMismatch: { $ne: true } }).lean<any[]>(),
    Insight.find({ date: { $gte: from, $lte: today } }).lean<any[]>(),
    MetaLeadLinkModel(tenantId).countDocuments({ at: { $gte: istDayStart(from), $lt: new Date(istDayStart(today).getTime() + 86_400_000) } }),
  ]);
  const conditions = computeAlerts({
    consecutiveFailures: cfg.consecutiveFailures ?? 0,
    lastErrorCode: cfg.lastErrorCode,
    lastError: cfg.lastError,
    spendTodayPaise: todayRows.reduce((s, r) => s + r.spend, 0),
    metaLeads3d: windowRows.reduce((s, r) => s + r.leads, 0),
    platformLeads3d,
  });
  const Alert = MetaAlertModel(tenantId);
  const open = await Alert.find({ clearedAt: null }).lean<any[]>();
  for (const c of conditions) {
    const existing = open.find((o) => o.code === c.code);
    if (existing) {
      await Alert.updateOne({ _id: existing._id }, { $set: { title: c.title, detail: c.detail, severity: c.severity } });
    } else {
      await Alert.create({ code: c.code, severity: c.severity, title: c.title, detail: c.detail });
      await audit(tenantId, { action: 'meta.alert_raised', entity: 'metaAlert', meta: { code: c.code, severity: c.severity } });
    }
  }
  for (const o of open) if (!conditions.some((c) => c.code === o.code)) await Alert.updateOne({ _id: o._id }, { $set: { clearedAt: new Date() } });
  return conditions;
};

export const listOpenAlerts = async (tenantId: string) =>
  (await MetaAlertModel(tenantId).find({ clearedAt: null }).sort({ raisedAt: -1 }).lean<any[]>()).map((a) => ({ code: a.code, severity: a.severity, title: a.title, detail: a.detail, raisedAt: a.raisedAt }));
