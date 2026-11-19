# Security & data protection

## Already in the code
- Passwords: bcrypt (cost 12); login rate-limited (10 / 15 min / IP); unknown-email and wrong-password take equal time and return the same message
- Tokens: HS256 JWT access token (ACCESS_TOKEN_TTL, 15m) + opaque refresh token (REFRESH_TOKEN_TTL_DAYS, 14d) stored only as a SHA-256 hash, rotated on every use; reuse of a spent refresh token revokes the whole login family; logout, logout-all, password change/reset and blocking revoke refresh tokens; **every request re-reads the user and organisation**, so blocking a user or suspending an organisation is immediate
- Isolation: database per organisation; tenant id validated before it is used in a database name
- Input: zod validation on every endpoint; body limit 100 kb; regex escaped in search
- Headers: helmet; CORS allow-list only; `x-powered-by` removed
- Logs: JSON, secrets redacted, every line carries requestId/tenantId/userId
- Ledger: immutable at schema level; idempotent writes
- Audit: who/what/when for lead and ledger changes
- Config: refuses to boot with a missing or short `JWT_SECRET`

## Must be done before real student data
1. **Legal review (DPDP Act 2023 + Rules 2025).** Many students are under 18: verifiable parental consent, purpose limitation, retention, breach notification and the education-sector exemption's exact scope must be confirmed by counsel. This file is engineering guidance, not legal advice; dates and exemptions were summarised from secondary sources and not checked against the gazette.
2. **Document vault** (passports, marksheets): private bucket, encryption at rest, field-level encryption for ID numbers, short-lived signed URLs, per-download audit entry, retention + deletion job.
3. ~~MFA; refresh-token rotation~~ DONE (TOTP with encrypted secret, single-use hashed recovery codes, lockout after 5 wrong codes; refresh rotation + reuse detection). STILL OPEN: make MFA mandatory for Owner, Accounts and platform roles (it is opt-in today); session list/revoke UI.
4. **Secrets** in a secret manager (not `.env`) and a rotation runbook.
5. **Backups**: automated, encrypted, restore tested quarterly; per-organisation export and erase on request.
6. **Dependency & image scanning** in CI; pin base image.
7. **Penetration test** before launch, and after the public API ships.

## Rules for contributors
- Tenant data only via `tenantModel()`. Never `mongoose.model()` for tenant data.
- New endpoint = `requirePermission` + `validate` + audit for any state change.
- Never log request bodies, tokens or document contents.
- Money is integer paise. No floats, ever.
