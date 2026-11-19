# Roadmap

## Built (all modules are live in the catalogue)
- Platform: organisations, plans, per-module switches, roles/permissions, staff seats, billing (plans, negotiated prices, GST invoices with CGST/SGST/IGST, PDF, Razorpay link), platform costs (manual + automatic WhatsApp metering), financial dashboard, cross-organisation research (counts only), platform audit.
- Login security: refresh-token rotation with reuse detection, TOTP MFA, rate limits, immediate revoke.
- Counselling product: leads (+ Excel/CSV import), follow-ups, students (DPDP export/erase), colleges, applications (status machine), document vault (encrypted, verified, signed downloads), ledger, commissions, reports, WhatsApp, Meta Ads, SEO pages, public API + webhooks, student and college portals.
- Engineering: module architecture with enforced rules, 185 unit + 267 end-to-end tests, ops scripts (index sync, tenant export, backup wrapper).

## Next (in order)
1. **Go live safely:** work through docs/GO_LIVE_CHECKLIST.md (real Atlas, credentials, restore drill, legal review, browser click-through).
2. Scheduler/worker (webhook retries, delayed WhatsApp, reminders), Redis for rate limits and caches, S3/Blob file store, virus scanning.
3. Reports completion (date ranges everywhere, per-counsellor metrics) and the SEO course table.
4. Enterprise: mandatory MFA policy, session list/revoke UI, SSO, remote Platform Core service, key rotation, audit export.
5. Growth: college self-serve onboarding, payment collection from students, more languages, mobile app.
