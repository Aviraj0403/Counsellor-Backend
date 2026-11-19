# Roadmap

Everything below ships **dark** behind a module flag and is switched on per organisation. Estimates are rough and assume a small team.

## Done in this foundation
- Project skeleton, validated config, structured logging, request ids, standard errors
- Platform contract + local core: login, organisations, module switches, roles/permissions, team
- Leads: capture, phone normalisation, duplicate protection, stage rules, auto-assign, counsellor data scope, consent field
- Ledger: double-entry, integer paise, immutable, reversal, idempotency, balance, trial balance, entries list
- Plans, negotiated pricing, staff limit, monthly invoices (GST), platform costs, financial dashboard, cross-organisation research (counts only)
- Audit trail, tests, CI, Docker

## Next (in order)
| # | Phase | Includes | Rough |
|---|---|---|---|
| 1 | CRM hardening | Excel import, follow-up tasks + reminders, call/WhatsApp log, saved views, Meta Lead Ads webhook | 3-4 wks |
| 2 | Admission engine | Student profile, college directory, applications, document checklist + verify flow | 6-8 wks |
| 3 | Finance | Commission rules per college, counsellor payouts, GST invoice, Razorpay collection | 4-6 wks |
| 4 | Connect | API keys, versioned public API, webhooks, college portal, bulk status upload | 6-8 wks |
| 5 | Growth | Meta CAPI on lead stage events, SEO college pages, UTM cost tracking, WhatsApp automation | 4-6 wks |
| 6 | Superadmin intelligence (started) | Done: costs, revenue, margin, source conversion. Next: automatic cost metering (WhatsApp/SMS/AI), college conversion research once colleges exist, payment-gateway collection of invoices (code + fake-client tests done; needs real Razorpay keys to verify), PDF invoices (done) | ongoing |
| 7 | Enterprise | Refresh tokens + MFA, SSO, Redis cache, queue + worker, remote Platform Core, per-tenant export/delete | as needed |

## Before the first paying customer
- [ ] Legal review of DPDP obligations (minors, consent, retention, breach notification)
- [ ] Encrypted document storage + signed short-lived URLs (do not reuse public image hosting)
- [ ] Automated backups + a tested restore (wrapper `scripts/backup.mjs` + docs/BACKUP_AND_RECOVERY.md written, UNVERIFIED: mongodump not installed here; schedule + restore drill still to do)
- [x] Production index migration step (`npm run db:indexes`)
- [ ] Decide ownership/commission rule when two organisations get the same student
