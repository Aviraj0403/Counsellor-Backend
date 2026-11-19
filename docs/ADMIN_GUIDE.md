# Admin Guide (plain language)

## The 3 levels of control

1. **Super Admin (us)** decides which *organisations* exist and which *modules* each one has bought.
2. **Organisation Owner** (a counsellor business) adds its own staff and gives each a *role*.
3. **Role** decides what a staff member can do inside the modules that are switched on.

A feature works only when **all three** agree: module is ON for the organisation **and** the role allows the action.

## Roles: who can do what

| Role | Side | Can do |
|---|---|---|
| Super Admin | Us | Everything on the platform |
| Platform Operations | Us | Create and manage organisations, switch modules on/off, read the platform audit and usage research (our internal admissions team) |
| Platform Finance | Us | Plans, pricing, invoices, platform costs, financial dashboard, research, platform audit |
| Platform Ads Team | Us | Run ads for organisations that bought Meta Ads (screens come with that module) |
| Owner | Organisation | Everything inside the organisation |
| Counsellor | Organisation | See and work **only leads assigned to them** |
| Sales team | Organisation | Add, assign, import and update leads |
| Marketing team | Organisation | Import and see leads. Cannot change student progress |
| Support team | Organisation | See leads and update progress (call / reach-out follow-up) |
| Accounts | Organisation | Post and read ledger entries. Read-only on leads |

Live list (always current): `GET /api/v1/catalog/roles`.

## Modules

`Core` = always on. `Add-on` = off until we switch it on for that organisation (this is what we sell).
`Built` = ready to use today. `Coming` = registered and priceable, feature not built yet, **do not sell yet**.

| Module | Type | Status | Needs first |
|---|---|---|---|
| Leads & enquiries | Core | Built | , |
| Team & roles | Core | Built | , |
| Ledgers & commission | Add-on | Built | , |
| Student profiles | Add-on | Coming | Leads |
| College directory | Add-on | Coming | , |
| Applications & status | Add-on | Coming | Student profiles + College directory |
| Document vault | Add-on | Coming | Student profiles |
| Reports & analytics | Add-on | Coming | Leads |
| WhatsApp automation | Add-on | Coming | Leads |
| Meta Ads connection | Add-on | Coming | Leads |
| SEO college pages | Add-on | Coming | College directory |
| API & webhooks | Add-on | Coming | , |
| Student status portal | Add-on | Coming | Applications |
| College portal | Add-on | Coming | Applications |

If a module's "Needs first" module is off, the module stays off automatically, so nothing half-works.
Live list: `GET /api/v1/catalog/modules`.

## How to: onboard a new counsellor organisation

1. Super Admin logs in: `POST /api/v1/auth/login`.
2. Create the organisation + its owner: `POST /api/v1/platform/tenants`
   `{ name, slug, ownerName, ownerEmail, ownerPassword }`.
3. Switch on what they bought: `PATCH /api/v1/platform/tenants/:id/modules` `{ "modules": { "ledger": true } }`.
4. Give the owner their login. The owner adds staff: `POST /api/v1/team` `{ name, email, password, role }`.

When you switch a module on, the response includes plain-language `warnings` if the feature is not built yet
("coming soon") or if it stays off because a required module is off. Read them before promising anything to a customer.

## How to: manage staff (organisation Owner)

| Do this | Call |
|---|---|
| See everyone incl. blocked | `GET /api/v1/team` |
| Add staff (any role except Owner) | `POST /api/v1/team` `{ name, email, password, role }` |
| Change a role (takes effect immediately) | `PATCH /api/v1/team/:userId/role` `{ role }` |
| Set a new password for someone | `POST /api/v1/team/:userId/reset-password` `{ newPassword }` (their old sessions end at once) |
| Block / unblock | `PATCH /api/v1/team/:userId/status` |

The Owner role cannot be added, changed or blocked by staff management: there is exactly one Owner, created with the organisation.

## How to: stop access

- **Block one person:** `PATCH /api/v1/team/:userId/status` `{ "status": "blocked" }` (takes effect on their very next request).
- **Suspend a whole organisation (e.g. unpaid):** `PATCH /api/v1/platform/tenants/:id/status` `{ "status": "suspended" }`. Everyone in it is locked out immediately; reactivate with `"active"`.
- **Log yourself out of every device:** `POST /api/v1/auth/logout-all`.
- **Change your own password:** `POST /api/v1/auth/change-password` `{ currentPassword, newPassword }`; it ends your other sessions.

## Who did what (audit)

- **Platform audit** (`GET /api/v1/platform/audit`, optional `?tenantId=`): organisation created / renamed / suspended, modules switched, staff created / role changed / blocked / password changed or reset. Platform Super Admin, Ops and Finance can read it.
- **Organisation audit** (`GET /api/v1/audit`): lead and ledger activity, visible to that organisation's Owner.

## How leads work

`new → contacted → qualified → counselling done → application started → admitted`, and `lost` from any open stage
(a lost lead can be reopened as `new`). Steps cannot be skipped.

- The same phone number twice is **one** lead; the repeat enquiry is logged, not duplicated.
- Phone numbers are cleaned automatically (`98765 43210`, `+91-98765-43210` → `+919876543210`).
- Auto-assign gives the next lead to the counsellor with the fewest open leads.
- Consent (did the student/parent agree to be contacted, and when) is stored on every lead.

## How the ledger works

Every money movement is an **entry** with lines that always balance (money out = money in).
Entries can never be edited or deleted. A mistake is corrected by a **reversal** entry, so history stays honest.
Amounts are stored in **paise** (₹1 = 100). Posting the same `idempotencyKey` twice never double-counts.
Accounts look like `student:<id>`, `college:<id>`, `counsellor:<id>`, `platform:revenue`, `bank:main`, `tax:gst`.
The **trial balance** (`GET /api/v1/ledger/trial-balance`) must always show `isBalanced: true`. If it ever does not, treat it as an incident.


## Money: plans, pricing, invoices, costs (Super Admin and Platform Finance)

**Plans.** A plan = monthly base price + optional staff limit + add-ons bundled in that price.
`GET/POST /platform/plans`, `PATCH /platform/plans/:id` (retire a plan with `{ "active": false }`).
Assign to an organisation: `PATCH /platform/tenants/:id/plan` `{ "planKey": "starter" }` (`null` = no plan).

**What an organisation pays each month** = plan price + every add-on that is switched on, built (not "coming soon"),
not bundled in the plan and has a price, then GST on top. We never bill a feature that is not built yet.
Preview any time: `GET /platform/tenants/:id/billing`.

**Negotiated prices.** `PATCH /platform/tenants/:id/pricing` `{ "priceOverrides": { "ledger": 499 } }` replaces the list price for that
customer only (`0` = free for them, `null` = back to list price).

**Staff limit.** If the plan has `maxStaff`, the organisation cannot add or unblock accounts beyond it (error `PLAN_LIMIT`, in plain words).
Blocking someone frees a seat.

**Invoices.** `POST /platform/tenants/:id/invoices` `{ "period": "2026-11" }` snapshots the current charge into an invoice
(numbers like `CP-2026-0001`). One per organisation per month. An issued invoice never changes; later price changes only affect next month.
Mark it `paid` (with a payment reference) or `void`: `PATCH /platform/invoices/:id`. List: `GET /platform/invoices`.
GST rate is 18% in `billing.domain.ts` (`GST_RATE_BPS`): **confirm the rate and invoice format with your accountant before sending real invoices.**

**Platform costs.** What it costs us (hosting, WhatsApp, SMS, ads...): `POST /platform/costs`
`{ month, category, amountPaise, tenantId? , note? }`. A cost tied to an organisation counts against that organisation's margin. A wrong entry is
voided (`POST /platform/costs/:id/void`), never deleted. Automatic metering arrives with the WhatsApp / Meta modules; until then finance enters costs.

**Financial dashboard.** `GET /platform/dashboard?month=2026-11`: MRR, invoiced, collected, outstanding, costs by category, margin,
organisations (active / suspended / new), which add-ons customers use, and MRR vs cost per organisation. Finance and Super Admin only.

## Research (Super Admin, Platform Ops, Platform Finance)

Counts only, never student names, phones or documents.
- `GET /platform/insights/funnel`: leads per stage and **per source channel** across all active organisations, with admission conversion %
  (which channels actually produce admissions), plus conversion per organisation.
- `GET /platform/insights/usage`: leads, ledger entries and last activity per organisation (who really uses the platform).

## Ledger screen (organisation Owner and Accounts)
Entries list (`GET /ledger/entries`, shows which are already reversed), trial balance, post entry ("money comes FROM / goes TO"), reverse with a reason.

## Not built yet (be clear with customers)
College status, admission documents, student and college portals, WhatsApp automation, Meta Ads: registered as "coming soon" modules, not billed.

## Invoices, PDF, payment links, company details (Super Admin, Platform Finance)
- **Company details** (`/settings/company`, `GET/PUT /platform/settings`, permission `platform:settings:manage`): our legal name, GSTIN, PAN, address, state, bank, invoice footer and the GST rate (default 18%).
- **Organisation billing details** (`PATCH /platform/tenants/:id/billing-details`, or the form under the organisation's Billing tab): legal name, GSTIN, address, state. If the organisation's state equals ours the invoice shows CGST + SGST; otherwise (or if a state is missing) IGST. The rate and both parties' details are frozen on each invoice when it is issued.
- **PDF**: `GET /platform/invoices/:id/pdf` ("Download PDF" on the Invoices page).
- **Payment link**: `POST /platform/invoices/:id/payment-link` creates a Razorpay link (needs RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET). Razorpay must call `POST /public/webhooks/razorpay` (secret RAZORPAY_WEBHOOK_SECRET); a paid event marks the invoice paid once. Tested only with a fake HTTP client, not against real Razorpay.
- **Ops**: `npm run db:indexes` after deploys that change indexes; `tsx scripts/export-tenant.ts <tenantId> [file]` for one organisation's data export; backups: docs/BACKUP_AND_RECOVERY.md.

## Sign-in, sessions and two-step verification (everyone)
- Access tokens last 15 minutes and are renewed silently with a refresh token (14 days, per browser tab). If a refresh token is ever used twice, that login is ended everywhere as a theft precaution. Changing or resetting a password, blocking a user, "Log out of all devices" and Logout end the refresh tokens.
- **Two-step verification (TOTP)**: Account page > Two-step verification > Set up. Add the secret key to an authenticator app, enter the code to turn it on, and save the 10 recovery codes (shown once; each works one time). From then on sign-in asks for a code (or a recovery code) after the password. Five wrong codes lock the account for 15 minutes. To turn it off you need your password and a current code. A lost device with no recovery codes needs a database-level reset by us (not self-service yet).
- Endpoints: POST /auth/refresh, /auth/logout, /auth/mfa/setup, /auth/mfa/enable, /auth/mfa/disable, /auth/mfa/verify; GET /me includes mfa.enabled.
