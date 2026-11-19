import { env } from '../../../../config/env.js';
import type { ModuleConfigStatus } from '../../../../shared/kernel/configStatus.js';
import { BotSettingsModel, ConversationModel } from '../infrastructure/bots.model.js';
import { isLlmConfigured } from '../infrastructure/llm.js';

/** Counts only: no conversation text, visitor or lead detail. The AI key itself never leaves the server, only "is one set". */
export const configStatus = async (tenantId: string): Promise<ModuleConfigStatus> => {
  const [s, conversations] = await Promise.all([
    BotSettingsModel(tenantId).findOne({ key: 'default' }).select('enabled monthlyBudgetPaise dailyMessageCap').lean<{ enabled?: boolean; monthlyBudgetPaise?: number; dailyMessageCap?: number } | null>(),
    ConversationModel(tenantId).countDocuments({}),
  ]);
  const enabled = !!s?.enabled;
  const keySet = isLlmConfigured();
  const budget = s?.monthlyBudgetPaise ?? 50000;
  const items = [
    { label: 'Assistant switched on by the organisation', value: enabled },
    { label: 'AI key set on the server', value: keySet },
    { label: 'AI model', value: env.AI_MODEL },
    { label: 'Conversations (count only)', value: conversations },
    { label: 'Monthly budget', value: budget === 0 ? 'no limit' : `INR ${(budget / 100).toFixed(0)}` },
  ];
  if (!keySet) return { configured: false, health: 'attention', summary: 'The AI assistant is on but no AI key is set on the server, so it answers as offline.', items, nextStep: 'Add the AI key (ANTHROPIC_API_KEY) to the server settings.' };
  if (!enabled) return { configured: false, health: 'attention', summary: 'The AI key is set but the organisation has not switched their assistant on.', items, nextStep: 'Ask the organisation to enable the assistant in AI assistant > Settings.' };
  return { configured: true, health: 'ok', summary: `Assistant is live, ${conversations} conversation(s) so far.`, items };
};
