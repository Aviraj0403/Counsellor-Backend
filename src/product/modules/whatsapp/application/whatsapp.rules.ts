import type { Principal } from '../../../../contracts/port.js';
import { systemPrincipal } from '../../../../contracts/system.js';
import { logger } from '../../../../shared/infra/logger.js';
import { notFound } from '../../../../shared/kernel/errors.js';
import { subscribe } from '../../../../shared/kernel/events.js';
import { audit } from '../../audit/index.js';
import { resolveRuleParams, ruleMatches, type RuleEvent } from '../domain/whatsapp.domain.js';
import { RuleModel } from '../infrastructure/whatsapp.model.js';
import { resolveRecipient, sendMessage } from './whatsapp.service.js';

export interface RuleInput { event: RuleEvent; filter?: string; template: string; language?: string; params: string[]; delayMinutes: number; active?: boolean }

export const listRules = (tenantId: string) => RuleModel(tenantId).find().sort({ createdAt: -1 }).lean();

export const createRule = async (p: Principal, input: RuleInput) => {
  const r = await RuleModel(p.tenantId!).create(input);
  await audit(p.tenantId!, { action: 'whatsapp.rule_created', entity: 'whatsapp_rule', entityId: String(r._id), meta: { event: input.event, filter: input.filter, template: input.template } });
  return r.toObject();
};

export const updateRule = async (p: Principal, id: string, patch: Partial<RuleInput>) => {
  const r = await RuleModel(p.tenantId!).findByIdAndUpdate(id, { $set: patch }, { new: true }).lean<any>();
  if (!r) throw notFound('Rule');
  await audit(p.tenantId!, { action: 'whatsapp.rule_updated', entity: 'whatsapp_rule', entityId: id, meta: { fields: Object.keys(patch) } });
  return r;
};

export const deleteRule = async (p: Principal, id: string) => {
  const r = await RuleModel(p.tenantId!).findByIdAndDelete(id).lean<any>();
  if (!r) throw notFound('Rule');
  await audit(p.tenantId!, { action: 'whatsapp.rule_deleted', entity: 'whatsapp_rule', entityId: id });
  return { ok: true };
};

/** Runs every active rule that matches an event. A failing send is logged, never thrown into the publisher. */
export const runRules = async (tenantId: string, event: RuleEvent, value: string, ref: { leadId?: string; studentId?: string }, now = new Date()): Promise<number> => {
  const rules = (await RuleModel(tenantId).find({ event, active: true }).lean<any[]>()).filter((r) => ruleMatches(r, { event, value }));
  if (!rules.length) return 0;
  let fired = 0;
  for (const rule of rules) {
    try {
      const rec = await resolveRecipient(tenantId, ref);
      const params = resolveRuleParams(rule.params ?? [], rec.vars);
      const sendAt = rule.delayMinutes > 0 ? new Date(now.getTime() + rule.delayMinutes * 60_000) : undefined;
      await sendMessage(systemPrincipal(tenantId, 'whatsapp-automation'), { ...ref, template: rule.template, language: rule.language, params, sendAt }, now);
      fired++;
    } catch (err) {
      logger.warn({ err: (err as Error).message, ruleId: String(rule._id) }, 'whatsapp automation skipped');
    }
  }
  return fired;
};

/** Registered once at start-up from src/app/events.ts. */
export const registerEvents = (): void => {
  subscribe('lead.created', async (e) => void (await runRules(e.tenantId, 'lead.created', e.channel, { leadId: e.leadId })));
  subscribe('lead.stage_changed', async (e) => void (await runRules(e.tenantId, 'lead.stage_changed', e.to, { leadId: e.leadId })));
  subscribe('application.status_changed', async (e) => void (await runRules(e.tenantId, 'application.status_changed', e.to, { studentId: e.studentId })));
};
