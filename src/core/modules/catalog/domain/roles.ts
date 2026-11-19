import { PERMISSIONS, PORTAL_ROLES, type Permission, type Scope } from '../../../../contracts/port.js';

export interface RoleDef {
  label: string;
  scope: Scope;
  /** Plain-language description shown in the admin "Roles" screen. */
  description: string;
  permissions: Permission[] | '*';
  /** portal roles: invited, never take a staff seat, only see their own slice of data */
  portal?: boolean;
}

/**
 * ROLE MATRIX. A role is only a named bundle of permissions; nothing else in the code checks role names.
 * Platform roles belong to our own company staff. Tenant roles belong to a counsellor organisation.
 * Portal roles (student, college_user) belong to people OUTSIDE the organisation who log in to see their own application.
 */
export const ROLES = {
  // ---- our own company ----
  superadmin: { label: 'Super Admin', scope: 'platform', description: 'Owns the whole platform: organisations, modules, pricing and costs.', permissions: '*' },
  platform_ops: { label: 'Platform Operations', scope: 'platform', description: 'Internal admissions team: manages organisations, switches modules on/off and reads the platform audit and usage research.', permissions: ['platform:tenants:manage', 'platform:modules:manage', 'platform:audit:read', 'platform:insights:read'] },
  platform_finance: { label: 'Platform Finance', scope: 'platform', description: 'Internal finance team: plans, pricing, invoices, platform costs, financial dashboard, company details and research.', permissions: ['platform:audit:read', 'platform:billing:manage', 'platform:costs:manage', 'platform:insights:read', 'platform:settings:manage'] },
  platform_ads: { label: 'Platform Ads Team', scope: 'platform', description: 'Runs ad campaigns for organisations that bought the Meta Ads module.', permissions: [] },
  // ---- a counsellor organisation ----
  owner: {
    label: 'Owner',
    scope: 'tenant',
    description: 'Full control of the organisation: team, leads, students, applications, documents, ledgers, integrations and audit trail.',
    permissions: [
      'leads:read', 'leads:write', 'leads:assign', 'leads:import', 'followups:read', 'followups:write',
      'students:read', 'students:write', 'students:export', 'students:erase', 'colleges:read', 'colleges:write',
      'applications:read', 'applications:write', 'applications:status',
      'documents:read', 'documents:write', 'documents:verify', 'documents:download',
      'commissions:read', 'commissions:manage', 'ledger:read', 'ledger:post', 'reports:read',
      'integrations:manage', 'seo:manage', 'whatsapp:send', 'audit:read', 'team:read', 'team:manage',
    ],
  },
  counsellor: {
    label: 'Counsellor',
    scope: 'tenant',
    description: 'Works on the leads, students and applications assigned to them.',
    permissions: ['leads:read', 'leads:write', 'followups:read', 'followups:write', 'students:read', 'students:write', 'colleges:read', 'applications:read', 'applications:write', 'applications:status', 'documents:read', 'documents:write', 'documents:download', 'whatsapp:send'],
  },
  sales: { label: 'Sales team', scope: 'tenant', description: 'Handles new enquiries, assigns and imports leads, follows up.', permissions: ['leads:read', 'leads:write', 'leads:assign', 'leads:import', 'followups:read', 'followups:write', 'students:read', 'colleges:read', 'whatsapp:send'] },
  marketing: { label: 'Marketing team', scope: 'tenant', description: 'Brings in leads (imports, campaigns, SEO pages) and reads reports. Cannot edit student progress.', permissions: ['leads:read', 'leads:import', 'reports:read', 'seo:manage', 'colleges:read'] },
  support: { label: 'Support team', scope: 'tenant', description: 'Reaches out to students, follows up and updates lead progress.', permissions: ['leads:read', 'leads:write', 'followups:read', 'followups:write', 'students:read', 'applications:read', 'documents:read', 'colleges:read', 'whatsapp:send'] },
  accounts: { label: 'Accounts', scope: 'tenant', description: 'Posts and reads ledger entries, manages commission payouts. Read-only on leads and applications.', permissions: ['leads:read', 'applications:read', 'colleges:read', 'ledger:read', 'ledger:post', 'commissions:read', 'commissions:manage', 'reports:read'] },
  admissions: {
    label: 'Admissions team',
    scope: 'tenant',
    description: 'Internal admissions desk: colleges, applications and their status, and verification of admission documents.',
    permissions: ['students:read', 'students:write', 'colleges:read', 'colleges:write', 'applications:read', 'applications:write', 'applications:status', 'documents:read', 'documents:write', 'documents:verify', 'documents:download', 'followups:read', 'followups:write', 'leads:read'],
  },
  // ---- portal people (outside the organisation) ----
  student: { label: 'Student', scope: 'tenant', portal: true, description: 'Sees only their own application status and uploads their own documents.', permissions: ['portal:student'] },
  college_user: { label: 'College user', scope: 'tenant', portal: true, description: 'A college employee: sees and updates the status of applications sent to their college only.', permissions: ['portal:college'] },
} satisfies Record<string, RoleDef>;

export type RoleKey = keyof typeof ROLES;
export const ROLE_KEYS = Object.keys(ROLES) as RoleKey[];
export const TENANT_ROLE_KEYS = ROLE_KEYS.filter((k) => ROLES[k].scope === 'tenant');
export const PLATFORM_ROLE_KEYS = ROLE_KEYS.filter((k) => ROLES[k].scope === 'platform');
/** Roles an owner may hand out to STAFF. Not "owner" (created with the organisation) and not portal roles (invitation only). */
export const STAFF_ROLE_KEYS = TENANT_ROLE_KEYS.filter((k) => k !== 'owner' && !('portal' in ROLES[k]));
export const PORTAL_ROLE_KEYS: readonly string[] = PORTAL_ROLES;

export const isRoleKey = (r: string): r is RoleKey => r in ROLES;

export const permissionsFor = (role: string): Permission[] => {
  if (!isRoleKey(role)) return [];
  const def: RoleDef = ROLES[role];
  return def.permissions === '*' ? [...PERMISSIONS] : [...def.permissions];
};
