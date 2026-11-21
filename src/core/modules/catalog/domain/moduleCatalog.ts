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
  // 1. Lead Engine & Outreach
  { key: 'leads', label: 'Lead Engine & Inflow', whatItDoes: 'Capture enquiries from webhooks, popups, and partners; round-robin assignment and pipeline tracking.', group: 'crm', core: true, stage: 'live' },
  { key: 'followups', label: 'Tasks & Reminders', whatItDoes: 'Follow-up tasks, call notes and activity timelines so no enquiry is forgotten.', group: 'crm', dependsOn: ['leads'], stage: 'live' },

  // 2. Admissions & Counselling
  { key: 'students', label: 'Student Profiles & Batches', whatItDoes: 'Student profiles, academic marks, batch assignments, counselling sessions and attendance.', group: 'admissions', optIn: true, dependsOn: ['leads'], stage: 'live' },
  { key: 'colleges', label: 'College Directory & Cutoff Predictor', whatItDoes: 'Directory of universities, courses, fees, plus B.Tech rank predictor lead magnet.', group: 'admissions', optIn: true, stage: 'live' },
  { key: 'applications', label: 'Applications & Status Tracking', whatItDoes: 'End-to-end college admission application processing and stage history.', group: 'admissions', optIn: true, dependsOn: ['students', 'colleges'], stage: 'live' },
  { key: 'documents', label: 'Document Vault & Verification', whatItDoes: 'Collect, verify and securely store 10th/12th marksheets, caste & entrance scorecards.', group: 'admissions', optIn: true, dependsOn: ['students'], stage: 'live' },
  { key: 'appointments', label: 'Appointments & Counselling Slots', whatItDoes: '1-on-1 student counselling appointments, availability schedules, and waiting lists.', group: 'admissions', optIn: true, dependsOn: ['leads'], priceMonthlyInr: 799, stage: 'live' },

  // 3. Growth & Channels
  { key: 'whatsapp', label: 'WhatsApp Automation & Broadcasts', whatItDoes: 'Meta Cloud API WhatsApp automated follow-ups, broadcast campaigns, and template notifications.', group: 'channels', optIn: true, dependsOn: ['leads'], priceMonthlyInr: 999, stage: 'live' },
  { key: 'metaAds', label: 'Meta & Instagram Lead Ads', whatItDoes: 'Sync Facebook and Instagram lead forms in real-time with instant auto-assignment.', group: 'channels', optIn: true, dependsOn: ['leads'], priceMonthlyInr: 1499, stage: 'live' },
  { key: 'seoPages', label: 'Public Website & SEO Pages', whatItDoes: 'Search-friendly public college and course pages that bring organic prospective students.', group: 'channels', optIn: true, dependsOn: ['colleges'], priceMonthlyInr: 799, stage: 'live' },
  { key: 'aiBot', label: 'AI Admissions Chat Assistant', whatItDoes: 'Smart assistant that answers student questions 24/7 and qualifies admissions on website & WhatsApp.', group: 'channels', optIn: true, dependsOn: ['leads'], priceMonthlyInr: 1499, stage: 'live' },

  // 4. Finance & Settlements
  { key: 'ledger', label: 'Student Fees & Ledgers', whatItDoes: 'Tamper-proof ledger for seat booking deposits, Razorpay fee payment links, and receipts.', group: 'finance', optIn: true, priceMonthlyInr: 999, stage: 'live' },
  { key: 'commissions', label: 'College Commissions & Payouts', whatItDoes: 'Calculate college commission per admission, counsellor revenue share, and platform cut.', group: 'finance', optIn: true, dependsOn: ['ledger', 'applications'], priceMonthlyInr: 799, stage: 'live' },
  { key: 'reports', label: 'Conversion & Funnel Analytics', whatItDoes: 'Counsellor closing rate, marketing channel CAC, and admission conversion ratios.', group: 'finance', optIn: true, dependsOn: ['leads'], priceMonthlyInr: 499, stage: 'live' },

  // 5. Organisation & Portals
  { key: 'team', label: 'Team & Counsellor Roles', whatItDoes: 'Manage counsellors, team members, role-based visibility, and branch permissions.', group: 'platform', core: true, stage: 'live' },
  { key: 'publicApi', label: 'Universal Webhooks & API Keys', whatItDoes: 'Inbound webhooks for Justdial, Google Ads, Zapier, and third-party portal integrations.', group: 'platform', optIn: true, priceMonthlyInr: 999, stage: 'live' },
  { key: 'studentPortal', label: 'Student Self-Service Portal', whatItDoes: 'Students log in to upload missing documents, pay pending fee links, and see assigned counsellor.', group: 'platform', optIn: true, dependsOn: ['applications'], stage: 'live' },
  { key: 'collegePortal', label: 'College Partner Portal', whatItDoes: 'Colleges log in to review forwarded applications and update admission offers.', group: 'platform', optIn: true, dependsOn: ['applications'], stage: 'live' },
];

export const MODULE_BY_KEY = new Map(MODULE_CATALOG.map((m) => [m.key, m]));
