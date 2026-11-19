import { getPlatform } from '../../../../contracts/registry.js';
import type { ModuleKey, TenantSummary } from '../../../../contracts/port.js';
import { logger } from '../../../../shared/infra/logger.js';
import type { CentralFilters, CentralPageOf } from '../../../../shared/kernel/central.js';
import { badRequest, notFound } from '../../../../shared/kernel/errors.js';
import { applicationCountsByStatus, listApplicationsForCentral } from '../../applications/index.js';
import { countUpcomingAppointments } from '../../appointments/index.js';
import { documentCountsByStatus, listDocumentsForCentral } from '../../documents/index.js';
import { countLeads, listLeadsForCentral } from '../../leads/index.js';
import { countStudents, listStudentsForCentral } from '../../students/index.js';
import { depthProblem, mergePage, maskEmail, maskPhone, MAX_ORGANISATIONS, parseDay, sumRecords, sumRecordValues, type CentralResource } from '../domain/central.domain.js';

/**
 * CENTRAL DATA: a read-only platform view over every organisation while the data stays in each organisation's own database.
 * It only calls the other modules' public functions, one organisation at a time, with identical filters, and never an organisation
 * whose module is switched off. Personal data is masked here; documents are metadata only (the listing function cannot return more).
 */
export interface CentralQuery {
  page: number;
  limit: number;
  tenantId?: string;
  status?: string;
  q?: string;
  createdFrom?: string;
  createdTo?: string;
  counsellor?: string;
}

const MODULE_FOR: Record<CentralResource, ModuleKey> = { leads: 'leads', students: 'students', applications: 'applications', documents: 'documents' };
const CONCURRENCY = 5;

const inChunks = async <T, R>(items: T[], fn: (x: T) => Promise<R>): Promise<R[]> => {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += CONCURRENCY) out.push(...(await Promise.all(items.slice(i, i + CONCURRENCY).map(fn))));
  return out;
};

const organisationOf = (t: TenantSummary) => ({ id: t.id, name: t.name, slug: t.slug ?? null, logoUrl: t.logoUrl ?? null, status: t.status });

/** The organisations to read: all, or just one; only those with at least one of `needed` switched on; at most MAX_ORGANISATIONS. */
const pickOrganisations = async (tenantId: string | undefined, needed: ModuleKey[]) => {
  let tenants = await getPlatform().listTenants();
  if (tenantId) {
    tenants = tenants.filter((t) => t.id === tenantId);
    if (!tenants.length) throw notFound('Organisation');
  }
  const enabled = await inChunks(tenants, async (t) => ({ t, modules: await getPlatform().enabledModules(t.id) }));
  const eligible = enabled.filter((e) => needed.some((k) => e.modules[k]));
  const picked = eligible.slice(0, MAX_ORGANISATIONS);
  return {
    organisations: picked,
    meta: { total: tenants.length, read: picked.length, skippedModuleOff: tenants.length - eligible.length, truncated: eligible.length > MAX_ORGANISATIONS },
  };
};

/** Staff names by id, and the ids matching the counsellor filter (an id, or part of a name). */
const teamLookup = async (tenantId: string, counsellor?: string) => {
  const team = await getPlatform().listTeam(tenantId);
  const names = new Map(team.map((m) => [m.id, m.name]));
  const needle = counsellor?.toLowerCase();
  const ids = needle ? team.filter((m) => m.id === counsellor || m.name.toLowerCase().includes(needle)).map((m) => m.id) : undefined;
  return { names, ids };
};

const counsellorOf = (names: Map<string, string>, id?: string | null) => (id ? { id, name: names.get(id) ?? null } : null);

type Row = { id: string; createdAt: Date };
interface Listing<T extends Row> {
  list: (tenantId: string, f: CentralFilters, take: number) => Promise<CentralPageOf<T>>;
  shape: (row: T, names: Map<string, string>) => Record<string, unknown>;
  /** needs the staff list (names, counsellor filter) */
  team: boolean;
}

const LISTINGS: Record<CentralResource, Listing<any>> = {
  leads: {
    list: listLeadsForCentral,
    team: true,
    shape: (l, names) => ({
      id: l.id,
      name: l.name,
      phone: maskPhone(l.phone),
      email: maskEmail(l.email),
      city: l.city ?? null,
      interestedCourse: l.interestedCourse ?? null,
      channel: l.channel ?? null,
      status: l.stage,
      counsellor: counsellorOf(names, l.assignedTo),
      createdAt: l.createdAt,
    }),
  },
  students: {
    list: listStudentsForCentral,
    team: true,
    shape: (s, names) => ({
      id: s.id,
      name: s.name,
      phone: maskPhone(s.phone),
      email: maskEmail(s.email),
      city: s.city ?? null,
      status: s.status,
      counsellor: counsellorOf(names, s.assignedTo),
      createdAt: s.createdAt,
    }),
  },
  applications: {
    list: listApplicationsForCentral,
    team: true,
    shape: (a, names) => ({
      id: a.id,
      studentId: a.studentId,
      studentName: a.studentName ?? null,
      collegeName: a.collegeName ?? null,
      courseName: a.courseName ?? null,
      intake: a.intake,
      status: a.status,
      counsellor: counsellorOf(names, a.assignedTo),
      createdAt: a.createdAt,
    }),
  },
  documents: {
    list: listDocumentsForCentral,
    team: false,
    // METADATA ONLY. Explicit allow-list: a field added to the module row never leaks here by accident.
    shape: (d) => ({ id: d.id, type: d.type, status: d.status, studentId: d.studentId, studentName: d.studentName ?? null, applicationId: d.applicationId ?? null, uploadedAt: d.uploadedAt }),
  },
};

export const listCentral = async (resource: CentralResource, q: CentralQuery) => {
  const tooDeep = depthProblem(q.page, q.limit);
  if (tooDeep) throw badRequest(tooDeep);
  const from = parseDay(q.createdFrom, false);
  const to = parseDay(q.createdTo, true);
  if (from === null || to === null) throw badRequest('Use dates like 2026-11-01.');

  const { organisations, meta } = await pickOrganisations(q.tenantId, [MODULE_FOR[resource]]);
  const listing = LISTINGS[resource];
  const needed = MODULE_FOR[resource];
  const take = q.page * q.limit;
  const failed: string[] = [];

  const perOrg = await inChunks(organisations.filter((o) => o.modules[needed]), async ({ t }) => {
    try {
      const team = listing.team || q.counsellor ? await teamLookup(t.id, q.counsellor) : { names: new Map<string, string>(), ids: undefined };
      if (q.counsellor && !team.ids?.length) return { t, rows: [] as Row[], total: 0, names: team.names };
      const filters: CentralFilters = { status: q.status, q: q.q, createdFrom: from ?? undefined, createdTo: to ?? undefined, assignedTo: team.ids };
      const res = await listing.list(t.id, filters, take);
      return { t, rows: res.items as Row[], total: res.total, names: team.names };
    } catch (err) {
      logger.error({ err, tenantId: t.id, resource }, 'central: reading one organisation failed');
      failed.push(t.id);
      return { t, rows: [] as Row[], total: 0, names: new Map<string, string>() };
    }
  });

  // tag each row with its organisation before merging; the merge only needs id + createdAt
  const tagged = perOrg.map((o) => o.rows.map((r) => ({ ...r, __o: o })));
  const slice = mergePage(tagged, q.page, q.limit);
  const total = perOrg.reduce((n, o) => n + o.total, 0);
  return {
    items: slice.map((r) => ({ ...listing.shape(r, r.__o.names), organisation: organisationOf(r.__o.t) })),
    page: q.page,
    limit: q.limit,
    total,
    hasMore: q.page * q.limit < total,
    truncated: meta.truncated,
    partial: failed.length > 0,
    organisations: { ...meta, failed: failed.length },
    note: 'Phones and emails are masked and documents show metadata only. Open the organisation to see full detail (audited).',
  };
};

const sumOrNull = (v: number | null, add: number | null) => (add === null ? v : (v ?? 0) + add);

export const centralSummary = async (tenantId?: string) => {
  const { organisations, meta } = await pickOrganisations(tenantId, ['leads', 'students', 'applications', 'documents', 'appointments']);
  const failed: string[] = [];
  const rows = await inChunks(organisations, async ({ t, modules }) => {
    try {
      const [leads, students, appStatus, docStatus, upcoming] = await Promise.all([
        modules.leads ? countLeads(t.id) : null,
        modules.students ? countStudents(t.id) : null,
        modules.applications ? applicationCountsByStatus(t.id) : null,
        modules.documents ? documentCountsByStatus(t.id) : null,
        modules.appointments ? countUpcomingAppointments(t.id) : null,
      ]);
      return {
        organisation: organisationOf(t),
        leads,
        students,
        applications: appStatus ? { total: sumRecordValues(appStatus), byStatus: appStatus } : null,
        documents: docStatus ? { total: sumRecordValues(docStatus), byStatus: docStatus } : null,
        appointmentsUpcoming: upcoming,
      };
    } catch (err) {
      logger.error({ err, tenantId: t.id }, 'central: summary of one organisation failed');
      failed.push(t.id);
      return null;
    }
  });
  const ok = rows.filter((r): r is NonNullable<typeof r> => !!r);
  const totals = ok.reduce(
    (acc, r) => ({
      leads: sumOrNull(acc.leads, r.leads),
      students: sumOrNull(acc.students, r.students),
      applications: sumOrNull(acc.applications, r.applications?.total ?? null),
      documents: sumOrNull(acc.documents, r.documents?.total ?? null),
      documentsByStatus: r.documents ? sumRecords(acc.documentsByStatus, r.documents.byStatus) : acc.documentsByStatus,
      appointmentsUpcoming: sumOrNull(acc.appointmentsUpcoming, r.appointmentsUpcoming),
    }),
    { leads: null as number | null, students: null as number | null, applications: null as number | null, documents: null as number | null, documentsByStatus: {} as Record<string, number>, appointmentsUpcoming: null as number | null },
  );
  return { organisations: ok, totals, truncated: meta.truncated, partial: failed.length > 0, organisationCounts: { ...meta, failed: failed.length } };
};
