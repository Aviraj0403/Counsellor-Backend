import { describe, expect, it } from 'vitest';
import { rollUpHealth, teamStatus, unmetDependencies } from '../src/core/modules/workspace/domain/workspace.domain.js';

const cfg = (health: 'ok' | 'attention' | 'off') => ({ configured: health === 'ok', health, summary: 's', items: [] });

describe('workspace health roll-up', () => {
  it('no add-on on => off', () => {
    expect(rollUpHealth([{ key: 'leads', core: true, enabled: true, config: null }]).overall).toBe('off');
  });
  it('counts only enabled add-ons, and flags the ones needing attention', () => {
    const h = rollUpHealth([
      { key: 'leads', core: true, enabled: true, config: null },
      { key: 'whatsapp', core: false, enabled: true, config: cfg('attention') },
      { key: 'colleges', core: false, enabled: true, config: cfg('ok') },
      { key: 'seoPages', core: false, enabled: false, config: null },
    ]);
    expect(h).toEqual({ addOnsOn: 2, needsAttention: 1, attentionKeys: ['whatsapp'], overall: 'attention' });
  });
  it('all fine => ok', () => {
    expect(rollUpHealth([{ key: 'colleges', core: false, enabled: true, config: cfg('ok') }]).overall).toBe('ok');
  });
  it('a disabled module never counts as attention', () => {
    expect(rollUpHealth([{ key: 'whatsapp', core: false, enabled: false, config: cfg('attention') }]).needsAttention).toBe(0);
  });
});

describe('unmet dependencies', () => {
  it('lists the required modules that are off', () => {
    expect(unmetDependencies(['ledger', 'applications'], { ledger: true, applications: false })).toEqual(['applications']);
    expect(unmetDependencies(undefined, {})).toEqual([]);
  });
});

describe('team status', () => {
  it('no active staff => attention; above plan limit => attention; else ok', () => {
    expect(teamStatus(0, 1, null).health).toBe('attention');
    expect(teamStatus(5, 0, 3).health).toBe('attention');
    expect(teamStatus(2, 0, 3).health).toBe('ok');
  });
});
