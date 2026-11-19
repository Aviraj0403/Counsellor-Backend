import { systemPrincipal } from '../../../../contracts/system.js';
import { forbidden, notFound } from '../../../../shared/kernel/errors.js';
import { changeApplicationStatus, getApplication, listApplicationsForCollege } from '../../applications/index.js';
import { audit } from '../../audit/index.js';
import { listActiveColleges } from '../../colleges/index.js';
import { createLead } from '../../leads/index.js';
import type { KeyContext } from './apiKey.service.js';

const collegeView = (c: any) => ({
  id: String(c._id),
  name: c.name,
  slug: c.slug,
  type: c.type,
  city: c.city ?? null,
  state: c.state ?? null,
  country: c.country ?? null,
  website: c.website ?? null,
  affiliation: c.affiliation ?? null,
  description: c.description ?? null,
});

/** Public application view: ids and status only. No student personal data and no fees. */
const applicationView = (a: any) => ({ id: a.id, studentId: a.studentId, courseId: a.courseId, intake: a.intake ?? null, status: a.status, collegeRef: a.collegeRef ?? null });

export const publicCreateLead = async (
  ctx: KeyContext,
  input: { name: string; phone: string; email?: string; city?: string; interestedCourse?: string; utmSource?: string; utmMedium?: string; utmCampaign?: string; consent: { given: true; source?: string } },
) => {
  const out = await createLead(systemPrincipal(ctx.tenantId, `api:${ctx.keyName}`), {
    name: input.name,
    phone: input.phone,
    email: input.email,
    city: input.city,
    interestedCourse: input.interestedCourse,
    source: { channel: 'api', utmSource: input.utmSource, utmMedium: input.utmMedium, utmCampaign: input.utmCampaign },
    consent: { given: true, source: input.consent.source ?? `api:${ctx.keyName}` },
  });
  return { id: String(out.lead._id), duplicate: out.duplicate };
};

export const publicListColleges = async (ctx: KeyContext) => {
  const all = await listActiveColleges(ctx.tenantId);
  const mine = ctx.collegeId ? all.filter((c) => String(c._id) === ctx.collegeId) : all; // a college key sees only its own college
  return { items: mine.map(collegeView) };
};

const needCollege = (ctx: KeyContext): string => {
  if (!ctx.collegeId) throw forbidden('This API key is not tied to a college.');
  return ctx.collegeId;
};

export const publicListApplications = async (ctx: KeyContext, q: { status?: string; page?: number; limit?: number }) => {
  const rows = await listApplicationsForCollege(ctx.tenantId, needCollege(ctx), q);
  return { items: rows.map(applicationView) };
};

export const publicChangeStatus = async (ctx: KeyContext, id: string, to: string, note?: string) => {
  const collegeId = needCollege(ctx);
  const a = await getApplication(ctx.tenantId, id);
  if (!a || a.collegeId !== collegeId) throw notFound('Application'); // another college's application looks the same as a missing one
  await changeApplicationStatus(systemPrincipal(ctx.tenantId, `api:${ctx.keyName}`), id, to, note);
  await audit(ctx.tenantId, { action: 'publicapi.application_status', entity: 'application', entityId: id, meta: { key: ctx.keyName, from: a.status, to } });
  return applicationView((await getApplication(ctx.tenantId, id))!);
};
