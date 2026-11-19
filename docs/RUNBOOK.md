# Runbook: run, deploy, debug

Scope: this API repo (`counsellor-platform`). The admin UI is a **separate repo** (`counsellor-platform-admin`) that only
talks to this API over HTTP, so a problem is always on one side of a visible line (see "Which side is broken?").
Anything marked **[VERIFY]** depends on your hosting and must be confirmed by the operator.

## 1. Run it
```bash
cp .env.example .env     # set MONGO_URI and JWT_SECRET (32+ chars); CORS_ORIGINS must include the admin URL
npm install
npm run seed:superadmin  # once
npm run dev              # http://localhost:4100/health
```

| Variable | Notes |
|---|---|
| `MONGO_URI` | One cluster. DBs: `cp_master`, `cp_t_<tenantId>`. Same cluster as ecommerce is fine for dev only; see docs/ARCHITECTURE.md |
| `JWT_SECRET` | 32+ chars. App refuses to boot otherwise and lists what is wrong (never the values) |
| `PLATFORM_ORIGINS` | Our own web apps (default `https://counsellor.jdinfotechsolutions.in`). Always allowed. |
| `CORS_ORIGINS` | Extra origins from config (for example `http://localhost:5173`). More domains are added at runtime by the superadmin: Platform > Allowed domains (no restart). Empty everywhere = browsers are blocked. |
| `LOGIN_RATE_LIMIT_MAX` | default 10 per IP per 15 min |
| `LOG_LEVEL` | `debug` to see more; `silent` in tests |

## 2. Deploy (pm2, same as central-ecommerce)
1. `git pull`, `npm ci`, `npm run typecheck`, `npm test`, `npm run build`
2. Compare `.env` with `.env.example`
3. `pm2 reload ecosystem.config.cjs --env production` (graceful: stops accepting, finishes requests, closes Mongo; forced exit after 10 s)
4. Check `GET /health` (process up) and `GET /ready` (database connected; 503 = DB problem)

## 3. Which side is broken? (frontend repo vs API repo)
Open the browser DevTools -> Network, click the failing request:

| You see | It is | Look at |
|---|---|---|
| No request at all / red CORS error | Admin or `CORS_ORIGINS` | Is the admin origin in `PLATFORM_ORIGINS` / `CORS_ORIGINS` or in Platform > Allowed domains? Is `VITE_API_BASE_URL` right? |
| `(failed)` / timeout | API down or wrong URL | `GET /health` on the API host |
| 401 | Token missing/expired/revoked | Log in again. Revoked by: password change, logout-all, block |
| 403 `FORBIDDEN` | Role lacks the permission | `GET /api/v1/me` -> `permissions` |
| 403 `MODULE_NOT_ENABLED` | Module is off for that organisation | Superadmin -> Organisation -> Modules |
| 403 (suspended) | Organisation suspended | Superadmin -> Organisation -> Status |
| 400 `VALIDATION_ERROR` | UI sent bad input | Response `details` lists field + problem |
| 409 `CONFLICT/DUPLICATE` | Already exists (email, slug, ledger reversal) | Message says what |
| 5xx `INTERNAL_ERROR` | API bug | Use the `requestId` (below) |

## 4. Trace one request end-to-end (the main debugging tool)
Every response carries `x-request-id`, and every error body has `error.requestId`. The admin UI shows it as
"ref: <id>" on error toasts. Take that id and:
```bash
# JSON logs: every line of that request has the same requestId (plus tenantId, userId)
grep <requestId> logs/out.log          # or: pm2 logs counsellor-platform-api | grep <requestId>
```
Audit trails answer "who changed this?":
- `GET /api/v1/platform/audit?tenantId=<id>` : organisations, modules, staff changes (platform roles)
- `GET /api/v1/audit` : leads and ledger inside one organisation (owner)
Both rows carry `requestId`, so an audit row links straight to the log lines.

## 5. Debug with breakpoints (VS Code)
Open this repo's folder in VS Code -> Run and Debug:
- **API: run with debugger**: set breakpoints in any `src/**` file, hit the endpoint from the admin UI or curl.
- **Tests: debug current test file**: open a test file, run this config.
- **E2E: debug admin flow**: the full story on a temporary in-memory MongoDB, no setup needed.

Quick checks without a UI:
```bash
curl -s localhost:4100/health
curl -s -X POST localhost:4100/api/v1/auth/login -H 'content-type: application/json' -d '{"email":"...","password":"..."}'
curl -s localhost:4100/api/v1/me -H "authorization: Bearer <token>"
```

## 6. Common problems
| Symptom | Cause / fix |
|---|---|
| App exits at boot with "Invalid environment configuration" | Read the listed variables; fix `.env` |
| `/ready` is 503 | MongoDB unreachable: check `MONGO_URI`, Atlas IP allow-list, network |
| Admin shows "Network Error" but API is up | CORS: superadmin adds the exact origin in Platform > Allowed domains (works within ~60 s, no restart), or put it in `PLATFORM_ORIGINS` and restart |
| Login works but everything is 401 | Clock/secret: `JWT_SECRET` differs between instances, or token was revoked |
| A module screen is missing for a customer | Module not enabled for that organisation (or its required module is off) |
| `tsc` hangs / out of memory | Do not use generic `conn.model<T>()` from mongoose; use `tenantModel()` |
| Trial balance `isBalanced: false` | Incident: stop posting, export entries, find the entry (every entry is balanced by construction, so look for direct DB writes) |
