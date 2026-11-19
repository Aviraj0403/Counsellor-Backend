import type { ModuleKey } from '../../../../contracts/port.js';

/**
 * THE module catalogue. One list, plain language, so the admin screens render straight from it.
 *
 *  core    = always on, cannot be switched off (the product breaks without it)
 *  optIn   = OFF until the superadmin enables it for a specific organisation (this is what we sell)
 *  stage   = 'live' feature is built; 'soon' it is registered and priceable but not built yet
 */
export interface ModuleDef {
  key: ModuleKey;
  label: string;
  /** One sentence a non-technical admin understands. */
  whatItDoes: string;
  group: 'crm' | 'admissions' | 'finance' | 'marketing' | 'channels' | 'platform';
  core?: boolean;
  optIn?: boolean;
  dependsOn?: ModuleKey[];
  priceMonthlyInr?: number;
  stage: 'live' | 'soon';
}

export const MODULE_CATALOG: ModuleDef[] = [
  { key: 'leads', label: 'Leads & enquiries', whatItDoes: 'Capture student enquiries, assign them to counsellors and track every stage until admission.', group: 'crm', core: true, stage: 'live' },
  { key: 'team', label: 'Team & roles', whatItDoes: 'Add your counsellors, sales, marketing, support and accounts staff with the right access.', group: 'crm', core: true, stage: 'live' },
  { key: 'followups', label: 'Follow-ups & activity', whatItDoes: 'Tasks, reminders and call / message notes on every lead and student, so no enquiry is forgotten.', group: 'crm', dependsOn: ['leads'], stage: 'live' },
  { key: 'ledger', label: 'Ledgers & commission', whatItDoes: 'Student fees, college commission and counsellor payouts in one tamper-proof ledger.', group: 'finance', optIn: true, priceMonthlyInr: 999, stage: 'live' },
  { key: 'commissions', label: 'Commission rules & payouts', whatItDoes: 'College commission per admission, counsellor share and platform cut, posted to the ledger automatically.', group: 'finance', optIn: true, dependsOn: ['ledger', 'applications'], priceMonthlyInr: 799, stage: 'live' },
  { key: 'students', label: 'Student profiles', whatItDoes: 'Full student profile: marks, preferences, family details and consent.', group: 'admissions', optIn: true, dependsOn: ['leads'], stage: 'live' },
  { key: 'colleges', label: 'College directory', whatItDoes: 'Colleges, courses, fees, intakes and eligibility to shortlist from.', group: 'admissions', optIn: true, stage: 'live' },
  { key: 'applications', label: 'Applications & status', whatItDoes: 'Apply to a college for a student and follow the application until the result.', group: 'admissions', optIn: true, dependsOn: ['students', 'colleges'], stage: 'live' },
  { key: 'documents', label: 'Document vault', whatItDoes: 'Collect, verify and securely store admission documents.', group: 'admissions', optIn: true, dependsOn: ['students'], stage: 'live' },
  { key: 'reports', label: 'Reports & analytics', whatItDoes: 'Counsellor performance, conversion funnel and source-wise cost per admission.', group: 'crm', optIn: true, dependsOn: ['leads'], priceMonthlyInr: 499, stage: 'live' },
  { key: 'whatsapp', label: 'WhatsApp automation', whatItDoes: 'Automatic WhatsApp follow-ups, reminders and status updates to students.', group: 'channels', optIn: true, dependsOn: ['leads'], priceMonthlyInr: 999, stage: 'live' },
  { key: 'metaAds', label: 'Meta Ads connection', whatItDoes: 'Pull Meta lead-ads in automatically and send admission results back to improve ad targeting.', group: 'marketing', optIn: true, dependsOn: ['leads'], priceMonthlyInr: 1499, stage: 'live' },
  { key: 'seoPages', label: 'SEO college pages', whatItDoes: 'Search-friendly public college and course pages that bring in enquiries.', group: 'marketing', optIn: true, dependsOn: ['colleges'], priceMonthlyInr: 799, stage: 'live' },
  { key: 'publicApi', label: 'API & webhooks', whatItDoes: 'Let colleges and partner systems connect their data to yours.', group: 'platform', optIn: true, priceMonthlyInr: 999, stage: 'live' },
  { key: 'studentPortal', label: 'Student status portal', whatItDoes: 'Students log in to see their application and document status.', group: 'channels', optIn: true, dependsOn: ['applications'], stage: 'live' },
  { key: 'collegePortal', label: 'College portal', whatItDoes: 'Colleges log in to see applications and update their status.', group: 'channels', optIn: true, dependsOn: ['applications'], stage: 'live' },
  { key: 'appointments', label: 'Appointments & counselling slots', whatItDoes: 'Students book a counselling call or visit with a counsellor; reminders go out and no-shows are tracked.', group: 'crm', optIn: true, dependsOn: ['leads'], priceMonthlyInr: 799, stage: 'live' },
  { key: 'aiBot', label: 'AI admissions assistant', whatItDoes: 'An assistant that answers student questions from your own college data, qualifies enquiries, books appointments and hands over to a counsellor.', group: 'channels', optIn: true, dependsOn: ['leads'], priceMonthlyInr: 1499, stage: 'live' },
];

export const MODULE_BY_KEY = new Map(MODULE_CATALOG.map((m) => [m.key, m]));
