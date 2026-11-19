import mongoose, { type Model, type Schema } from 'mongoose';
import { badRequest } from '../kernel/errors.js';

/**
 * DATABASE-PER-ORGANISATION. Every counsellor organisation's students, leads and ledgers live in their own
 * database (cp_t_<tenantId>), so one organisation can never read another's data by a missing filter.
 * Define every tenant collection with defineTenantModel() ONCE per model file:
 *
 *     const Thing = defineTenantModel('Thing', thingSchema);   // module level
 *     Thing(tenantId).find(...)                                 // at use time
 *
 * It registers the schema (so `npm run db:indexes` can build indexes in EVERY organisation's database) and returns the accessor.
 * Never build a model on the default connection for tenant data.
 */
const OBJECT_ID = /^[a-f\d]{24}$/i;

const registry = new Map<string, Schema<any>>();

/** Every tenant schema defined so far (name -> schema). Used by the index sync and export scripts. */
export const allTenantSchemas = (): ReadonlyMap<string, Schema<any>> => registry;

export const tenantDbName = (tenantId: string): string => {
  if (!OBJECT_ID.test(tenantId)) throw badRequest('Invalid organisation.'); // never put unchecked text into a db name
  return `cp_t_${tenantId}`;
};

// Deliberately loosely typed: mongoose's generic model<T>(name, schema) overloads make the TypeScript compiler
// hang (infinite instantiation). Document shapes are validated by the schema and zod, not by this generic.
export const tenantModel = (tenantId: string, name: string, schema: Schema<any>): Model<any> => {
  const conn = mongoose.connection.useDb(tenantDbName(tenantId), { useCache: true });
  const existing: Model<any> | undefined = (conn.models as Record<string, Model<any> | undefined>)[name];
  return existing ?? (conn.model(name, schema as any) as unknown as Model<any>);
};

export const defineTenantModel = (name: string, schema: Schema<any>): ((tenantId: string) => Model<any>) => {
  registry.set(name, schema);
  return (tenantId: string) => tenantModel(tenantId, name, schema);
};
