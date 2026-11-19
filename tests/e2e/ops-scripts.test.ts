import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let mongod: MongoMemoryServer;
const T1 = '64b000000000000000000001';
const T2 = '64b000000000000000000002';

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri(), { dbName: 'cp_master' });
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongod?.stop();
});

describe('ops scripts', () => {
  it('sync-indexes builds indexes in the master and in every organisation database', async () => {
    const { syncAllIndexes } = await import('../../scripts/sync-indexes.js');
    const { Tenant } = await import('../../src/core/modules/organisations/infrastructure/tenant.model.js');
    const { allTenantSchemas } = await import('../../src/shared/infra/tenantDb.js');
    await Tenant.create([{ _id: T1, name: 'One', slug: 'one-org' }, { _id: T2, name: 'Two', slug: 'two-org' }]);

    const report = await syncAllIndexes();
    expect(report.masterModels).toContain('Invoice');
    expect(report.tenants.map((t) => t.tenantId).sort()).toEqual([T1, T2]);
    expect(allTenantSchemas().size).toBeGreaterThan(0);
    for (const t of report.tenants) expect(t.models.length).toBe(allTenantSchemas().size);

    // the unique phone index on leads really exists in BOTH organisation databases
    for (const id of [T1, T2]) {
      const idx = await mongoose.connection.useDb(`cp_t_${id}`).db!.collection('leads').indexes();
      expect(idx.some((i) => i.unique && i.key && (i.key as any).phone === 1)).toBe(true);
    }
    const master = await mongoose.connection.db!.collection('invoices').indexes();
    expect(master.some((i) => i.unique && (i.key as any).invoiceNo === 1)).toBe(true);
    await syncAllIndexes(); // idempotent
  });

  it('export-tenant dumps only that organisation database', async () => {
    const { exportTenant } = await import('../../scripts/export-tenant.js');
    await mongoose.connection.useDb(`cp_t_${T1}`).db!.collection('leads').insertOne({ name: 'Asha', phone: '+911111111111' });
    await mongoose.connection.useDb(`cp_t_${T2}`).db!.collection('leads').insertOne({ name: 'Ravi', phone: '+912222222222' });

    const out = await exportTenant(T1);
    expect(out.tenantId).toBe(T1);
    expect(out.database).toBe(`cp_t_${T1}`);
    const json = JSON.stringify(out);
    expect(json).toContain('Asha');
    expect(json).not.toContain('Ravi');
    expect(out.collections.leads).toHaveLength(1);
    await expect(exportTenant('not-an-id')).rejects.toThrow();
  });
});
