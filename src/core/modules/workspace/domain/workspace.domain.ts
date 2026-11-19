import type { ConfigHealth, ModuleConfigStatus } from '../../../../shared/kernel/configStatus.js';

/** Pure rules behind the workspace screen. No database, no framework. */

/** Dependencies (module keys) that are not usable right now. */
export const unmetDependencies = (dependsOn: readonly string[] | undefined, effective: Record<string, boolean>): string[] => (dependsOn ?? []).filter((d) => !effective[d]);

export interface RollUpInput {
  key: string;
  core: boolean;
  enabled: boolean;
  config: ModuleConfigStatus | null;
}

export interface WorkspaceHealth {
  /** switched-on add-ons (core features are always on and not counted here) */
  addOnsOn: number;
  needsAttention: number;
  attentionKeys: string[];
  /** 'attention' if anything needs a look, 'ok' if at least one add-on is on and fine, 'off' when no add-on is on */
  overall: ConfigHealth;
}

export const rollUpHealth = (modules: RollUpInput[]): WorkspaceHealth => {
  const on = modules.filter((m) => m.enabled && !m.core);
  const attention = modules.filter((m) => m.enabled && m.config?.health === 'attention');
  return {
    addOnsOn: on.length,
    needsAttention: attention.length,
    attentionKeys: attention.map((m) => m.key),
    overall: attention.length ? 'attention' : on.length ? 'ok' : 'off',
  };
};

/** The staff-seat picture of an organisation as a health status (core "team" feature). */
export const teamStatus = (active: number, blocked: number, maxStaff: number | null): ModuleConfigStatus => {
  const items = [
    { label: 'Active staff', value: active },
    { label: 'Blocked staff', value: blocked },
    { label: 'Plan staff limit', value: maxStaff ?? 'no limit' },
  ];
  if (active === 0) return { configured: false, health: 'attention', summary: 'Nobody can log in: this organisation has no active staff account.', items, nextStep: 'Create or unblock an owner account for the organisation.' };
  if (maxStaff !== null && active > maxStaff) return { configured: true, health: 'attention', summary: `${active} active staff is above the plan limit of ${maxStaff}.`, items, nextStep: 'Move the organisation to a bigger plan or block unused accounts.' };
  return { configured: true, health: 'ok', summary: `${active} active staff.`, items };
};
