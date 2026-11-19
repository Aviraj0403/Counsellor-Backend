import { logger } from '../infra/logger.js';

/**
 * HOOKS: the second way modules cooperate without importing each other (events are fire-and-forget; hooks ASK a question).
 *  - guards:       "may this happen?"  Every registered guard may answer with a reason to block. Used for business rules owned by
 *                  another module, for example `documents` blocking an application from being submitted while mandatory documents are missing.
 *  - contributors: "what do you hold about X?" Every registered contributor returns a named section. Used for DPDP data export.
 * The OWNER of the hook (the module that calls runGuards / collect) never needs to know who registered. Registration happens
 * once at start-up in src/app/events.ts, never at import time.
 */
export interface GuardHooks {
  'application.beforeStatusChange': { tenantId: string; applicationId: string; studentId: string; collegeId: string; courseId?: string; from: string; to: string };
}

export interface ContributorHooks {
  'student.export': { tenantId: string; studentId: string };
}

type Guard<K extends keyof GuardHooks> = (p: GuardHooks[K]) => Promise<string | null> | string | null;
type Contributor<K extends keyof ContributorHooks> = (p: ContributorHooks[K]) => Promise<{ section: string; data: unknown }> | { section: string; data: unknown };

const guards = new Map<string, Guard<any>[]>();
const contributors = new Map<string, Contributor<any>[]>();

export const registerGuard = <K extends keyof GuardHooks>(name: K, g: Guard<K>): void => {
  guards.set(name, [...(guards.get(name) ?? []), g]);
};
export const registerContributor = <K extends keyof ContributorHooks>(name: K, c: Contributor<K>): void => {
  contributors.set(name, [...(contributors.get(name) ?? []), c]);
};

/** Reasons (plain language) why the action must be blocked. Empty array = allowed. A guard that crashes does NOT block (it is logged). */
export const runGuards = async <K extends keyof GuardHooks>(name: K, payload: GuardHooks[K]): Promise<string[]> => {
  const reasons: string[] = [];
  for (const g of guards.get(name) ?? []) {
    try {
      const r = await g(payload);
      if (r) reasons.push(r);
    } catch (err) {
      logger.error({ err, hook: name }, 'guard failed');
    }
  }
  return reasons;
};

export const collectSections = async <K extends keyof ContributorHooks>(name: K, payload: ContributorHooks[K]): Promise<{ section: string; data: unknown }[]> => {
  const out: { section: string; data: unknown }[] = [];
  for (const c of contributors.get(name) ?? []) {
    try {
      out.push(await c(payload));
    } catch (err) {
      logger.error({ err, hook: name }, 'contributor failed');
      out.push({ section: 'error', data: 'A section could not be collected. Check the logs.' });
    }
  }
  return out;
};

export const clearHooks = (): void => {
  guards.clear();
  contributors.clear();
};
