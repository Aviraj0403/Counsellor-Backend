import type { ModuleDef } from './moduleCatalog.js';

/**
 * Turns "what the superadmin switched" into "what is actually usable".
 *  - core modules are always on
 *  - optIn modules are on only when explicitly set to true
 *  - other modules are on unless explicitly set to false
 *  - a module whose dependency is off is forced off (so nothing half-works)
 * Pure function: easy to test, no database.
 */
export const resolveModules = (
  catalog: ModuleDef[],
  flags: Record<string, boolean | undefined>,
): Record<string, boolean> => {
  const on: Record<string, boolean> = {};
  for (const m of catalog) {
    on[m.key] = m.core ? true : m.optIn ? flags[m.key] === true : flags[m.key] !== false;
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const m of catalog) {
      if (on[m.key] && !m.core && m.dependsOn?.some((d) => !on[d])) {
        on[m.key] = false;
        changed = true;
      }
    }
  }
  return on;
};
