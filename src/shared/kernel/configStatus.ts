import { logger } from '../infra/logger.js';

/**
 * CONFIG STATUS: how the platform staff workspace learns "is this module set up for this organisation?" WITHOUT importing the modules
 * (same idea as hooks.ts). Each product module registers ONE small function at start-up (src/app/events.ts wires it); the workspace
 * endpoint only calls collectConfigStatus().
 *
 * HARD RULE: a status is CONFIGURATION and HEALTH only. Counts and yes/no facts, never a student, lead, application, document or ledger
 * value, never a phone number, e-mail, name, token, secret or URL. Platform staff must not see an organisation's personal data.
 */
export type ConfigHealth = 'ok' | 'attention' | 'off';

export interface ConfigItem {
  label: string;
  /** Short non-personal fact: a count, yes/no, a date, or a plain word. Never a secret. */
  value: string | number | boolean | null;
}

export interface ModuleConfigStatus {
  /** true = set up and usable, false = not set up yet, null = nothing to configure / not reported yet */
  configured: boolean | null;
  health: ConfigHealth;
  /** One plain-language line, for example "WhatsApp is on but no number is connected". */
  summary: string;
  items: ConfigItem[];
  /** For health "attention": what the admin should do next, in plain words. */
  nextStep?: string;
}

export type ConfigStatusFn = (tenantId: string) => Promise<ModuleConfigStatus>;

const registry = new Map<string, ConfigStatusFn>();

/** Registering the same key again replaces it (start-up can run more than once in tests). */
export const registerConfigStatus = (key: string, fn: ConfigStatusFn): void => {
  registry.set(key, fn);
};

export const clearConfigStatus = (): void => registry.clear();

/** Used when a module reports nothing: it has no setup of its own. */
export const NOTHING_TO_CONFIGURE: ModuleConfigStatus = { configured: null, health: 'ok', summary: 'Nothing to set up for this feature.', items: [] };

/** A module whose function throws is reported as "attention" with a neutral line (the error itself is logged, never sent out). */
export const collectConfigStatus = async (tenantId: string, enabledKeys: string[]): Promise<Record<string, ModuleConfigStatus>> => {
  const out: Record<string, ModuleConfigStatus> = {};
  await Promise.all(
    enabledKeys.map(async (key) => {
      const fn = registry.get(key);
      if (!fn) {
        out[key] = NOTHING_TO_CONFIGURE;
        return;
      }
      try {
        out[key] = await fn(tenantId);
      } catch (err) {
        logger.error({ err, module: key }, 'config status failed');
        out[key] = { configured: null, health: 'attention', summary: 'The setup status could not be read right now.', items: [], nextStep: 'Try again in a minute. If it keeps happening, check the server logs.' };
      }
    }),
  );
  return out;
};
