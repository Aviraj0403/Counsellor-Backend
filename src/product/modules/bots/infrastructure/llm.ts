import Anthropic from '@anthropic-ai/sdk';
import { env } from '../../../../config/env.js';

/**
 * The model behind a tiny interface so the rest of the module (and every test) never touches the network or the SDK.
 * Production: AnthropicLlmClient. Tests: setLlmClient(fake).
 */
export interface LlmToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}
export interface LlmMessage {
  role: 'user' | 'assistant';
  /** plain text, or Messages API content blocks (assistant tool_use blocks, user tool_result blocks) */
  content: string | unknown[];
}
export interface LlmToolCall {
  id: string;
  name: string;
  input: unknown;
}
export type LlmStopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal' | 'other';
export interface LlmResult {
  text: string;
  toolCalls: LlmToolCall[];
  usage: { inputTokens: number; outputTokens: number };
  stopReason: LlmStopReason;
  /** the assistant content blocks exactly as returned (kept so a tool loop can replay them, thinking blocks included) */
  rawContent?: unknown[];
}
export interface LlmRequest {
  system: string;
  messages: LlmMessage[];
  tools: readonly LlmToolDef[];
  maxTokens?: number;
  effort?: 'low' | 'medium';
}
export interface LlmClient {
  readonly model: string;
  complete(req: LlmRequest): Promise<LlmResult>;
}

const STOP: Record<string, LlmStopReason> = { end_turn: 'end_turn', stop_sequence: 'end_turn', tool_use: 'tool_use', max_tokens: 'max_tokens', refusal: 'refusal' };

/**
 * Claude API rules followed here: tool_choice auto (forced tool use is rejected by current models), no assistant prefill,
 * no temperature/top_p/top_k, adaptive thinking with output_config.effort, stop_reason is returned for the caller to check.
 * `fallbacks` is not sent: the installed SDK version does not type it.
 */
export class AnthropicLlmClient implements LlmClient {
  private readonly client: Anthropic;
  constructor(apiKey: string, readonly model: string) {
    this.client = new Anthropic({ apiKey, timeout: 40_000, maxRetries: 1 });
  }

  async complete(req: LlmRequest): Promise<LlmResult> {
    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: req.maxTokens ?? 2000,
      system: req.system,
      messages: req.messages,
      tools: req.tools,
      tool_choice: { type: 'auto' },
      thinking: { type: 'adaptive' },
      output_config: { effort: req.effort ?? 'low' },
    };
    const res = (await this.client.messages.create(body as never)) as unknown as {
      content: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>;
      stop_reason: string | null;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    const blocks = res.content ?? [];
    return {
      text: blocks.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n').trim(),
      toolCalls: blocks.filter((b) => b.type === 'tool_use').map((b) => ({ id: String(b.id), name: String(b.name), input: b.input })),
      usage: { inputTokens: res.usage?.input_tokens ?? 0, outputTokens: res.usage?.output_tokens ?? 0 },
      stopReason: STOP[res.stop_reason ?? ''] ?? 'other',
      rawContent: blocks,
    };
  }
}

let injected: LlmClient | null | undefined;
let built: AnthropicLlmClient | undefined;

/** Tests inject a fake (or null = "no key configured"). Call resetLlmClient() in afterEach/afterAll. */
export const setLlmClient = (c: LlmClient | null): void => {
  injected = c;
};
export const resetLlmClient = (): void => {
  injected = undefined;
  built = undefined;
};

/** The client to use, or null when no API key is configured (the bot then reports itself offline). */
export const getLlmClient = (): LlmClient | null => {
  if (injected !== undefined) return injected;
  if (!env.ANTHROPIC_API_KEY) return null;
  if (!built || built.model !== env.AI_MODEL) built = new AnthropicLlmClient(env.ANTHROPIC_API_KEY, env.AI_MODEL);
  return built;
};

export const isLlmConfigured = (): boolean => getLlmClient() !== null;
