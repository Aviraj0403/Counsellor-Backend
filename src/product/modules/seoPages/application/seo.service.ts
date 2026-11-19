import { env } from '../../../../config/env.js';
import { getPlatform } from '../../../../contracts/registry.js';
import { systemPrincipal } from '../../../../contracts/system.js';
import type { Principal } from '../../../../contracts/port.js';
import { badRequest, notFound } from '../../../../shared/kernel/errors.js';
import { audit } from '../../audit/index.js';
import * as colleges from '../../colleges/index.js';
import { createLead } from '../../leads/index.js';
import { safeColor, safeUrl } from '../domain/seo.html.js';
import type { CollegeView, CourseView, OverrideView, SiteView, UtmView } from '../domain/seo.render.js';
import { CollegePageModel, SeoSettingsModel } from '../infrastructure/seo.model.js';

const DEFAULT_CONSENT = 'I agree to be contacted by phone, SMS, email or WhatsApp about admissions.';

export interface SettingsInput {
  orgSlug?: string;
  siteTitle?: string;
  tagline?: string;
  logoUrl?: string;
  themeColor?: string;
  contact?: { phone?: string; email?: string; whatsapp?: string };
  enabledColleges?: string[];
  leadFormEnabled?: boolean;
  consentText?: string;
}

export interface PageInput {
  metaTitle?: string;
  metaDescription?: string;
  heroText?: string;
  faqs?: { q: string; a: string }[];
  published?: boolean;
}

export const publicSiteUrl = (orgSlug: string) => `${env.PUBLIC_BASE_URL.replace(/\/+$/, '')}/public/sites/${encodeURIComponent(orgSlug)}`;

const settingsDoc = async (tenantId: string) => (await SeoSettingsModel(tenantId).findOne({ key: 'default' }).lean<any>()) ?? {};

export const getSettings = async (p: Principal) => {
  const s = await settingsDoc(p.tenantId!);
  return {
    orgSlug: s.orgSlug ?? '',
    siteTitle: s.siteTitle ?? '',
    tagline: s.tagline ?? '',
    logoUrl: s.logoUrl ?? '',
    themeColor: s.themeColor ?? '#1d4ed8',
    contact: { phone: s.contact?.phone ?? '', email: s.contact?.email ?? '', whatsapp: s.contact?.whatsapp ?? '' },
    enabledColleges: s.enabledColleges ?? [],
    leadFormEnabled: s.leadFormEnabled ?? true,
    consentText: s.consentText ?? DEFAULT_CONSENT,
    publicUrl: s.orgSlug ? publicSiteUrl(s.orgSlug) : null,
  };
};

export const updateSettings = async (p: Principal, input: SettingsInput) => {
  const tenantId = p.tenantId!;
  const set: Record<string, unknown> = { ...input };
  if (input.orgSlug) {
    // The staff user tells us the organisation's web address; we only accept it if it really is THIS organisation.
    const t = await getPlatform().findTenantBySlug(input.orgSlug.toLowerCase());
    if (!t || t.id !== tenantId) throw badRequest('That organisation address does not match your organisation. Ask your platform contact for the exact address.');
    set.orgSlug = input.orgSlug.toLowerCase();
  }
  if (input.logoUrl) set.logoUrl = safeUrl(input.logoUrl) || undefined;
  if (input.logoUrl && !safeUrl(input.logoUrl)) throw badRequest('Logo address must start with http:// or https://.');
  if (input.themeColor && safeColor(input.themeColor, '') === '') throw badRequest('Theme colour must look like #1d4ed8.');
  await SeoSettingsModel(tenantId).updateOne({ key: 'default' }, { $set: set, $setOnInsert: { key: 'default' } }, { upsert: true });
  await audit(tenantId, { action: 'seo.settings_updated', entity: 'seoSettings', meta: { fields: Object.keys(input) } });
  return getSettings(p);
};

const collegeView = (c: any): CollegeView => ({
  slug: c.slug,
  name: c.name,
  type: c.type,
  city: c.city,
  state: c.state,
  country: c.country,
  website: c.website,
  affiliation: c.affiliation,
  accreditations: c.accreditations,
  description: c.description,
});

const overrideView = (o: any): OverrideView | undefined => (o ? { metaTitle: o.metaTitle, metaDescription: o.metaDescription, heroText: o.heroText, faqs: o.faqs ?? [] } : undefined);

/** Course list comes from the colleges module's public API (listCourses), used with a system identity. */
const loadCourses = async (tenantId: string, collegeId: string): Promise<CourseView[]> => {
  const fn = (colleges as Record<string, unknown>).listCourses as ((p: Principal, id: string) => Promise<{ items: any[] }>) | undefined;
  if (!fn) return [];
  const { items } = await fn(systemPrincipal(tenantId, 'seo-pages'), collegeId);
  return items
    .filter((c) => c.active !== false)
    .map((c) => ({
      id: String(c._id),
      name: c.name,
      level: c.level,
      stream: c.stream,
      durationMonths: c.durationMonths,
      annualFeePaise: c.annualFeePaise,
      intakes: c.intakes,
      minPercentage: c.eligibility?.minPercentage,
    }));
};

export const siteViewFor = (tenantName: string, settings: any, orgSlug: string): SiteView => ({
  siteTitle: settings.siteTitle || tenantName,
  tagline: settings.tagline,
  logoUrl: settings.logoUrl,
  themeColor: settings.themeColor,
  contact: { phone: settings.contact?.phone, email: settings.contact?.email, whatsapp: settings.contact?.whatsapp },
  leadFormEnabled: settings.leadFormEnabled ?? true,
  consentText: settings.consentText || DEFAULT_CONSENT,
  siteUrl: publicSiteUrl(orgSlug),
});

/** Colleges that appear on the public site: active + (selected ones, if the organisation picked some) + not unpublished. */
const visibleColleges = async (tenantId: string, settings: any) => {
  const all = await colleges.listActiveColleges(tenantId);
  const enabled: string[] = settings.enabledColleges ?? [];
  const pages = await CollegePageModel(tenantId).find({ published: false }).lean<any[]>();
  const hidden = new Set(pages.map((x) => x.collegeId));
  return all.filter((c) => (enabled.length ? enabled.includes(String(c._id)) : true) && !hidden.has(String(c._id)));
};

export interface PublicSite {
  tenantId: string;
  site: SiteView;
  settings: any;
}

export const loadPublicSite = async (slug: string): Promise<PublicSite | null> => {
  const platform = getPlatform();
  const tenant = await platform.findTenantBySlug(slug.toLowerCase());
  if (!tenant || tenant.status !== 'active') return null;
  if (!(await platform.enabledModules(tenant.id))['seoPages']) return null;
  const settings = await settingsDoc(tenant.id);
  return { tenantId: tenant.id, site: siteViewFor(tenant.name, settings, slug.toLowerCase()), settings };
};

export const listPublicColleges = async (s: PublicSite) => (await visibleColleges(s.tenantId, s.settings)).map(collegeView);

export const getPublicCollegePage = async (s: PublicSite, collegeSlug: string) => {
  const list = await visibleColleges(s.tenantId, s.settings);
  const doc = list.find((c) => c.slug === collegeSlug);
  if (!doc) return null;
  const [courses, override] = await Promise.all([loadCourses(s.tenantId, String(doc._id)), CollegePageModel(s.tenantId).findOne({ collegeId: String(doc._id) }).lean<any>()]);
  return { college: collegeView(doc), courses, override: overrideView(override) };
};

/** Staff preview: shows the page even when it is unpublished or the college is not selected. */
export const previewCollegePage = async (p: Principal, collegeSlug: string) => {
  const tenantId = p.tenantId!;
  const doc = (await colleges.listActiveColleges(tenantId)).find((c) => c.slug === collegeSlug);
  if (!doc) throw notFound('College');
  const settings = await settingsDoc(tenantId);
  const tenant = (await getPlatform().listTenants()).find((t) => t.id === tenantId);
  const site = siteViewFor(tenant?.name ?? 'Your organisation', settings, settings.orgSlug ?? 'your-organisation');
  const [courses, override] = await Promise.all([loadCourses(tenantId, String(doc._id)), CollegePageModel(tenantId).findOne({ collegeId: String(doc._id) }).lean<any>()]);
  return { site, college: collegeView(doc), courses, override: overrideView(override) };
};

// ---- staff CRUD of page overrides
export const listPages = async (p: Principal) => {
  const tenantId = p.tenantId!;
  const [all, overrides, settings] = await Promise.all([colleges.listActiveColleges(tenantId), CollegePageModel(tenantId).find().lean<any[]>(), settingsDoc(tenantId)]);
  const byCollege = new Map(overrides.map((o) => [o.collegeId, o]));
  return {
    items: all.map((c) => ({
      collegeId: String(c._id),
      name: c.name,
      slug: c.slug,
      city: c.city,
      override: byCollege.get(String(c._id)) ?? null,
      publicUrl: settings.orgSlug ? `${publicSiteUrl(settings.orgSlug)}/colleges/${c.slug}` : null,
    })),
  };
};

const requireCollege = async (tenantId: string, collegeId: string) => {
  const c = await colleges.getCollege(tenantId, collegeId);
  if (!c) throw notFound('College');
  return c;
};

export const getPage = async (p: Principal, collegeId: string) => {
  await requireCollege(p.tenantId!, collegeId);
  return (await CollegePageModel(p.tenantId!).findOne({ collegeId }).lean<any>()) ?? { collegeId, faqs: [], published: true };
};

export const savePage = async (p: Principal, collegeId: string, input: PageInput) => {
  const tenantId = p.tenantId!;
  await requireCollege(tenantId, collegeId);
  const doc = await CollegePageModel(tenantId).findOneAndUpdate({ collegeId }, { $set: input, $setOnInsert: { collegeId } }, { upsert: true, new: true }).lean<any>();
  await audit(tenantId, { action: 'seo.page_saved', entity: 'collegePage', entityId: collegeId, meta: { fields: Object.keys(input) } });
  return doc;
};

export const deletePage = async (p: Principal, collegeId: string) => {
  const res = await CollegePageModel(p.tenantId!).deleteOne({ collegeId });
  if (!res.deletedCount) throw notFound('Page override');
  await audit(p.tenantId!, { action: 'seo.page_deleted', entity: 'collegePage', entityId: collegeId });
  return { ok: true };
};

// ---- public lead form
export interface WebsiteLeadInput {
  name: string;
  phone: string;
  email?: string;
  city?: string;
  course?: string;
  collegeSlug?: string;
  utm: UtmView;
}

export const submitWebsiteLead = async (s: PublicSite, input: WebsiteLeadInput) => {
  if (!s.site.leadFormEnabled) throw notFound('Enquiry form');
  const result = await createLead(systemPrincipal(s.tenantId, 'seo-pages'), {
    name: input.name,
    phone: input.phone,
    email: input.email || undefined,
    city: input.city || undefined,
    interestedCourse: input.course || undefined,
    source: { channel: 'website', utmSource: input.utm.utm_source, utmMedium: input.utm.utm_medium, utmCampaign: input.utm.utm_campaign },
    consent: { given: true, source: `seo-page${input.collegeSlug ? `:${input.collegeSlug}` : ''}` },
    autoAssign: true,
  });
  return { duplicate: result.duplicate };
};
