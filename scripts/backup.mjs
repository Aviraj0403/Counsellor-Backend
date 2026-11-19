#!/usr/bin/env node
// Wrapper around mongodump / mongorestore (MongoDB Database Tools).
//   node scripts/backup.mjs backup  [outDir]        -> writes <outDir>/cp-YYYYMMDD-HHMMSS.archive.gz (default ./backups)
//   node scripts/backup.mjs restore <file> [--drop] -> restores that archive (use a SCRATCH database/server for drills)
// Reads MONGO_URI from the environment (or .env). UNVERIFIED on this machine: mongodump is not installed here.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const loadDotEnv = () => {
  if (!existsSync('.env')) return;
  for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
};

const need = (bin) => {
  const r = spawnSync(bin, ['--version'], { encoding: 'utf8' });
  if (r.error || r.status !== 0) {
    console.error(`"${bin}" was not found. Install the MongoDB Database Tools (https://www.mongodb.com/docs/database-tools/installation/) and make sure "${bin}" is on your PATH, then run this again.`);
    process.exit(2);
  }
};

loadDotEnv();
const [cmd, arg, flag] = process.argv.slice(2);
const uri = process.env.MONGO_URI;
if (!['backup', 'restore'].includes(cmd) || !uri) {
  console.error('Usage: node scripts/backup.mjs backup [outDir] | restore <file> [--drop]   (MONGO_URI must be set)');
  process.exit(1);
}

if (cmd === 'backup') {
  need('mongodump');
  const dir = arg ?? 'backups';
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14).replace(/^(\d{8})(\d{6})$/, '$1-$2');
  const file = join(dir, `cp-${stamp}.archive.gz`);
  const r = spawnSync('mongodump', [`--uri=${uri}`, `--archive=${file}`, '--gzip'], { stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
  console.log(`Backup written: ${file}`);
} else {
  need('mongorestore');
  if (!arg || !existsSync(arg)) {
    console.error('Give the archive file to restore, e.g. node scripts/backup.mjs restore backups/cp-20261115-020000.archive.gz');
    process.exit(1);
  }
  const args = [`--uri=${uri}`, `--archive=${arg}`, '--gzip'];
  if (flag === '--drop') args.push('--drop');
  const r = spawnSync('mongorestore', args, { stdio: 'inherit' });
  process.exit(r.status ?? 1);
}
