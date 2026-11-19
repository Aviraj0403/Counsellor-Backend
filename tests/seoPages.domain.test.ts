import { describe, expect, it } from 'vitest';
import { clip, esc, jsonLd, safeColor, safeUrl } from '../src/product/modules/seoPages/domain/seo.html.js';
import { buildRobots, buildSitemap, renderCollegePage, renderIndexPage, renderMessagePage, type SiteView } from '../src/product/modules/seoPages/domain/seo.render.js';

const XSS = '<script>alert(1)</script>"\'><img src=x onerror=alert(2)>';
const site: SiteView = {
  siteTitle: 'Acme Counselling',
  tagline: 'Honest guidance',
  themeColor: '#123abc',
  contact: { phone: '+91 98765 43210', email: 'help@acme.test', whatsapp: '919876543210' },
  leadFormEnabled: true,
  consentText: 'I agree to be contacted.',
  siteUrl: 'http://api.test/public/sites/acme',
};

describe('escaping primitives', () => {
  it('escapes the five dangerous characters and backticks', () => {
    expect(esc(`<a href="x" title='y'>&\``)).toBe('&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&#96;');
    expect(esc(null)).toBe('');
  });
  it('only allows absolute http(s) links', () => {
    expect(safeUrl('https://a.test/x?y=1')).toBe('https://a.test/x?y=1');
    expect(safeUrl('javascript:alert(1)')).toBe('');
    expect(safeUrl('data:text/html,x')).toBe('');
    expect(safeUrl('https://a.test/"onmouseover="x')).toBe('');
  });
  it('only allows #rrggbb colours', () => {
    expect(safeColor('#AbCdEf')).toBe('#AbCdEf');
    expect(safeColor('red;}</style><script>')).toBe('#1d4ed8');
  });
  it('JSON-LD cannot close the script tag', () => {
    const out = jsonLd({ a: '</script><script>alert(1)</script>' });
    expect(out).not.toContain('<');
    expect(JSON.parse(out).a).toBe('</script><script>alert(1)</script>');
  });
  it('clips at a word boundary', () => {
    expect(clip('a '.repeat(200), 50).length).toBeLessThanOrEqual(50);
    expect(clip('short', 50)).toBe('short');
  });
});

describe('page rendering', () => {
  const college = { slug: 'acme-college', name: 'Acme College', city: 'Pune', state: 'MH', description: 'A good college.', website: 'https://acme.edu' };
  const courses = [{ id: '1', name: 'B.Tech CSE', level: 'ug', durationMonths: 48, annualFeePaise: 12000000, intakes: [{ month: 7, year: 2027 }], minPercentage: 60 }];

  it('has title, description, canonical, open graph, JSON-LD (college + FAQ), course table, form and accessibility basics', () => {
    const html = renderCollegePage({ site, college, courses, override: { faqs: [{ q: 'Fees?', a: 'See table' }] }, utm: { utm_source: 'google' } });
    expect(html).toContain('<title>Acme College in Pune, MH');
    expect(html).toContain('<meta name="description" content="');
    expect(html).toContain('<link rel="canonical" href="http://api.test/public/sites/acme/colleges/acme-college">');
    expect(html).toContain('property="og:title"');
    expect(html).toContain('property="og:url"');
    expect(html).toContain('"@type":"CollegeOrUniversity"');
    expect(html).toContain('"@type":"FAQPage"');
    expect(html).toContain('Rs 1,20,000');
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('<main id="main">');
    expect(html).toContain('name="company_url"');
    expect(html).toContain('name="consent"');
    expect(html).toContain('name="utm_source" value="google"');
    expect(html).not.toMatch(/<script(?![^>]*ld\+json)/); // no executable or external scripts
  });

  it('override title/description win', () => {
    const html = renderCollegePage({ site, college, courses: [], override: { metaTitle: 'Custom T', metaDescription: 'Custom D' }, utm: {} });
    expect(html).toContain('<title>Custom T</title>');
    expect(html).toContain('<meta name="description" content="Custom D">');
  });

  it('XSS: every dynamic value is escaped (no raw payload anywhere in any page)', () => {
    const evil = { slug: 'x', name: XSS, type: XSS, city: XSS, state: XSS, country: XSS, affiliation: XSS, accreditations: [XSS], description: XSS, website: `javascript:${XSS}` };
    const evilSite: SiteView = { ...site, siteTitle: XSS, tagline: XSS, logoUrl: `https://a.test/"${XSS}`, themeColor: `red}</style>${XSS}`, contact: { phone: XSS, email: XSS, whatsapp: XSS }, consentText: XSS };
    const evilCourse = [{ id: '1', name: XSS, level: XSS, stream: XSS, durationMonths: 12, annualFeePaise: 100, intakes: [{ month: 1, year: 2027 }] }];
    const override = { metaTitle: XSS, metaDescription: XSS, heroText: XSS, faqs: [{ q: XSS, a: XSS }] };
    const utm = { utm_source: XSS, utm_medium: XSS, utm_campaign: XSS };
    const pages = [
      renderCollegePage({ site: evilSite, college: evil, courses: evilCourse, override, utm }),
      renderIndexPage({ site: evilSite, colleges: [evil], utm }),
      renderMessagePage({ site: evilSite, title: XSS, message: XSS }),
    ];
    for (const html of pages) {
      expect(html).not.toContain('<script>alert');
      expect(html).not.toContain('<img src=x');
      expect(html).not.toContain('onerror=alert(2)>');
      expect(html).not.toContain('javascript:');
      // the only <script> tags are the JSON-LD data blocks, and their contents contain no raw angle brackets
      for (const block of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) expect(block[1]).not.toMatch(/[<>]/);
      expect((html.match(/<script/g) ?? []).length).toBe((html.match(/<script type="application\/ld\+json">/g) ?? []).length);
      expect(html).toContain('--c:#1d4ed8'); // injected colour rejected
    }
    expect(pages[0]).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });
});

describe('sitemap and robots', () => {
  it('lists the home page and each college, escaped', () => {
    const xml = buildSitemap(site, ['a', 'b&c']);
    expect(xml).toContain('<loc>http://api.test/public/sites/acme/</loc>');
    expect(xml).toContain('<loc>http://api.test/public/sites/acme/colleges/a</loc>');
    expect(xml).toContain('colleges/b%26c</loc>');
  });
  it('robots points to the sitemap and blocks the form endpoint', () => {
    const txt = buildRobots(site);
    expect(txt).toContain('Sitemap: http://api.test/public/sites/acme/sitemap.xml');
    expect(txt).toContain('Disallow: /public/sites/acme/lead');
  });
});
