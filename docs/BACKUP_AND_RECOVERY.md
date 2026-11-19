# Backup and recovery

STATUS: UNVERIFIED. `scripts/backup.mjs` was written but never run: mongodump / mongorestore are not installed on the development machine. Run the restore drill below once before relying on it.

## What is backed up
One MongoDB deployment holds the master database (`cp_master`: users, organisations, plans, invoices, settings, audit) and one database per organisation (`cp_t_<id>`). `mongodump --uri` of the whole deployment captures all of them. Uploaded documents live in `FILE_STORAGE_DIR` (encrypted files) and must be backed up separately (copy the directory), together with the `ENCRYPTION_KEY` kept in a secrets manager: without the key the files are unreadable.

## Commands
- Install MongoDB Database Tools (mongodump, mongorestore) on the backup host.
- Backup: `node scripts/backup.mjs backup /path/to/backups` (reads MONGO_URI; writes `cp-YYYYMMDD-HHMMSS.archive.gz`). It stops with a clear message if mongodump is missing.
- Restore: `node scripts/backup.mjs restore <file> [--drop]` (--drop replaces existing collections: use it only on a scratch or disaster-recovery target).
- Prefer a managed service with point-in-time recovery (e.g. Atlas) for production; this script is the portable fallback.

## Suggested retention
Daily backups kept 14 days, weekly kept 8 weeks, monthly kept 12 months; copy to storage in a different account/region; encrypt at rest. Delete per your data-retention policy (erasure requests also apply to old backups: they age out by retention).

## Restore drill checklist (do quarterly)
1. Pick the latest archive; note its timestamp.
2. Start a SCRATCH MongoDB (never the live one); set MONGO_URI to it.
3. `node scripts/backup.mjs restore <file>`; confirm it exits 0.
4. Start the API against the scratch database; log in as Super Admin.
5. Spot-check: organisation count, latest invoice number, one organisation's lead count, an audit row from the backup day.
6. Run `npm run db:indexes`.
7. Restore the document directory copy and open one document (needs the same ENCRYPTION_KEY).
8. Record the date, the archive, the time taken and any problems here or in the runbook.
