# Build plan: the remaining modules (specification for implementers)

Read first: [ARCHITECTURE.md](ARCHITECTURE.md) (structure + rules) and the existing `src/product/modules/leads` and `ledger` (the pattern to copy).
This file says WHAT each module must do. HOW is the existing code's style: small files, plain-language errors, zod validation, tests.

## 0. Ground rules (every module)

1. **Folder:** `src/product/modules/<name>/{domain,application,infrastructure,http}/` + `index.ts` (public API) + `module.json` (`{"description": "...", "dependsOn": ["audit", ...]}`; list EVERY other module you import, short names, same context only).
   `tests/architecture.test.ts` fails if you import an undeclared module, import a module's internals, or create a cycle.
2. **Data** lives in the organisation's own database: `const Thing = defineTenantModel('Thing', schema)` in `infrastructure/*.model.ts` (module level), then `Thing(tenantId).find(...)`. Never `mongoose.model()`. Add indexes in the schema (unique constraints that matter: duplicates, idempotency).
3. **Routes:** a `<name>Routes = (g: Guards): Router` in `http/`. Every endpoint: `g.requirePermission(...)` + `validate({...zod})` + plain-language errors (`badRequest`, `notFound`, `conflict`, `forbidden` from `shared/kernel/errors`). Mount behind `g.requireModule('<key>')` in `src/product/routes.ts` (one import + one `r.use` line; do not touch other lines).
4. **Data scope:** a `counsellor` role only sees records assigned to them (see `visibility()` in lead.service.ts). Portal roles never reach staff endpoints.
5. **Audit** every create/update/status change with `audit(tenantId, {...})` from `../../audit/index.js` (declare `audit` in dependsOn).
6. **Events/hooks, not imports:** to react to another module use `subscribe` (shared/kernel/events.ts) or `registerGuard` / `registerContributor` (shared/kernel/hooks.ts). Expose `registerEvents()` (and/or `registerHooks()`) from your index.ts and add ONE call line in `src/app/events.ts`. Publish your own events with `publish`. You may append new event types to `DomainEvents` (additive only).
7. **Shared tools you can use:** `getPlatform()` (contracts: listTeam, recordUsage, createPortalUser...), `systemPrincipal(tenantId,'label')` (work done by the system), `shared/infra/{crypto,http,fileStore}` (encrypt, signed links, outbound HTTP that tests can fake, file storage), `shared/kernel/{money,phone,events,hooks}`, `shared/http/schemas` (objectId, paging, period).
8. **Money = integer paise.** Phone = `normalizePhone` (+91...). Ids in URLs validated with `objectId`.
9. **Catalogue:** when your module is complete flip its `stage: 'soon'` to `'live'` in `core/modules/catalog/domain/moduleCatalog.ts` (only your key's line).
10. **Do not edit:** `contracts/*`, `shared/*` (except additive event types), other modules, `tests/architecture.test.ts`, translations. i18n: use plain English strings; the shell is translated by the maintainer.
11. **Tests (required):** pure rules in `tests/<name>.domain.test.ts` (no DB); one full story in `tests/e2e/<name>-flow.test.ts` using the existing pattern (`MongoMemoryServer`, `buildApp()`, supertest; copy the setup from `tests/e2e/billing-flow.test.ts`). Cover: happy path, validation errors, permission (403) and module-off (403 MODULE_NOT_ENABLED), counsellor data scope, audit rows, isolation between two organisations, idempotency/duplicates where relevant. Outbound HTTP is faked with `setHttpClient`; files with `setFileStore(new MemoryFileStore())`.
12. **Done means:** `npx tsc --noEmit` clean, `npx vitest run` (unit incl. architecture) and your e2e green, admin lint + checks green (below). Report in the format at the end.

## Admin UI (repo `../counsellor-platform-admin`, read its README first)

For each module you build, add `src/modules/<name>/{api.js,pages/*.jsx,module.jsx,module.json}` (+ `index.js` only if another module needs a piece):
- `api.js`: one function per endpoint (axios from `shared/api/Axios`). `module.jsx`: routes wrapped in `<Guard scope perm module>` and `nav` entries (`section`, `order`, `to`, `label`, `icon`, `scope`, `perm`, `module`). `module.json`: dependsOn (usually `["auth"]`, plus `catalog` if you use `useCatalog`).
- Add ONE import + ONE entry in `src/app/modules.js`. Use only `shared/ui/ui` (Button, Card, Badge, PageHeader, Field, Input, Select, Modal, Table, Pager, Spinner, Empty), tokens (`text-fg`, `bg-surface`, `border-line`, `text-fg-muted`) and `toastError`. No hard-coded light-only colours (`npm run check:theme`). Currency via `formatINR`, rupees->paise via `rupeesToPaise`.
- Checks that must pass: `npm run lint`, `npm run check:architecture`, `npm run check:theme`, `npm run check:i18n`, `npx vite build`.

## 1. students  (key `students`, permissions students:*)

- **Student** {name, phone (+91, unique per organisation), email?, dob?, gender?, address{line,city,state,pincode}, guardian{name,phone,relation}, academics[{level,board,institute,year,percentage}], testScores[{test,score,year}], preferences{courses[],cities[],budgetMaxPaise?}, leadId?, assignedTo?, consent{given,source,at, guardianConsent{given,at,by}}, status 'active'|'erased', erasedAt}.
- **DPDP rule (domain, tested):** if age < 18 at creation, `guardianConsent.given` must be true, else 400 with a plain message.
- Endpoints: `POST /students`, `POST /students/from-lead/:leadId` (copies name/phone/email/city/course/consent from the lead via `leads` public API; refuses a second student for the same lead; publishes `student.created`), `GET /students` (search name/phone, paging; counsellor sees own), `GET /students/:id`, `PATCH /students/:id`.
- **Export (students:export):** `GET /students/:id/export` returns `{student, sections: await collectSections('student.export', {...}), exportedAt, exportedBy}` and audits it. Other modules add sections by `registerContributor('student.export', ...)`.
- **Erase (students:erase):** `POST /students/:id/erase {confirm:'ERASE', reason}`: anonymise (name 'Erased student', remove phone/email/dob/address/guardian/academics/scores/preferences, keep id + counts), `status='erased'`, `getPlatform().disablePortalUsers`, publish `student.erased`, audit. Irreversible. Erased students are excluded from lists unless `?includeErased=1`.
- Public API (index.ts): `getStudent(tenantId,id)`, `studentExists`, `registerEvents` (none needed), plus `studentRoutes`.
- dependsOn: audit, leads.

## 2. colleges  (key `colleges`, permissions colleges:*)

- **College** {name, slug (unique), type 'university'|'college'|'institute'|'school', city, state, country 'India', website, contact{name,email,phone}, affiliation, accreditations[], description, requiredDocuments[{type,label,mandatory}] (defaults for its courses), active}.
- **Course** {collegeId, name, level 'diploma'|'ug'|'pg'|'phd'|'certificate', stream, durationMonths, annualFeePaise, totalFeePaise?, intakes[{month 1-12, year, seats?, deadline?}], eligibility{minPercentage?, requiredExams[], notes}, requiredDocuments[]? (overrides college's), active}.
- Endpoints: CRUD colleges and `/colleges/:id/courses` (read = colleges:read, write = colleges:write; deactivate instead of delete when applications exist is a later concern: soft `active=false`), filters (city, state, type, level, course name, fee range, intake year), `POST /colleges/import {rows}` (bulk, per-row validation + report, upsert by slug), `POST /colleges/shortlist {percentage, level, budgetMaxPaise?, cities?[], course?, intakeYear?}` -> ranked matches (pure domain function `matchCourses`, tested: eligibility, budget, city, deadline not passed).
- Public API: `getCollege`, `getCourse(tenantId,id)`, `listActiveColleges(tenantId)`, `getRequiredDocuments(tenantId, collegeId, courseId?)`.
- dependsOn: audit.

## 3. followups  (key `followups`, permissions followups:*)

- **Task** {entityType 'lead'|'student'|'application', entityId, title, notes?, dueAt, assignedTo, status 'open'|'done'|'cancelled', completedAt, outcome?, createdBy}.
- **Activity** {entityType, entityId, kind 'call'|'whatsapp'|'email'|'meeting'|'note'|'system', direction 'in'|'out'?, summary, outcome?, durationSec?, at, by}.
- Endpoints: tasks CRUD + `POST /followups/tasks/:id/complete {outcome}`; `GET /followups/tasks?mine=1&status=open&due=today|overdue|week&entityType&entityId`; `POST /followups/activities`; `GET /followups/activities?entityType&entityId` (timeline, newest first); `GET /followups/summary` (mine: open, dueToday, overdue). Counsellor sees only own tasks.
- **registerEvents():** on `lead.created` -> system activity "Lead created via <channel>"; on `lead.stage_changed` -> system activity; on `lead.assigned` -> auto task "Contact new lead" due in 1 hour for the assignee (skip if an open such task exists).
- dependsOn: audit.

## 4. leads import  (inside the existing `leads` module; permission leads:import)

- `POST /leads/import {rows:[{name,phone,email?,city?,interestedCourse?}], channel:'import', autoAssign?, consentGiven:true, dryRun?}`; max 1000 rows. `consentGiven` must be true (the importer attests the people agreed to be contacted; stored as consent{given:true, source:'import'}). Per row: normalise phone, validate, de-duplicate against existing leads AND inside the file. Response `{total, created, duplicates, invalid:[{row, reason}], dryRun}`. `dryRun` writes nothing. One audit summary row (not 1000). Publishes `lead.created` per created lead. Domain function `validateImportRows` unit-tested.
- Admin UI: "Import" button on the Leads page: pick an Excel/CSV file (parse in the browser with the `xlsx` package, already a dependency of the admin app), map columns, preview with errors, then submit in chunks of 500.

## 5. applications  (key `applications`, permissions applications:*)

- **Application** {studentId, collegeId, courseId, intake{month,year}, status, statusHistory[{from,to,by,at,note}], assignedTo, collegeRef?, fee{applicationFeePaise?, tuitionPaise?, paidPaise}, offer{scholarshipPaise?, deadline?, note?}, notes?, createdBy}. Unique (studentId, courseId, intake).
- **Status machine (domain, tested):** `draft -> documents_pending -> ready_to_submit -> submitted -> under_review -> offered | rejected`; `offered -> accepted | declined`; `accepted -> fee_paid -> admitted`; `withdrawn` allowed from any non-terminal state. Terminal: admitted, rejected, declined, withdrawn. Skipping is not allowed. `accepted/fee_paid/admitted` may record `fee.paidPaise`.
- Endpoints: `POST /applications` (validates student, college and course exist and the course belongs to the college; default status draft), `GET /applications` (filters status, collegeId, assignedTo, studentId; counsellor sees own), `GET /applications/:id`, `PATCH /applications/:id` (notes, collegeRef, assignedTo, fee, offer), `POST /applications/:id/status {to, note, feePaidPaise?}` (applications:status).
- Before a status change run `runGuards('application.beforeStatusChange', ...)`; if reasons exist return 409 `STATUS_BLOCKED` with the reasons joined. After: publish `application.status_changed`; on create publish `application.created`.
- `registerHooks()`: contributor for `student.export` (the student's applications); `registerEvents()`: on `student.erased` clear free-text notes of that student's applications.
- Public API: `getApplication(tenantId,id)` (summary), `listApplicationsForStudent`, `listApplicationsForCollege(tenantId, collegeId, filters)`, `changeApplicationStatus(principal, id, to, note)` (so the college portal / API can reuse the rules), `applicationCountsByStatus(tenantId)`.
- dependsOn: audit, students, colleges.

## 6. commissions  (key `commissions`, permissions commissions:*)

- **CommissionRule** per college {collegeId, mode 'percent_of_fee'|'flat'|'none', percentBps, flatPaise, trigger 'fee_paid'|'admitted', counsellorShareBps, active}. **Accrual** {applicationId (unique), collegeId, counsellorId?, totalPaise, counsellorSharePaise, organisationSharePaise, ledgerEntryId, status 'accrued'|'collected'|'reversed'}.
- Domain `computeCommission(rule, application)` (tested: percent of tuition paid, flat, share split with integer paise and no lost paisa: counsellor share floors, organisation gets the remainder).
- `registerEvents()`: on `application.status_changed` when `to === rule.trigger` and a rule exists: accrue once (idempotent) and post to the ledger with `systemPrincipal`: debit `college:<id>` total, credit `counsellor:<id>` counsellor share, credit `platform:commission_income` remainder (organisation's own income); idempotencyKey `commission-accrual-<applicationId>`. Publish `commission.accrued`.
- Endpoints: rules CRUD (commissions:manage), `GET /commissions` (accruals, filters), `GET /commissions/summary` (per counsellor: accrued, paid, payable via ledger `balanceOf`), `POST /commissions/payouts {counsellorId, amountPaise, reference}` (ledger: debit `counsellor:<id>`, credit `bank:main`; cannot pay more than payable), `POST /commissions/:accrualId/collect {reference}` (college paid us: debit `bank:main`, credit `college:<id>`), `POST /commissions/:accrualId/reverse {reason}` (ledger reversal).
- dependsOn: audit, applications, colleges, ledger.

## 7. documents  (key `documents`, permissions documents:*)

- **Document** {studentId, applicationId?, type, label?, fileName, mimeType, sizeBytes, sha256, storageKey, status 'pending_review'|'verified'|'rejected', rejectReason?, verifiedBy/At, uploadedBy (user id or 'student'), version, supersededBy?, deletedAt?}.
- **Upload:** `POST /documents?studentId=&type=&applicationId=&label=` with a RAW body (`express.raw({type:'*/*', limit: MAX_UPLOAD_MB MB})`) and header `x-file-name`. Only PDF / JPEG / PNG, detected by MAGIC BYTES not by the declared type; reject others and empty files; size limit from env. The bytes are **encrypted** (`encryptBuffer`) and stored with `getFileStore().put('<tenantId>/<studentId>/<documentId>', ...)`. Re-uploading the same type for the same student/application creates a new version and supersedes the old one. Publishes `document.uploaded`.
- `GET /documents?studentId=&applicationId=` (metadata only), `GET /documents/checklist?studentId=&applicationId=` (required documents from `colleges.getRequiredDocuments` via the application's college/course vs uploaded status: missing / pending_review / verified / rejected).
- **Verify/reject** (documents:verify): `POST /documents/:id/verify`, `POST /documents/:id/reject {reason}` (reason required). Publish events.
- **Download is two steps and always audited:** `POST /documents/:id/download-link` (documents:download) returns `{url, expiresInSeconds}` where the URL is `/public/documents/file/<token>`; the token is an HMAC-signed (`hmacHex` with the JWT secret) payload {tenantId, documentId, userId, exp = DOWNLOAD_LINK_TTL_SECONDS}. `GET /public/documents/file/:token` (mounted in publicRoutes) verifies signature + expiry, decrypts, streams with `content-disposition: attachment`, `cache-control: no-store`, audits "document.downloaded" with the issuing user. Tampered/expired token -> 403.
- `DELETE /documents/:id` (documents:write; only while pending_review or rejected): deletes file + marks deleted. `registerHooks()`: guard on `application.beforeStatusChange` blocking `to === 'submitted'` unless every MANDATORY checklist item is verified (message lists the missing ones); contributor for `student.export` (metadata list, not file contents). `registerEvents()`: on `student.erased` delete every file + record of that student.
- Security tests required: a stored file's bytes are NOT the original bytes (encrypted), a modified ciphertext fails to decrypt, path traversal in keys is impossible, wrong organisation cannot read another organisation's document.
- dependsOn: audit, students, colleges, applications.

## 8. reports  (key `reports`, permission reports:read)

- Endpoints (organisation-scoped, counts and rupee totals, no raw PII): `GET /reports/funnel?from&to` (lead stages + conversion), `GET /reports/sources` (per channel: leads, applications, admitted, conversion), `GET /reports/counsellors` (per counsellor: leads, contacted within 24h?, applications, admitted, conversion, commission accrued), `GET /reports/applications` (by status, by college), `GET /reports/revenue?from&to` (commission accrued/collected/paid out). Pure aggregation helpers in `domain/` unit-tested.
- Public APIs needed from other modules (add them additively): leads `leadCountsBySource`/stage (already: `leadCountsByStageAndChannel`), applications `applicationCountsByStatus`, `applicationCountsByCollege`, `applicationCountsByCounsellor`, commissions `commissionTotals(tenantId, range)`.
- dependsOn: audit, leads, applications, commissions.

## 9. publicApi  (key `publicApi`, permission integrations:manage)

- **ApiKey** {name, prefix, hash (SHA-256 of the secret), scopes['leads:create','colleges:read','applications:read','applications:update'], collegeId? (a key tied to one college = the "college API"), lastUsedAt, revokedAt}. Key format shown ONCE at creation: `cpk_<tenantId>_<random>`; only the hash is stored; the tenantId inside the key resolves the organisation without a login.
- Management (staff, integrations:manage): create / list / revoke keys; **Webhook subscriptions** {url (https only, no private IPs/localhost: SSRF guard in domain, tested), events[], secret, active, failureCount}; list deliveries {event, status, attempts, responseCode, at}.
- Public endpoints (mounted under `/public/v1`, auth by `Authorization: Bearer cpk_...`, per-key rate limit): `POST /leads` (scope leads:create; website/partner forms; requires `consent.given`; uses `leads.createLead` with `systemPrincipal(tenantId,'api:<keyName>')`; idempotent by phone), `GET /colleges` (scope colleges:read), `GET /applications` and `PATCH /applications/:id/status` for a **college-tied** key: returns/updates only that college's applications through `applications.changeApplicationStatus` (same state-machine rules; scope applications:update).
- **Outgoing webhooks:** `registerEvents()` subscribes to lead.created, lead.stage_changed, application.created, application.status_changed, document.verified; for each active subscription send `POST url` with JSON `{id, event, occurredAt, data}` (ids only + minimal fields, no PII beyond what the subscriber already holds), header `x-cp-signature: sha256=<hmac(secret, body)>`, `x-cp-event`, timeout 5 s; record the delivery; retry with backoff up to 5 attempts (schedule stored as `nextAttemptAt`; a `retryDueDeliveries(tenantId?)` function + `POST /integrations/webhooks/retry` for staff; no cron needed yet). Tested with a fake HTTP client.
- dependsOn: audit, leads, colleges, applications.

## 10. metaAds  (key `metaAds`, permission integrations:manage)

- Per-organisation **MetaConfig** {pixelId, pageId?, accessToken (ENCRYPTED with `encryptString`), verifyToken, testEventCode?, enabled}.
- **Lead Ads webhook (public):** `GET /public/hooks/meta/:tenantId` (Meta verification handshake: `hub.mode=subscribe`, `hub.verify_token` compared with `safeEqual`, echo `hub.challenge`) and `POST /public/hooks/meta/:tenantId` (verify `x-hub-signature-256` = HMAC-SHA256 of `req.rawBody` with `META_APP_SECRET`; 401 if wrong). For each `leadgen_id` fetch the lead from the Graph API (`GET /{leadgen_id}?access_token=`) through `httpRequest`, map `field_data` (full_name, phone_number, email, city) to a lead (channel `meta_ads`, utm from ad/form ids, consent given because it is a lead-form submission with Meta's disclosure), call `leads.createLead` with `systemPrincipal(tenantId,'meta-ads')`. Duplicate phone = no new lead.
- **Conversions API:** `registerEvents()` on `lead.created` -> `Lead`, on `lead.stage_changed` to `qualified` -> `QualifiedLead`... (map table in domain, configurable), to `admitted` -> `Purchase`-style custom event `Admission`. POST to `https://graph.facebook.com/<META_GRAPH_VERSION>/<pixelId>/events` with `user_data` hashed (SHA-256 of lowercase trimmed email, phone digits with country code), `event_id` = lead id + event name (dedupe), `event_time`, `action_source: 'system_generated'`/`crm`. No raw PII is ever sent. Failures are recorded (not thrown) and retried once.
- Staff endpoints: GET/PUT config (token never returned, only `tokenSet: true`), `POST /integrations/meta/test` (sends a test event with `testEventCode`), `GET /integrations/meta/events` (last 100 sent with status).
- Tests use a fake HTTP client and assert the exact hashed payload and the signature rejection.
- dependsOn: audit, leads.

## 11. whatsapp  (key `whatsapp`, permissions whatsapp:send, integrations:manage)

- Platform-level WhatsApp Cloud API (env WHATSAPP_*), shared by organisations. **Template** {name, language, body with {{1}} placeholders, purpose, active} per organisation; **Message log** {leadId/studentId, to, template, params, status 'queued'|'sent'|'failed'|'delivered'|'read', providerId, error, at, by}.
- `POST /whatsapp/send {leadId|studentId, template, params[]}` (whatsapp:send): respects consent (refuse if the lead has no consent, plain message), de-duplicates identical sends within 10 minutes, calls Graph API through `httpRequest`, logs, and **meters the cost**: `getPlatform().recordUsage(tenantId,{category:'whatsapp', amountPaise: env.WHATSAPP_COST_PER_MESSAGE_PAISE})` per successful send. `GET /whatsapp/messages?leadId` (timeline), template CRUD (integrations:manage).
- **Automation rules** {event 'lead.created'|'lead.stage_changed'|'application.status_changed', filter (stage/status), template, delayMinutes=0, active}: `registerEvents()` runs matching rules (send immediately when delay = 0).
- **Inbound/status webhook (public):** `GET /public/hooks/whatsapp` (verify token handshake with WHATSAPP_VERIFY_TOKEN), `POST /public/hooks/whatsapp` (verify `x-hub-signature-256` with META_APP_SECRET; update message status delivered/read/failed by providerId; an inbound text creates a system activity note on the lead matched by phone if any (via `leads` public API)).
- Tests: fake HTTP, consent refusal, dedupe window, metering amount recorded via a fake platform, signature rejection.
- dependsOn: audit, leads.

## 12. seoPages  (key `seoPages`, permission seo:manage)

- Per organisation **SeoSettings** {siteTitle, tagline, logoUrl?, themeColor, contact{phone,email,whatsapp}, enabledColleges[] or all active, leadFormEnabled, consentText}. **CollegePage** overrides {collegeId, metaTitle, metaDescription, heroText, faqs[{q,a}], published}.
- Public, no login, mounted under `/public/sites/:slug` (slug resolves the organisation via `getPlatform().findTenantBySlug`; suspended/unknown = 404): `GET /` (list of colleges, HTML), `GET /colleges/:collegeSlug` (HTML page: title, meta description, canonical, Open Graph tags, JSON-LD `CollegeOrUniversity` + `FAQPage`, course table, lead form), `GET /sitemap.xml`, `GET /robots.txt`, `GET /colleges/:collegeSlug.json`. Server-rendered HTML with HTML-escaping of EVERY dynamic value (XSS test required). `POST /lead` (form post, JSON or urlencoded; consent checkbox required; honeypot field; per-IP rate limit via the router's own limiter; creates a lead channel `website`, utm from query) -> returns a thank-you page or JSON.
- Staff endpoints: GET/PUT settings, page overrides CRUD, `GET /seo/preview/:collegeSlug`.
- dependsOn: audit, colleges, leads.

## 13. portal  (keys `studentPortal`, `collegePortal`; permissions portal:student, portal:college)

- Module name `portal` (one folder, two surfaces). **Invites:** `POST /students/:id/portal-invite` can't live in students; instead `POST /portal/student-invites {studentId}` (staff, students:write) creates the login with `getPlatform().createPortalUser({role:'student', linkedId: studentId, email, password: generated, ...})` and returns the temporary password ONCE; `POST /portal/college-invites {collegeId, name, email}` likewise for `college_user`. Both require the matching module on.
- **Student portal** (`/portal/student/*`, permission portal:student, `req.principal.linkedId` = studentId, never accept a studentId from the client): `GET /portal/student/overview` (own profile summary, applications with status + history, document checklist), `POST /portal/student/documents` (upload own document, same pipeline as staff upload but `uploadedBy:'student'`, only for own applications), `GET /portal/student/applications/:id`. A student can never see another student's data (test with two students).
- **College portal** (`/portal/college/*`, permission portal:college, `linkedId` = collegeId): `GET /portal/college/applications` (only applications sent to that college; student name + academics summary only, no phone/email/address), `POST /portal/college/applications/:id/status {to, note}` through `applications.changeApplicationStatus` (state machine rules apply, only the transitions a college may do: under_review, offered, rejected, accepted-confirmation, admitted), `GET /portal/college/applications/:id/documents` (verified documents metadata) + signed download via documents API. A college user can never see another college's applications.
- dependsOn: audit, students, colleges, applications, documents.

## 14. Core hardening (identity, billing, ops)  (core context, not a product module)

- **Refresh tokens:** access token `ACCESS_TOKEN_TTL` (15m); `POST /auth/login` returns `{token, refreshToken, expiresIn, user}`; `POST /auth/refresh {refreshToken}` rotates (old one single-use); **reuse of a used token revokes the whole family** (theft signal); stored hashed (`RefreshToken` {userId, familyId, hash, expiresAt TTL index, usedAt, revokedAt, userAgent, ip}); logout revokes; `logout-all`, password change/reset and block revoke all. Admin client refreshes once on 401 (single-flight) and retries.
- **MFA (TOTP, RFC 6238, 30 s, 6 digits, ±1 step) with node crypto only:** `POST /auth/mfa/setup` -> secret (encrypted at rest) + `otpauth://` URL; `POST /auth/mfa/enable {code}` -> 10 single-use recovery codes (hashed); `POST /auth/mfa/disable {password, code}`; login for an MFA user returns `{mfaRequired:true, mfaToken}` (5 min) and `POST /auth/mfa/verify {mfaToken, code | recoveryCode}` issues tokens; brute-force limited. `/me` includes `mfa:{enabled}`. Admin: Account page enrol/disable + login second step.
- **Billing completion:** `PlatformSettings` {legalName, gstin, pan, address, state, email, phone, bank{name,account,ifsc}, invoiceFooter, gstRateBps default 1800} (`GET/PUT /platform/settings`, platform:settings:manage); organisation billing details {legalName, gstin, address, state} (`PATCH /platform/tenants/:id/billing-details`); the invoice stores the GST rate used, and splits CGST+SGST (same state) vs IGST (different state) on the invoice lines; `GET /platform/invoices/:id/pdf` (small dependency-free PDF writer in `shared/infra/pdf.ts`, tested: starts with `%PDF`, contains invoice number, totals, GSTIN); **Razorpay payment link** `POST /platform/invoices/:id/payment-link` (adapter over `httpRequest`, env RAZORPAY_*; stores link id/url/status on the invoice) and public webhook `POST /public/webhooks/razorpay` (verify `x-razorpay-signature` HMAC of `rawBody` with `RAZORPAY_WEBHOOK_SECRET` (add to env.ts), mark the invoice paid with the payment id, idempotent).
- **Ops:** `npm run db:indexes` (`scripts/sync-indexes.ts`: syncIndexes for master models and, for every organisation, every schema from `allTenantSchemas()`); `scripts/export-tenant.ts <tenantId>` (JSON dump of one organisation's database, for portability/erasure requests) and `scripts/backup.mjs` + `docs/BACKUP_AND_RECOVERY.md` (mongodump/mongorestore wrapper, retention, restore drill checklist; clearly marked unverified where mongodump is not installed).

## Report format (when you finish)

1. Files created/changed (grouped). 2. Public exports of your `index.ts` (names) + `registerEvents`/`registerHooks` call lines you added to `src/app/events.ts`. 3. `module.json` dependsOn. 4. Endpoints list. 5. Commands you ran and their results (tsc, vitest unit, e2e, admin lint/checks/build) - quote the counts. 6. Anything NOT done or that needs credentials / a human decision (be explicit; never claim an external integration works against the real service).
