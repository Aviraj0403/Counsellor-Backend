import { describe, expect, it } from 'vitest';
import { MODULE_CATALOG } from '../src/core/modules/catalog/domain/moduleCatalog.js';
import { resolveModules } from '../src/core/modules/catalog/domain/resolve.js';
import { ROLES, STAFF_ROLE_KEYS, TENANT_ROLE_KEYS, permissionsFor } from '../src/core/modules/catalog/domain/roles.js';
import { MODULE_KEYS, PERMISSIONS } from '../src/contracts/port.js';

describe('module catalogue', () => {
  it('has exactly one entry per module key', () => {
    expect(MODULE_CATALOG.map((m) => m.key).sort()).toEqual([...MODULE_KEYS].sort());
  });
  it('only depends on modules that exist, and core modules depend on nothing optional', () => {
    for (const m of MODULE_CATALOG) {
      for (const d of m.dependsOn ?? []) expect(MODULE_KEYS).toContain(d);
      if (m.core) expect(m.dependsOn ?? []).toEqual([]);
    }
  });
});

describe('resolveModules', () => {
  it('core is always on, opt-in is off by default', () => {
    const on = resolveModules(MODULE_CATALOG, {});
    expect(on.leads).toBe(true);
    expect(on.team).toBe(true);
    expect(on.ledger).toBe(false);
  });
  it('core cannot be switched off', () => {
    expect(resolveModules(MODULE_CATALOG, { leads: false }).leads).toBe(true);
  });
  it('opt-in turns on only when explicitly true', () => {
    expect(resolveModules(MODULE_CATALOG, { ledger: true }).ledger).toBe(true);
  });
  it('a module whose dependency is off stays off (chain)', () => {
    // applications needs students AND colleges
    expect(resolveModules(MODULE_CATALOG, { applications: true }).applications).toBe(false);
    const on = resolveModules(MODULE_CATALOG, { students: true, colleges: true, applications: true, studentPortal: true });
    expect(on.applications).toBe(true);
    expect(on.studentPortal).toBe(true);
    const broken = resolveModules(MODULE_CATALOG, { students: true, applications: true, studentPortal: true });
    expect(broken.applications).toBe(false);
    expect(broken.studentPortal).toBe(false);
  });
});

describe('role matrix', () => {
  it('every permission a role grants is a real permission', () => {
    for (const r of Object.values(ROLES)) {
      if (r.permissions === '*') continue;
      for (const p of r.permissions) expect(PERMISSIONS).toContain(p);
    }
  });
  it('organisation roles never get platform permissions', () => {
    for (const k of TENANT_ROLE_KEYS) {
      expect(permissionsFor(k).filter((p) => p.startsWith('platform:'))).toEqual([]);
    }
  });
  it('superadmin gets everything; unknown roles get nothing', () => {
    expect(permissionsFor('superadmin')).toEqual([...PERMISSIONS]);
    expect(permissionsFor('hacker')).toEqual([]);
  });
  it('money screens are finance-only: ops can do research but not billing or costs', () => {
    expect(permissionsFor('platform_finance')).toEqual(expect.arrayContaining(['platform:billing:manage', 'platform:costs:manage']));
    expect(permissionsFor('platform_ops')).not.toContain('platform:billing:manage');
    expect(permissionsFor('platform_ops')).not.toContain('platform:costs:manage');
    expect(permissionsFor('platform_ops')).toContain('platform:insights:read');
  });
  it('staff roles never include owner; platform ops can switch modules', () => {
    expect(STAFF_ROLE_KEYS).not.toContain('owner');
    expect(STAFF_ROLE_KEYS).not.toContain('student');
    expect(STAFF_ROLE_KEYS).not.toContain('college_user');
    expect(STAFF_ROLE_KEYS.length).toBe(TENANT_ROLE_KEYS.length - 1 - 2); // minus owner and the two portal roles
    expect(permissionsFor('platform_ops')).toContain('platform:modules:manage');
  });
  it('portal roles can only use their own portal and nothing else', () => {
    expect(permissionsFor('student')).toEqual(['portal:student']);
    expect(permissionsFor('college_user')).toEqual(['portal:college']);
  });
  it('staff roles never get portal permissions', () => {
    for (const k of STAFF_ROLE_KEYS) expect(permissionsFor(k).filter((p) => p.startsWith('portal:'))).toEqual([]);
  });
  it('marketing cannot edit student progress; accounts cannot edit leads', () => {
    expect(permissionsFor('marketing')).not.toContain('leads:write');
    expect(permissionsFor('accounts')).not.toContain('leads:write');
    expect(permissionsFor('counsellor')).not.toContain('ledger:post');
  });
});
