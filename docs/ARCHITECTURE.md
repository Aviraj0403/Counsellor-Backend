# Architecture

## Shape: modular monolith, two bounded contexts, one contract between them

```
                         src/app  (composition root: wires everything, no business rules)
                         ┌───────────────────────────┴───────────────────────────┐
              src/core  (Platform Core)                              src/product (counselling product)
        catalog · audit · organisations                         leads · ledger · audit · insights
        identity · billing · onboarding                         (+ every future product module)
                         │                                               │
                         └──────────────►  src/contracts  ◄──────────────┘
                              the ONLY seam: port.ts, guards.ts, registry.ts
                                          │
                                   src/shared  (shared kernel: no business rules)
```

- **One deployable**, many internal modules. Split into services only when scale or team size demands it.
- `core/` can later become its own service (`PLATFORM_MODE=remote`) because `product/` only talks to it through `contracts/`.
  Product code asks `getPlatform()` for "the platform"; `app/platform.ts` decides if that is local code or an HTTP client.

## Folder map

```
src/
  app/                  composition root: server.ts, app.ts (middleware + mount routers), platform.ts (wires the port)
  config/               env.ts (validated at boot)
  contracts/            port.ts (permissions, module keys, PlatformPort), guards.ts (authenticate/permission/module), registry.ts
  shared/               shared kernel, importable by everyone, imports nothing else
    kernel/             errors, request context, money (paise)
    http/               validate, errorHandler, shared zod schemas (objectId, paging, period, password), express typings
    infra/              logger, tenantDb (database-per-organisation connection)
  core/                 Platform Core (extractable)
    modules/<module>/   see "Inside a module"
    routes.ts           composes the core modules' routers (and injects cross-module wiring)
    localPort.ts        implements the contract from the core modules' public APIs
  product/              Counselling product
    modules/<module>/
    routes.ts           composes the product modules' routers
tests/                  unit (pure logic) · architecture fence · http surface · e2e/ (real MongoDB, whole stories)
scripts/                one-off operator scripts (seed-superadmin)
docs/                   ADMIN_GUIDE, ARCHITECTURE, ROADMAP, RUNBOOK, SECURITY, adr/
```

## Modules

| Context | Module | Owns |
|---|---|---|
| core | `catalog` | what can be sold/switched on (module catalogue), roles and permissions, `resolveModules` |
| core | `audit` | platform-level audit trail |
| core | `organisations` | organisations, status, module switches, plan/price fields |
| core | `identity` | users, login/sessions, an organisation's staff, plan staff-limit enforcement |
| core | `billing` | plans, pricing, invoices, platform costs, financial dashboard |
| core | `onboarding` | use cases spanning two modules (create an organisation with its owner) |
| product | `audit` | organisation-level activity log |
| product | `leads` | enquiries, stages, assignment, consent |
| product | `ledger` | double-entry ledger (immutable, paise) |
| product | `insights` | cross-organisation research (counts only) |
| product | `followups` | tasks, reminders, activity timeline |
| product | `students` | student profiles, DPDP export and erase |
| product | `colleges` | college and course directory, shortlist |
| product | `applications` | applications and the status pipeline |
| product | `documents` | encrypted document vault, verification, signed downloads |
| product | `commissions` | commission rules, accruals, payouts (posts to the ledger) |
| product | `reports` | organisation reports (read-only, composes other modules) |
| product | `whatsapp` | WhatsApp templates, sending, automation, cost metering |
| product | `metaAds` | Meta lead ads in, conversion events out |
| product | `seoPages` | public SEO college pages and lead form |
| product | `publicApi` | API keys, public API, signed webhooks |
| product | `portal` | student and college logins (their own slice only) |
| product | `central` | platform (superadmin) view across organisations: masked leads/students/applications, document metadata only, audited. Reads each organisation through the modules' public listing functions; the audit writer is injected from `app/app.ts` |

### Inside a module

```
modules/leads/
  domain/           pure business rules. No database, no HTTP. Unit-tested. (lead.domain.ts)
  application/      use cases / services: orchestrate domain + infrastructure + other modules' public APIs
  infrastructure/   persistence: Mongoose models
  http/             routes + request validation (zod). Thin: validate -> call application -> respond
  index.ts          PUBLIC API: the only thing other modules may import
```

Dependency direction: `http → application → infrastructure` and `application → domain`. `domain` imports nothing impure.

## Rules (enforced by `tests/architecture.test.ts`, CI fails on a violation)

1. **Contexts:** `shared` imports only shared. `contracts` → shared. `core` → shared, contracts, core. `product` → shared, contracts, product. `app` → anything. So `product` never imports `core` and vice versa.
2. **Public API only:** a module imports another module only through its `index.ts`, never a deep path.
3. **Layers:** `domain` is pure (no mongoose/express/zod; only shared/kernel, contracts/port constants, and *type-only* imports of other modules). `infrastructure` never imports `application` or `http`. `application` never imports `http`.
4. **No cycles** between modules, and the **dependency graph is pinned** in the test: a new cross-module dependency is a deliberate edit in the same pull request.
5. **Data access:** tenant data only through `tenantModel()`; only `shared/infra/tenantDb.ts` knows database names.
6. **Cross-module wiring** (for example giving `billing` a staff counter from `identity`) happens in `core/routes.ts`, never inside a module.

### How to add a feature (product example: `students`)
1. `contracts/port.ts`: add the module key (and permissions). `core/modules/catalog/domain/moduleCatalog.ts`: add its catalogue entry (price, dependencies, stage).
2. `product/modules/students/{domain,application,infrastructure,http}` + `index.ts`.
3. `product/routes.ts`: one line mounting it behind `g.requireModule('students')`.
4. If another module needs it, add the edge to `PINNED` in `tests/architecture.test.ts`.
5. Tests: pure rules in `tests/`, the whole story in `tests/e2e/`.

## How modules cooperate without importing each other

- **Events** (`shared/kernel/events.ts`): fire-and-forget. `leads` announces `lead.stage_changed`; `whatsapp`, `metaAds`, `publicApi` and `followups` each listen.
- **Hooks** (`shared/kernel/hooks.ts`): ask a question. `documents` registers a guard that blocks an application from being submitted while mandatory documents are unverified; every module can add a section to a student data export.
- **Wiring** happens once, in `src/app/events.ts`. Each module declares its allowed dependencies in its own `module.json`.

## Request pipeline

```
request → requestId → helmet/cors → JSON(100kb) → rate limit
        → authenticate        who are you (token re-checked against the live user + organisation status)
        → requireTenant       are you in a counsellor organisation
        → requireModule(x)    is feature x switched on for your organisation (30 s cache)
        → requirePermission   does your role allow this action
        → validate (zod)      clean, typed input only
        → application service → audit
        → errorHandler        one error shape: { error: { code, message, details?, requestId } }
```

## Data

| Where | What | Why |
|---|---|---|
| `cp_master` | organisations, users, plans, invoices, costs, platform audit | shared, small |
| `cp_t_<tenantId>` | leads, ledger entries, activity log (students, applications, documents later) | **database per organisation**: a missing filter can never leak another organisation's data; per-organisation backup, export, delete |

## Key decisions (short)
- **Money in integer paise** (`shared/kernel/money.ts`), double-entry, immutable entries, reversal for corrections, idempotency keys.
- **Roles are bundles of permissions**; code never checks role names, only permissions.
- **Module catalogue is data**, so admin screens render from it, never hard-coded.
- **Platform research sees counts only**: `insights` has no access to other modules' models, only their count functions.
- **Fail loudly on bad config:** zod-validated env at boot.
- **Audit never blocks the user**, but a failed audit write is logged as an error for operators.

## Scaling path (when needed, in this order)
1. Move `core/` into the shared core service (flip `PLATFORM_MODE`, implement the HTTP port).
2. Redis for module/permission cache and rate limits (currently in-process, fine for one instance).
3. Queue (BullMQ) for WhatsApp, imports, webhooks; a worker process from the same codebase.
4. Read replicas / dedicated database for very large organisations (database-per-tenant makes this a config change).
5. Extract a module into a service only if it has its own scaling or compliance need (the documents vault is the likely first).

## Known limits of this cut
- Access token only (1h). Refresh tokens, MFA, SSO are on the roadmap.
- Module cache and rate limits are per instance.
- No transaction across organisation + owner creation (compensating delete in `onboarding`).
- Indexes auto-create outside production; production needs an explicit migration step (not built yet).
