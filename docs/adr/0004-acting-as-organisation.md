# ADR 0004: Platform staff acting inside an organisation

**Status:** accepted. **Replaces** the earlier rule "platform staff never see organisation data" (that rule still holds for every platform role EXCEPT a superadmin who has deliberately switched into an organisation, and for the platform "workspace" screen, which stays configuration/health only).

## Context
Support and onboarding need a superadmin to see exactly what an organisation's admin sees (menu, pages, data) to help them, like the superadmin store switch in the e-commerce product (`x-tenant-id`). This is a conscious trade-off: platform staff can now reach student data.

## Decision
- **Request header `x-acting-tenant: <organisation id>`.** Honoured in `authenticate` only when the verified principal is platform scope AND holds `platform:tenants:impersonate` (only `superadmin`, via `'*'`). Otherwise 403 (and a `tenant.acting_denied` platform audit row); unknown or malformed id: 404; a suspended organisation is allowed. The header is ignored on `/api/v1/auth/*` so login, refresh, password and MFA always act on the real user.
- **The resulting principal** is a normal tenant principal: scope `tenant`, `tenantId` = the organisation, `userId` = the staff member's own id, role `platform_support` (a pseudo-role: scope tenant, never stored on a user, not in `STAFF_ROLE_KEYS` / `TENANT_ROLE_KEYS`, hidden from `/catalog/roles`), plus `actingAs { tenantId, tenantName, byUserId }`. Every tenant route, module gate (`requireModule` uses the organisation's real modules) and visibility rule therefore works unchanged.
- **Permissions** = the owner's permissions minus `team:manage`, `students:erase`, `documents:download`, `students:export`, `ledger:post`, `commissions:manage` (irreversible, PII-export or money-moving actions stay with the organisation). Derived in one pure function, `deriveActingPermissions` (`core/modules/catalog/domain/roles.ts`), and unit-tested. No platform or portal permission is ever in the set.
- **Platform routes keep working with the header** by the simplest sound approach: the principal carries `platformPermissions` (the original set), and `requirePermission('platform:...')` checks that set while every other permission is checked against `permissions` (the acting set). Nothing else in the product reads `platformPermissions`.
- **Audit.** `audit()` stamps `actingAs: true` on every organisation audit row written while acting (the actor is the staff member). In addition `app/actingAudit.ts` writes one row (`acting.write`, or `acting.blocked` when the answer was 403) for every non-GET request and every blocked attempt, before the response is sent. `POST /platform/tenants/:id/acting/start` (permission `platform:tenants:impersonate`, body `{ reason? }`, 30 requests/minute) writes the platform audit row `tenant.acting_started`; the admin calls it once at the switch. GET requests are not logged individually (volume); they are covered by the start event and request logs.
- **Port.** `PlatformPort.resolveActing(principal, tenantId)` is new, so a separate core service can serve it later. The header name lives in `contracts/guards.ts`.
- **Branding** (same change): `logoUrl` (https, max 500) and `brandColor` (#rrggbb) on the organisation, set by platform staff (`PATCH /platform/tenants/:id`) or the owner (`PATCH /organisation/profile`, `team:manage`, so not while acting). URL only, no upload.

## Consequences
- Platform staff access to student data now exists, is audited and rate-limited, but legally needs a contractual basis and a written policy (see `docs/GO_LIVE_CHECKLIST.md`, DPDP).
- A leaked superadmin token can now read organisation data. Enforce MFA for superadmin.
- Organisations can see the acting rows in their own audit (`GET /audit`), which is the transparency mechanism.
