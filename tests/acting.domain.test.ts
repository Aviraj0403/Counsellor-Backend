import { describe, expect, it } from 'vitest';
import { PERMISSIONS } from '../src/contracts/port.js';
import { ACTING_EXCLUDED_PERMISSIONS, ROLES, STAFF_ROLE_KEYS, TENANT_ROLE_KEYS, deriveActingPermissions, permissionsFor } from '../src/core/modules/catalog/domain/roles.js';
import { isValidBrandColor, isValidLogoUrl } from '../src/core/modules/organisations/domain/branding.js';

describe('acting permission set (platform staff inside an organisation)', () => {
  const acting = permissionsFor('platform_support');
  it('is the owner set minus the irreversible / export / money actions', () => {
    const owner = permissionsFor('owner');
    expect(acting.sort()).toEqual(owner.filter((p) => !ACTING_EXCLUDED_PERMISSIONS.includes(p)).sort());
    for (const p of ['team:manage', 'students:erase', 'documents:download', 'students:export', 'ledger:post', 'commissions:manage'] as const) {
      expect(acting).not.toContain(p);
      expect(owner).toContain(p);
    }
  });
  it('keeps the day-to-day admin access', () => {
    expect(acting).toEqual(expect.arrayContaining(['leads:read', 'leads:write', 'students:read', 'students:write', 'team:read', 'audit:read', 'integrations:manage']));
  });
  it('never contains platform or portal permissions, and only real permissions', () => {
    expect(acting.filter((p) => p.startsWith('platform:') || p.startsWith('portal:'))).toEqual([]);
    for (const p of acting) expect(PERMISSIONS).toContain(p);
    expect(deriveActingPermissions(['platform:tenants:manage', 'portal:student', 'leads:read', 'team:manage'])).toEqual(['leads:read']);
  });
  it('platform_support is a tenant-scope pseudo role: not assignable to staff, not a tenant role', () => {
    expect(ROLES.platform_support.scope).toBe('tenant');
    expect(STAFF_ROLE_KEYS).not.toContain('platform_support');
    expect(TENANT_ROLE_KEYS).not.toContain('platform_support');
  });
  it('only superadmin holds platform:tenants:impersonate', () => {
    for (const [k, def] of Object.entries(ROLES)) {
      const has = permissionsFor(k).includes('platform:tenants:impersonate');
      expect(has).toBe(k === 'superadmin');
      void def;
    }
  });
});

describe('organisation branding rules', () => {
  it('logo: https only, max 500, no credentials or spaces', () => {
    expect(isValidLogoUrl('https://cdn.example.com/logo.png')).toBe(true);
    expect(isValidLogoUrl('http://cdn.example.com/logo.png')).toBe(false);
    expect(isValidLogoUrl('javascript:alert(1)')).toBe(false);
    expect(isValidLogoUrl('https://user:pw@example.com/a.png')).toBe(false);
    expect(isValidLogoUrl('https://example.com/a b.png')).toBe(false);
    expect(isValidLogoUrl('https://example.com/' + 'a'.repeat(500))).toBe(false);
    expect(isValidLogoUrl('')).toBe(false);
  });
  it('colour: #rrggbb', () => {
    expect(isValidBrandColor('#1a2B3c')).toBe(true);
    expect(isValidBrandColor('#abc')).toBe(false);
    expect(isValidBrandColor('red')).toBe(false);
  });
});
