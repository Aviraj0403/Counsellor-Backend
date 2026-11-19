import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import mongoose from 'mongoose';
import { tenantDbName } from '../src/shared/infra/tenantDb.js';

export interface TenantExport {
  tenantId: string;
  database: string;
  exportedAt: string;
  collections: Record<string, unknown[]>;
}

/**
 * JSON dump of ONE organisation's database (every collection, all documents), for data-portability or erasure requests.
 * Assumes mongoose is connected. Only that organisation's database is read; master data (users, invoices) is not included.
 * Note: documents in the encrypted file vault are stored as files, not in the database; export those from FILE_STORAGE_DIR.
 */
export const exportTenant = async (tenantId: string): Promise<TenantExport> => {
  const database = tenantDbName(tenantId); // validates the id
  const db = mongoose.connection.useDb(database, { useCache: true }).db!;
  const collections: Record<string, unknown[]> = {};
  for (const c of await db.listCollections().toArray()) {
    if (c.name.startsWith('system.')) continue;
    collections[c.name] = await db.collection(c.name).find({}).toArray();
  }
  return { tenantId, database, exportedAt: new Date().toISOString(), collections };
};

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const [tenantId, out] = process.argv.slice(2);
  if (!tenantId) {
    console.error('Usage: tsx scripts/export-tenant.ts <tenantId> [output-file.json]   (prints to stdout when no file is given)');
    process.exit(1);
  }
  const { env } = await import('../src/config/env.js');
  await mongoose.connect(env.MONGO_URI, { dbName: 'cp_master' });
  try {
    const json = JSON.stringify(await exportTenant(tenantId), null, 2);
    if (out) {
      writeFileSync(out, json);
      console.error(`Wrote ${out}`);
    } else process.stdout.write(json + '\n');
  } finally {
    await mongoose.disconnect();
  }
}
