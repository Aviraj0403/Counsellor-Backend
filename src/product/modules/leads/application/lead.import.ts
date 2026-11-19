import { getPlatform } from '../../../../contracts/registry.js';
import type { Principal } from '../../../../contracts/port.js';
import { publish } from '../../../../shared/kernel/events.js';
import { audit } from '../../audit/index.js';
import { LeadModel } from '../infrastructure/lead.model.js';
import { pickAssignee, validateImportRows, type ImportRowInput } from '../domain/lead.domain.js';

export interface ImportInput {
  rows: ImportRowInput[];
  channel: 'import';
  autoAssign?: boolean;
  consentGiven: true;
  dryRun?: boolean;
}

export interface ImportReport {
  total: number;
  created: number;
  duplicates: number;
  invalid: { row: number; reason: string }[];
  dryRun: boolean;
}

/** Bulk import. Duplicates (already in the organisation, or repeated inside the file) are skipped, never overwritten. */
export const importLeads = async (p: Principal, input: ImportInput): Promise<ImportReport> => {
  const tenantId = p.tenantId!;
  const dryRun = !!input.dryRun;
  const Lead = LeadModel(tenantId);
  const { valid, invalid, duplicateRows } = validateImportRows(input.rows);
  let duplicates = duplicateRows.length;

  const existing = new Set<string>(
    (await Lead.find({ phone: { $in: valid.map((v) => v.phone) } }, { phone: 1 }).lean<any[]>()).map((d) => d.phone as string),
  );
  const fresh = valid.filter((v) => !existing.has(v.phone));
  duplicates += valid.length - fresh.length;

  let created = fresh.length;
  if (!dryRun && fresh.length) {
    // Spread new leads over counsellors by running open load, so a 1000-row file does not all land on one person.
    let nextAssignee: () => string | undefined = () => (p.role === 'counsellor' ? p.userId : undefined);
    if (input.autoAssign) {
      const team = await getPlatform().listTeam(tenantId, ['counsellor']);
      const rows = await Lead.aggregate([
        { $match: { stage: { $nin: ['admitted', 'lost'] }, assignedTo: { $exists: true } } },
        { $group: { _id: '$assignedTo', n: { $sum: 1 } } },
      ]);
      const load = new Map<string, number>(rows.map((r: any) => [String(r._id), r.n as number]));
      const candidates = team.map((m) => ({ id: m.id, openLeads: load.get(m.id) ?? 0 }));
      nextAssignee = () => {
        const id = pickAssignee(candidates);
        const c = candidates.find((x) => x.id === id);
        if (c) c.openLeads += 1;
        return id;
      };
    }
    const now = new Date();
    const docs = fresh.map((v) => ({
      name: v.name,
      phone: v.phone,
      email: v.email,
      city: v.city,
      interestedCourse: v.interestedCourse,
      source: { channel: input.channel },
      consent: { given: true, source: 'import', at: now },
      assignedTo: nextAssignee(),
      createdBy: p.userId,
    }));
    let inserted: any[];
    try {
      inserted = await Lead.insertMany(docs, { ordered: false });
    } catch (err: any) {
      // A parallel import created the same phone between our check and insert: keep what went in, count the rest as duplicates.
      if (!Array.isArray(err?.insertedDocs)) throw err;
      inserted = err.insertedDocs;
    }
    created = inserted.length;
    duplicates += fresh.length - created;
    await audit(tenantId, { action: 'lead.imported', entity: 'lead', meta: { total: input.rows.length, created, duplicates, invalid: invalid.length, autoAssign: !!input.autoAssign } });
    for (const d of inserted) await publish('lead.created', { tenantId, leadId: String(d._id), channel: input.channel, actorId: p.userId });
  }

  return { total: input.rows.length, created, duplicates, invalid, dryRun };
};
