/**
 * PLATFORM CONTRACT
 * -----------------
 * Everything the counselling product needs from the shared Platform Core (login, tenants, modules, team).
 * The product code (src/product) may ONLY talk to the core through this file.
 * Today it is served by src/core (same repo). Later the same contract can be served by a separate
 * core service over HTTP, with zero change to product code. See docs/adr/0002-platform-port.md.
 */

/** Every action a user can be allowed to do. Roles are just named bundles of these. */
export const PERMISSIONS = [
  // ---- counsellor-organisation side
  'leads:read',
  'leads:write',
  'leads:assign',
  'leads:import',
  'followups:read',
  'followups:write',
  'students:read',
  'students:write',
  'students:export', // DPDP: give a student (or parent) a copy of their data
  'students:erase', // DPDP: erase / anonymise a student on request
  'colleges:read',
  'colleges:write',
  'applications:read',
  'applications:write',
  'applications:status', // move an application to its next status
  'documents:read', // see the checklist and file names
  'documents:write', // upload
  'documents:verify', // verify / reject
  'documents:download', // open the actual file (every download is audited)
  'commissions:read',
  'commissions:manage', // commission rules, payouts
  'ledger:read',
  'ledger:post',
  'reports:read',
  'integrations:manage', // API keys, webhooks, Meta / WhatsApp settings
  'seo:manage',
  'whatsapp:send',
  'appointments:read',
  'appointments:write', // book, reschedule, cancel, mark no-show
  'appointments:manage', // appointment types, working hours, leave, policies
  'bots:read', // read bot conversations and handoffs
  'bots:manage', // bot settings, knowledge, channels
  'audit:read',
  'team:read',
  'team:manage',
  // ---- portal users (a student, or a college employee, logging in to see their own slice)
  'portal:student',
  'portal:college',
  // ---- platform (our own company) side
  'platform:tenants:manage',
  'platform:modules:manage',
  'platform:audit:read',
  'platform:billing:manage', // plans, pricing, invoices, financial dashboard
  'platform:costs:manage', // record platform running costs
  'platform:insights:read', // aggregated usage and conversion research (never student-level data)
  'platform:settings:manage', // our company details used on invoices (legal name, GSTIN, address)
  'platform:domains:manage', // which websites may call this API (CORS whitelist)
  'platform:tenants:impersonate', // act inside an organisation (superadmin only; audited, see docs/adr/0004)
] as const;
export type Permission = (typeof PERMISSIONS)[number];

/** Every sellable / switchable feature. Add new keys here first, then in core/modules/catalog/domain/moduleCatalog.ts. */
export const MODULE_KEYS = [
  'leads',
  'team',
  'followups',
  'ledger',
  'students',
  'colleges',
  'applications',
  'documents',
  'commissions',
  'reports',
  'whatsapp',
  'metaAds',
  'seoPages',
  'publicApi',
  'studentPortal',
  'collegePortal',
  'appointments',
  'aiBot',
] as const;
export type ModuleKey = (typeof MODULE_KEYS)[number];

export type Scope = 'platform' | 'tenant';

/** Roles for people OUTSIDE the organisation's staff. They never take a staff seat and are created by invitation only. */
export const PORTAL_ROLES = ['student', 'college_user'] as const;
export type PortalRole = (typeof PORTAL_ROLES)[number];

/** The logged-in person, as the product sees them. */
export interface Principal {
  userId: string;
  email: string;
  name: string;
  role: string;
  scope: Scope;
  /** null for platform (our own staff) users */
  tenantId: string | null;
  permissions: Permission[];
  /** portal users only: the student id (role "student") or college id (role "college_user") they are tied to */
  linkedId?: string | null;
  /**
   * Set ONLY while platform staff act inside an organisation (header x-acting-tenant). Then scope is 'tenant', tenantId is that
   * organisation, userId is the staff member's own id, and `permissions` is the acting set. See docs/adr/0004-acting-as-organisation.md.
   */
  actingAs?: { tenantId: string; tenantName: string; byUserId: string };
  /** The staff member's ORIGINAL platform permissions while acting; `platform:*` checks use these, everything else uses `permissions`. */
  platformPermissions?: Permission[];
}

export interface TeamMember {
  id: string;
  name: string;
  role: string;
}

export interface TenantSummary {
  id: string;
  name: string;
  status: 'active' | 'suspended';
}

/** Running costs the platform pays on an organisation's behalf (WhatsApp messages, SMS, storage...). */
export type UsageCategory = 'whatsapp' | 'sms' | 'email' | 'storage' | 'ai' | 'ads' | 'other';

export interface PlatformPort {
  /** Every organisation. Used by platform-level research that aggregates across organisations. */
  listTenants(): Promise<TenantSummary[]>;
  /** Public pages and webhooks find their organisation by its address (slug). null = unknown or suspended. */
  findTenantBySlug(slug: string): Promise<TenantSummary | null>;
  /** Verifies a login token and returns the live user (blocked/removed users fail here). Throws AppError 401/403. */
  verifyAccessToken(token: string): Promise<Principal>;
  /** Platform staff asks to act inside an organisation: returns the acting principal. Throws 403 (not allowed) / 404 (unknown organisation). */
  resolveActing(principal: Principal, tenantId: string): Promise<Principal>;
  /** Which modules this counsellor organisation may use right now. */
  enabledModules(tenantId: string): Promise<Record<string, boolean>>;
  /** Active staff of one organisation, optionally filtered by role. */
  listTeam(tenantId: string, roles?: string[]): Promise<TeamMember[]>;
  /** Invite a student / college employee to a portal. Does not use a staff seat. */
  createPortalUser(tenantId: string, input: { role: PortalRole; name: string; email: string; password: string; linkedId: string }): Promise<{ id: string }>;
  /** Turn off every portal login tied to a student/college (for example when a student is erased). Returns how many were disabled. */
  disablePortalUsers(tenantId: string, linkedId: string): Promise<number>;
  /** Record a platform cost caused by an organisation, so margin reports see it. Never throws. */
  recordUsage(tenantId: string, entry: { category: UsageCategory; amountPaise: number; note?: string }): Promise<void>;
}
