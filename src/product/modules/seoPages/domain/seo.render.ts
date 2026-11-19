import { clip, esc, formatInr, formatIntake, jsonLd, safeColor, safeUrl } from './seo.html.js';

export interface SiteView {
  siteTitle: string;
  tagline?: string;
  logoUrl?: string;
  themeColor?: string;
  contact: { phone?: string; email?: string; whatsapp?: string };
  leadFormEnabled: boolean;
  consentText: string;
  /** Absolute URL of this organisation's public site root, no trailing slash. */
  siteUrl: string;
}

export interface CollegeView {
  slug: string;
  name: string;
  type?: string;
  city?: string;
  state?: string;
  country?: string;
  website?: string;
  affiliation?: string;
  accreditations?: string[];
  description?: string;
}

export interface CourseView {
  id: string;
  name: string;
  level: string;
  stream?: string;
  durationMonths?: number;
  annualFeePaise: number;
  intakes?: { month?: number; year?: number }[];
  minPercentage?: number;
}

export interface OverrideView {
  metaTitle?: string;
  metaDescription?: string;
  heroText?: string;
  faqs?: { q: string; a: string }[];
}

export interface UtmView {
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
}

const place = (c: CollegeView) => [c.city, c.state].filter(Boolean).join(', ');

export const collegeUrl = (site: SiteView, slug: string) => `${site.siteUrl}/colleges/${encodeURIComponent(slug)}`;

export const pageTitle = (c: CollegeView, o: OverrideView | undefined, site: SiteView): string =>
  o?.metaTitle?.trim() || `${c.name}${place(c) ? ` in ${place(c)}` : ''}: courses, fees and admission | ${site.siteTitle}`;

export const pageDescription = (c: CollegeView, o: OverrideView | undefined, site: SiteView): string =>
  clip(o?.metaDescription?.trim() || c.description?.trim() || `Courses, fees, intakes and eligibility for ${c.name}${place(c) ? ` in ${place(c)}` : ''}. Talk to ${site.siteTitle} for free admission guidance.`, 160);

export const collegeJsonLd = (c: CollegeView, site: SiteView) => ({
  '@context': 'https://schema.org',
  '@type': 'CollegeOrUniversity',
  name: c.name,
  url: collegeUrl(site, c.slug),
  ...(c.description ? { description: clip(c.description, 500) } : {}),
  ...(safeUrl(c.website) ? { sameAs: [safeUrl(c.website)] } : {}),
  address: { '@type': 'PostalAddress', addressLocality: c.city, addressRegion: c.state, addressCountry: c.country ?? 'IN' },
});

export const faqJsonLd = (faqs: { q: string; a: string }[]) => ({
  '@context': 'https://schema.org',
  '@type': 'FAQPage',
  mainEntity: faqs.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })),
});

const STYLE = (color: string) =>
  `:root{--c:${color}}*{box-sizing:border-box}body{margin:0;font:16px/1.6 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#1f2937;background:#fff}` +
  `a{color:var(--c)}header,main,footer{max-width:960px;margin:0 auto;padding:16px}header{border-bottom:3px solid var(--c)}` +
  `h1{font-size:1.75rem;line-height:1.25;margin:.5rem 0}h2{font-size:1.25rem;margin-top:2rem}table{border-collapse:collapse;width:100%}` +
  `th,td{border:1px solid #d1d5db;padding:8px;text-align:left;vertical-align:top}th{background:#f3f4f6}.muted{color:#4b5563}` +
  `.card{border:1px solid #d1d5db;border-radius:8px;padding:12px;margin:8px 0}label{display:block;margin-top:10px;font-weight:600}` +
  `input,select{width:100%;max-width:420px;padding:8px;border:1px solid #9ca3af;border-radius:6px;font:inherit}` +
  `button{margin-top:14px;padding:10px 18px;border:0;border-radius:6px;background:var(--c);color:#fff;font:inherit;cursor:pointer}` +
  `.hp{position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden}.skip{position:absolute;left:-9999px}.skip:focus{left:8px;top:8px;background:#fff;padding:6px}` +
  `.table-wrap{overflow-x:auto}`;

interface Head {
  title: string;
  description: string;
  canonical: string;
  site: SiteView;
  ogType?: string;
  jsonLdBlocks?: unknown[];
  noindex?: boolean;
}

const layout = (head: Head, body: string): string => {
  const { site } = head;
  const ld = (head.jsonLdBlocks ?? []).map((b) => `<script type="application/ld+json">${jsonLd(b)}</script>`).join('\n');
  const logo = safeUrl(site.logoUrl);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(head.title)}</title>
<meta name="description" content="${esc(head.description)}">
<link rel="canonical" href="${esc(head.canonical)}">
${head.noindex ? '<meta name="robots" content="noindex">\n' : ''}<meta property="og:type" content="${esc(head.ogType ?? 'website')}">
<meta property="og:title" content="${esc(head.title)}">
<meta property="og:description" content="${esc(head.description)}">
<meta property="og:url" content="${esc(head.canonical)}">
<meta property="og:site_name" content="${esc(site.siteTitle)}">
${logo ? `<meta property="og:image" content="${esc(logo)}">\n` : ''}<meta name="theme-color" content="${esc(safeColor(site.themeColor))}">
<style>${STYLE(safeColor(site.themeColor))}</style>
${ld}
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header>${logo ? `<img src="${esc(logo)}" alt="${esc(site.siteTitle)} logo" height="40"> ` : ''}<strong><a href="${esc(site.siteUrl)}/">${esc(site.siteTitle)}</a></strong>${site.tagline ? `<div class="muted">${esc(site.tagline)}</div>` : ''}</header>
<main id="main">
${body}
</main>
<footer class="muted">${contactLine(site)}<p>&copy; ${esc(site.siteTitle)}</p></footer>
</body>
</html>
`;
};

const contactLine = (site: SiteView): string => {
  const parts: string[] = [];
  const phone = (site.contact.phone ?? '').replace(/[^\d+]/g, '');
  if (phone) parts.push(`Call <a href="tel:${esc(phone)}">${esc(site.contact.phone)}</a>`);
  if (site.contact.email) parts.push(`Email <a href="mailto:${esc(encodeURI(site.contact.email))}">${esc(site.contact.email)}</a>`);
  const wa = (site.contact.whatsapp ?? '').replace(/\D/g, '');
  if (wa) parts.push(`<a href="https://wa.me/${esc(wa)}">WhatsApp us</a>`);
  return parts.length ? `<p>${parts.join(' &middot; ')}</p>` : '';
};

const leadForm = (site: SiteView, collegeSlug: string | undefined, courses: CourseView[], utm: UtmView): string => {
  const hidden = (['utm_source', 'utm_medium', 'utm_campaign'] as const).map((k) => (utm[k] ? `<input type="hidden" name="${k}" value="${esc(utm[k])}">` : '')).join('');
  return `<section aria-labelledby="enquire"><h2 id="enquire">Get free admission guidance</h2>
<form method="post" action="${esc(site.siteUrl)}/lead">
${collegeSlug ? `<input type="hidden" name="collegeSlug" value="${esc(collegeSlug)}">` : ''}${hidden}
<div class="hp" aria-hidden="true"><label>Leave this empty<input type="text" name="company_url" tabindex="-1" autocomplete="off"></label></div>
<label for="f-name">Your name</label><input id="f-name" name="name" required maxlength="120" autocomplete="name">
<label for="f-phone">Mobile number</label><input id="f-phone" name="phone" type="tel" required maxlength="20" autocomplete="tel" inputmode="tel">
<label for="f-email">Email (optional)</label><input id="f-email" name="email" type="email" maxlength="160" autocomplete="email">
<label for="f-city">City (optional)</label><input id="f-city" name="city" maxlength="80" autocomplete="address-level2">
${courses.length ? `<label for="f-course">Course you are interested in</label><select id="f-course" name="course"><option value="">Not sure yet</option>${courses.map((c) => `<option value="${esc(c.name)}">${esc(c.name)}</option>`).join('')}</select>` : ''}
<label><input type="checkbox" name="consent" value="yes" required style="width:auto"> ${esc(site.consentText)}</label>
<button type="submit">Request a call back</button>
</form></section>`;
};

export const renderCollegePage = (a: { site: SiteView; college: CollegeView; courses: CourseView[]; override?: OverrideView; utm: UtmView; preview?: boolean }): string => {
  const { site, college: c, courses, override: o } = a;
  const faqs = (o?.faqs ?? []).filter((f) => f.q.trim() && f.a.trim());
  const title = pageTitle(c, o, site);
  const description = pageDescription(c, o, site);
  const facts = [
    c.type ? `<li>Type: ${esc(c.type)}</li>` : '',
    place(c) ? `<li>Location: ${esc(place(c))}</li>` : '',
    c.affiliation ? `<li>Affiliation: ${esc(c.affiliation)}</li>` : '',
    c.accreditations?.length ? `<li>Accreditation: ${c.accreditations.map(esc).join(', ')}</li>` : '',
    safeUrl(c.website) ? `<li>Official website: <a href="${esc(safeUrl(c.website))}" rel="nofollow noopener">${esc(safeUrl(c.website))}</a></li>` : '',
  ].join('');
  const courseTable = courses.length
    ? `<section aria-labelledby="courses"><h2 id="courses">Courses and fees</h2><div class="table-wrap"><table><caption class="skip">Courses offered by ${esc(c.name)}</caption><thead><tr><th scope="col">Course</th><th scope="col">Level</th><th scope="col">Duration</th><th scope="col">Fee per year</th><th scope="col">Intakes</th><th scope="col">Eligibility</th></tr></thead><tbody>${courses
        .map(
          (k) =>
            `<tr><th scope="row">${esc(k.name)}${k.stream ? `<div class="muted">${esc(k.stream)}</div>` : ''}</th><td>${esc(k.level)}</td><td>${k.durationMonths ? `${esc(k.durationMonths)} months` : ''}</td><td>${esc(formatInr(k.annualFeePaise))}</td><td>${esc((k.intakes ?? []).map(formatIntake).join(', '))}</td><td>${k.minPercentage != null ? `${esc(k.minPercentage)}% minimum` : ''}</td></tr>`,
        )
        .join('')}</tbody></table></div></section>`
    : '';
  const faqHtml = faqs.length
    ? `<section aria-labelledby="faq"><h2 id="faq">Frequently asked questions</h2>${faqs.map((f) => `<div class="card"><h3>${esc(f.q)}</h3><p>${esc(f.a)}</p></div>`).join('')}</section>`
    : '';
  const body = `<nav aria-label="Breadcrumb"><a href="${esc(site.siteUrl)}/">All colleges</a></nav>
<article><h1>${esc(c.name)}</h1>${o?.heroText ? `<p class="muted">${esc(o.heroText)}</p>` : ''}
${c.description ? `<p>${esc(c.description)}</p>` : ''}<ul>${facts}</ul></article>
${courseTable}
${faqHtml}
${site.leadFormEnabled ? leadForm(site, c.slug, courses, a.utm) : ''}`;
  return layout(
    { title, description, canonical: collegeUrl(site, c.slug), site, ogType: 'website', jsonLdBlocks: [collegeJsonLd(c, site), ...(faqs.length ? [faqJsonLd(faqs)] : [])], noindex: a.preview },
    body,
  );
};

export const renderIndexPage = (a: { site: SiteView; colleges: CollegeView[]; utm: UtmView }): string => {
  const { site } = a;
  const list = a.colleges.length
    ? `<ul>${a.colleges.map((c) => `<li class="card"><a href="${esc(collegeUrl(site, c.slug))}"><strong>${esc(c.name)}</strong></a>${place(c) ? `<div class="muted">${esc(place(c))}</div>` : ''}</li>`).join('')}</ul>`
    : '<p>No colleges are listed yet. Please check back soon.</p>';
  const body = `<h1>${esc(site.siteTitle)}</h1>${site.tagline ? `<p class="muted">${esc(site.tagline)}</p>` : ''}<h2>Colleges</h2>${list}${site.leadFormEnabled ? leadForm(site, undefined, [], a.utm) : ''}`;
  return layout(
    {
      title: `${site.siteTitle}: colleges and admission guidance`,
      description: clip(site.tagline || `Browse colleges, courses and fees with ${site.siteTitle}.`, 160),
      canonical: `${site.siteUrl}/`,
      site,
      jsonLdBlocks: [{ '@context': 'https://schema.org', '@type': 'WebSite', name: site.siteTitle, url: `${site.siteUrl}/` }],
    },
    body,
  );
};

export const renderMessagePage = (a: { site: SiteView; title: string; message: string }): string =>
  layout({ title: a.title, description: a.message, canonical: `${a.site.siteUrl}/`, site: a.site, noindex: true }, `<h1>${esc(a.title)}</h1><p>${esc(a.message)}</p><p><a href="${esc(a.site.siteUrl)}/">Back to all colleges</a></p>`);

export const buildSitemap = (site: SiteView, collegeSlugs: string[]): string =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${[`${site.siteUrl}/`, ...collegeSlugs.map((s) => collegeUrl(site, s))].map((u) => `  <url><loc>${esc(u)}</loc></url>`).join('\n')}\n</urlset>\n`;

export const buildRobots = (site: SiteView): string => `User-agent: *\nAllow: /\nDisallow: ${new URL(site.siteUrl).pathname}/lead\nSitemap: ${site.siteUrl}/sitemap.xml\n`;
