# Go-live checklist (what still needs a human, credentials or a decision)

Everything below is **built and tested with fakes / an in-memory MongoDB**. None of it has been run against the real
outside service. Tick each line only after you have seen it work for real.

## 1. Environment and data
- [ ] Real MongoDB (Atlas): set `MONGO_URI`; dedicated DB user; backups on; **run a restore drill** (docs/BACKUP_AND_RECOVERY.md was never executed: `mongodump` is not installed on the build machine).
- [ ] `npm run db:indexes` once per environment (production does not auto-create indexes).
- [ ] `JWT_SECRET` (32+), `ENCRYPTION_KEY` (64 hex; **losing it makes every stored document unreadable**: store it in a secret manager and back it up separately), `FILE_STORAGE_DIR` on encrypted disk with backups (or add an S3/Blob `FileStore`).
- [ ] `PLATFORM_ORIGINS=https://counsellor.jdinfotechsolutions.in`, `PUBLIC_BASE_URL=https://apicounsellor.jdinfotechsolutions.in`. Extra admin / portal / organisation domains: add from the superadmin console (Platform > Allowed domains), then point their DNS to the hosting.
- [ ] Decide `ENCRYPTION_KEY` rotation procedure (not built).

## 2. Money
- [ ] Accountant confirms GST rate (18%), invoice format, CGST/SGST vs IGST rule and the company GSTIN/address entered in Company settings.
- [ ] Razorpay: `RAZORPAY_KEY_ID/SECRET/WEBHOOK_SECRET`, webhook configured in the Razorpay dashboard, one real test payment. The adapter follows the documented payment-links API from memory.
- [ ] Commission rules reviewed with a real college agreement before the first accrual.

## 3. Channels (need real accounts)
- [ ] **Meta:** app + page subscription, `META_APP_SECRET`, per-organisation pixel + token + verify token, one real lead-form test and one test event (Events Manager).
- [ ] **WhatsApp Cloud API:** `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_VERIFY_TOKEN`; **message templates approved by Meta**; check the real per-message price and set `WHATSAPP_COST_PER_MESSAGE_PAISE`.
- [ ] Outgoing webhooks: test against a real receiver. The SSRF guard does not resolve DNS (a hostname pointing at a private IP is not blocked) and redirects are followed: harden before exposing to untrusted customers.

## 4. Things that need a scheduler (not built)
- [ ] Retrying failed webhook deliveries (`retryDueDeliveries`) and sending delayed WhatsApp messages (`dispatchDue`) only run when staff press the button or you call the endpoints: add a cron / worker.
- [ ] Follow-up reminders are visible in "My tasks" but nothing pushes them (WhatsApp/email reminder job).

## 5. Security and compliance
- [ ] **Legal review of DPDP** (minors, consent, retention, breach notification, whether the education exemption applies). Export and erase exist; retention periods and breach process are policy work.
- [ ] Decide whether MFA is **mandatory** for Owner, Accounts and platform roles (built as optional).
- [ ] Penetration test, including the public API, signed document links, portals and webhooks.
- [ ] Virus scanning for uploaded documents (hook not built; files are type-checked by content and encrypted).
- [ ] Rate limits and the module cache are per instance: put Redis in front before running more than one API instance.

## 6. Product gaps to know about
- [ ] SEO college pages: the course table is empty until `listCourses` is added to the public exports of the `colleges` module (one line; the page code already uses it when present).
- [ ] Reports: date range applies to revenue only; per-counsellor leads / admitted / commission and time-to-first-contact need count exports (with a range) from leads, applications and commissions.
- [ ] Staff cannot see their organisation's public slug in the UI (they type it into SEO settings).
- [ ] Re-inviting a portal user whose login was disabled needs an "enable user" call on the platform contract.
- [ ] No automated browser tests for the admin UI: **click through every screen once** (nothing has been opened in a browser).
- [ ] Translations: the menu, header, sign-in and page titles are English + Hindi; screen bodies are English.
