# Meta sync: ecommerce vs counselling platform

Goal: Meta works here the way it already works in the ecommerce project (connection, daily insights, alerts), without breaking this platform's rules (database per organisation, module flags, shared infra only).

Reference (read only): `central-ecommerce/src/marketing/meta/{connection,graphClient,insightsSync,alerts,campaignDraft}.ts`, `models/metaInsightDaily.model.ts`, `marketing/{superadmin.routes,capi,attribution}.ts`.
Ours: `src/product/modules/metaAds`.

IMPORTANT: nothing here has been run against the real Meta API. Everything is tested with a fake Graph (`setHttpClient`). Field names, error codes and paging follow Meta's documentation and the ecommerce code that already runs in production, but the first real run must be watched.

## Comparison

| Part | Ecommerce | Ours (before) | Ours (now) | Decision |
|---|---|---|---|---|
| Connection storage | Platform-wide agency token (`PlatformConfig metaAgency`) plus optional per-tenant override (`MarketingConfig.metaTokenEnc`); ad account id per tenant | Per organisation `MetaConfig`: pixel, page, token, verify token | Same `MetaConfig` plus ad account ids (up to 10), API version, token hint | BUILT. Per organisation only (no shared agency token) because every organisation owns its Meta account |
| Token encryption | AES (`secretBox`), masked hint | AES-256-GCM via `shared/infra/crypto`, only `tokenSet` returned | Same, plus masked hint (last 4 characters only) | BUILT |
| Test connection | Graph `/me` and `/me/adaccounts` | Sends a CAPI test event only | `POST /integrations/meta/connection/test`: `/me`, `/me/adaccounts`, shows which saved ad accounts the token can see and their currency | BUILT |
| Ad account mapping per tenant | `adAccountId` in tenant config | none | `adAccountIds` per organisation, normalised to `act_<digits>` | BUILT |
| Daily insights sync | `MetaInsightDaily`, first run 30 days, later 3 days, upsert on (tenant, date, campaign), paging, rate-limit backoff | none | `MetaInsightDaily` in the organisation's own database, same 30 / 3 day rule, unique (date, campaignId), paging with `access_token` stripped | BUILT, except backoff (below) |
| Money | Rupees as number | n/a | Integer paise. Non-INR accounts: spend kept in minor units, `currencyMismatch` flag, excluded from cost figures | BUILT (stricter than ecommerce) |
| Metric parsing | `pickAction`: first matching action type, never summed (purchases, cart, checkout) | n/a | Same `pickAction` for leads: `lead`, `onsite_conversion.lead_grouped`, `offsite_conversion.fb_pixel_lead`, `leadgen_grouped` | BUILT (leads instead of purchases) |
| Attribution of results to campaigns | UTM / click id on orders joined to campaigns | Lead utm kept: ad id and form id only | `MetaLeadLink` stores campaign, adset, ad and form id for every lead that arrives through the lead-ads webhook (taken from the lead Meta returns). `GET /performance` shows Meta leads next to platform leads per campaign | BUILT for lead ads. SKIPPED: leads from website forms with UTM (needs a campaign id in the URL and a change in the leads module) |
| Conversions API | Server events with hashing | Already built (hashed Lead / QualifiedLead / Admission events) | Unchanged | EXISTS |
| Alerts | 6 types (pacing, ROAS, CPO, no purchases, tracking silent, sync failed), stored with status | none | 3 rules: sync failing for 2 or more runs, token invalid (error 190), spend today with no leads in 3 days. Stored in `MetaAlert`, one open alert per rule, audited when first raised, closed when the condition clears. Shown by `GET /status` | BUILT (3 of 6). SKIPPED: pacing, ROAS, CPO, tracking silent (need monthly budget and target settings, or order revenue; not meaningful for a lead-gen product yet) |
| Alert acknowledge / resolve by hand | yes | none | none, alerts close themselves | SKIPPED (kept simple) |
| Cron | Daily job 02:30 IST inside the process | n/a | `POST /public/meta/jobs/sync-all`, header `x-jobs-secret` (same `JOBS_SECRET` rule as the appointment reminders: 503 if unset or shorter than 16 characters, 401 if wrong). Every organisation with the module on, a token and an ad account is synced; one failure never stops the others; safe to run twice. Schedule it from your cron / pm2 (suggested 02:30 IST) | BUILT |
| Superadmin overview | Tenant list with sync status in the superadmin app | none | `GET /api/v1/platform/meta/overview` (permission `platform:insights:read`, same as the existing research endpoints): per organisation connected, last sync, last error, 30-day spend and leads. The module reads each organisation's own database through its own models, like `insights` does | BUILT |
| Campaign drafts (create paused campaign) | `campaignDraft.ts`, behind a flag, marked "not verified on a live account" | none | none | SKIPPED: it writes to a customer's ad account with `ads_management`, needs Meta Advanced Access and review, and the ecommerce version itself is unverified. Not worth the risk before the read-only sync is proven |
| Rate-limit backoff | 2 s, 4 s, 8 s retries | n/a | none: a rate-limit answer is reported as "rate limit" and retried on the next run | SKIPPED: a daily job per organisation is far below Meta's limits; the next run is the retry |
| Use of `recordUsage` | n/a | n/a | not used | SKIPPED: reading insights from Meta costs the platform nothing |

## How it behaves

- Routes (all under `/api/v1/integrations/meta`, permission `integrations:manage`, module `metaAds`): `PUT /config` (now also `adAccountIds`, `apiVersion`), `POST /connection/test`, `GET /status`, `POST /sync` (optional `{days: 1..90}`), `GET /performance?from=yyyy-mm-dd&to=yyyy-mm-dd` (default last 30 days, at most a year).
- Public: `POST /public/meta/jobs/sync-all`. Platform: `GET /api/v1/platform/meta/overview`.
- The token goes to Meta in the `Authorization` header (never in a URL) and is never in a response, an error message, an audit row or a log. The older lead-ad fetch still puts the token in the URL as before (unchanged).
- First sync (or after the ad account list changes) pulls 30 days; later runs pull the last 3 days again because Meta restates numbers. Rows are upserted on (date, campaignId), so repeating a sync never duplicates.
- Dates: windows and "today" use the IST calendar day. Meta's `date_start` is in the ad account's own time zone and is stored as given; this assumes the ad account is set to India time.
- Performance: platform leads per campaign are counted from `MetaLeadLink` (this module's own data), not from the leads module. Leads whose campaign Meta did not return are counted in `unattributedPlatformLeads`. Cost per lead is whole paise: spend divided by Meta leads, and also by platform leads.
- Existing behaviour is unchanged: lead creation, utm fields, Conversions API, `/config`, `/test`, `/events`.

## Known limits

- Not run against the real Meta API (see above). In particular `campaign_id` on the lead returned by `GET /{leadgen_id}` is relied on for linking; if Meta omits it, the lead is counted as unattributed and nothing breaks.
- Only campaign level, daily. No ad set / ad breakdown yet.
- The 3 alert rules are fixed in code (`ALERT_RULES`), not per organisation.
