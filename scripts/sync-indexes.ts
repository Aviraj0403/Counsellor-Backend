import { pathToFileURL } from 'node:url';
import mongoose from 'mongoose';
// Importing the app registers EVERY model and tenant schema (defineTenantModel runs at module level).
import '../src/app/app.js';
import { listTenantRecords } from '../src/core/modules/organisations/index.js';
import { allTenantSchemas, tenantModel } from '../src/shared/infra/tenantDb.js';

export interface SyncReport {
  masterModels: string[];
  tenants: Array<{ tenantId: string; models: string[] }>;
}

/**
 * Builds/updates indexes (and drops indexes no longer in the schema) for the master models and for every
 * organisation's database. Assumes mongoose is already connected to the master database.
 * Run after deploys that change indexes: `npm run db:indexes`.
 */
export const syncAllIndexes = async (log: (m: string) => void = () => {}): Promise<SyncReport> => {
  const report: SyncReport = { masterModels: [], tenants: [] };
  for (const name of mongoose.modelNames()) {
    await mongoose.model(name).syncIndexes();
    report.masterModels.push(name);
    log(`master: ${name}`);
  }
  for (const t of await listTenantRecords()) {
    const tenantId = String(t._id);
    const models: string[] = [];
    for (const [name, schema] of allTenantSchemas()) {
      await tenantModel(tenantId, name, schema).syncIndexes();
      models.push(name);
    }
    report.tenants.push({ tenantId, models });
    log(`tenant ${tenantId} (${t.name}): ${models.length} models`);
  }
  return report;
};

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const { env } = await import('../src/config/env.js');
  await mongoose.connect(env.MONGO_URI, { dbName: 'cp_master' });
  try {
    const r = await syncAllIndexes((m) => console.log(m));
    console.log(`Done: ${r.masterModels.length} master models, ${r.tenants.length} organisations.`);
  } finally {
    await mongoose.disconnect();
  }
}
