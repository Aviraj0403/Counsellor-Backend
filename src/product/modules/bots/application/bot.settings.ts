import { env } from '../../../../config/env.js';
import type { Principal } from '../../../../contracts/port.js';
import { getPlatform } from '../../../../contracts/registry.js';
import { badRequest } from '../../../../shared/kernel/errors.js';
import { audit } from '../../audit/index.js';
import { DEFAULT_HANDOFF_KEYWORDS } from '../domain/bots.domain.js';
import { BotSettingsModel } from '../infrastructure/bots.model.js';
import { isLlmConfigured } from '../infrastructure/llm.js';
import { embedSnippet } from './bot.embed.js';

export interface BotSettings {
  orgSlug: string;
  enabled: boolean;
  name: string;
  greeting: string;
  languages: string[];
  handoffKeywords: string[];
  workingHoursNote: string;
  consentText: string;
  qualificationFields: string[];
  publicChannelEnabled: boolean;
  retentionDays: number;
  dailyMessageCap: number;
  monthlyBudgetPaise: number;
}

/** Settings with defaults filled in (no document yet = bot disabled with defaults). */
export const loadSettings = async (tenantId: string): Promise<BotSettings> => {
  const M = BotSettingsModel(tenantId);
  const doc = (await M.findOne({ key: 'default' }).lean<any>()) ?? new M({ key: 'default' }).toObject();
  return {
    orgSlug: doc.orgSlug ?? '',
    enabled: !!doc.enabled,
    name: doc.name,
    greeting: doc.greeting,
    languages: doc.languages ?? [],
    handoffKeywords: doc.handoffKeywords ?? [],
    workingHoursNote: doc.workingHoursNote ?? '',
    consentText: doc.consentText,
    qualificationFields: doc.qualificationFields ?? [],
    publicChannelEnabled: doc.publicChannelEnabled !== false,
    retentionDays: doc.retentionDays,
    dailyMessageCap: doc.dailyMessageCap,
    monthlyBudgetPaise: doc.monthlyBudgetPaise,
  };
};

/** Keywords that trigger hand-off: the organisation's own list plus the built-in defaults. */
export const effectiveKeywords = (s: BotSettings): string[] => [...new Set([...DEFAULT_HANDOFF_KEYWORDS, ...s.handoffKeywords].map((k) => k.trim().toLowerCase()).filter(Boolean))];

export const getSettingsView = async (p: Principal) => {
  const s = await loadSettings(p.tenantId!);
  return {
  ...s,
  publicUrl: s.orgSlug ? `${env.PUBLIC_BASE_URL.replace(/\/+$/, '')}/public/${s.orgSlug}/bot` : null,
  embedSnippet: s.orgSlug ? embedSnippet(s.orgSlug) : null,
  configured: isLlmConfigured(),
  model: env.AI_MODEL,
  defaultHandoffKeywords: DEFAULT_HANDOFF_KEYWORDS,
  };
};

export type SettingsPatch = Partial<Omit<BotSettings, never>>;

export const updateSettings = async (p: Principal, patch: SettingsPatch) => {
  const tenantId = p.tenantId!;
  const set: Record<string, unknown> = { ...patch };
  if (patch.orgSlug) {
    const t = await getPlatform().findTenantBySlug(patch.orgSlug.toLowerCase());
    if (!t || t.id !== tenantId) throw badRequest('That organisation address does not match your organisation. Ask your platform contact for the exact address.');
    set.orgSlug = patch.orgSlug.toLowerCase();
  }
  if (patch.handoffKeywords) {
    const list = [...new Set(patch.handoffKeywords.map((k) => k.trim().toLowerCase()).filter(Boolean))];
    if (list.length > 30) throw badRequest('Use at most 30 hand-off words.');
    if (list.some((k) => k.length > 40)) throw badRequest('Each hand-off word must be 40 characters or fewer.');
    set.handoffKeywords = list;
  }
  await BotSettingsModel(tenantId).updateOne({ key: 'default' }, { $set: set, $setOnInsert: { key: 'default' } }, { upsert: true });
  await audit(tenantId, { action: 'bot.settings_updated', entity: 'botSettings', meta: { fields: Object.keys(patch) } });
  return getSettingsView(p);
};
