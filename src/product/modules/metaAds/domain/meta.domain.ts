import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { normalizePhone } from '../../../../shared/kernel/phone.js';

/** Pure rules of the Meta Ads connection: field mapping, event mapping, hashing, signature check. No database, no HTTP. */

// ---------- Lead Ads: map the form answers to a lead ----------
export interface MetaFieldData {
  name: string;
  values?: string[];
}

export interface MappedLead {
  name: string;
  phone: string | null; // normalised +91..., null when the number is not a valid Indian mobile
  email?: string;
  city?: string;
}

const first = (fields: MetaFieldData[], names: string[]): string | undefined => {
  for (const n of names) {
    const f = fields.find((x) => x.name.toLowerCase() === n);
    const v = f?.values?.[0]?.trim();
    if (v) return v;
  }
  return undefined;
};

export const mapLeadFields = (fields: MetaFieldData[]): MappedLead => {
  const rawPhone = first(fields, ['phone_number', 'phone', 'mobile_number']);
  const fullName = first(fields, ['full_name', 'name']) ?? [first(fields, ['first_name']), first(fields, ['last_name'])].filter(Boolean).join(' ');
  return {
    name: (fullName || 'Meta lead').slice(0, 120),
    phone: rawPhone ? normalizePhone(rawPhone) : null,
    email: first(fields, ['email'])?.toLowerCase(),
    city: first(fields, ['city'])?.slice(0, 80),
  };
};

export const leadAdsUtm = (v: { form_id?: string; ad_id?: string }) => ({
  utmSource: 'facebook',
  utmMedium: v.ad_id ? `ad_${v.ad_id}` : 'lead_ad',
  utmCampaign: v.form_id ? `form_${v.form_id}` : undefined,
});

// ---------- Conversions API: which lead change is which Meta event ----------
export type EventMap = Record<string, string>;
/** key = 'lead.created' or 'stage:<stage>', value = the Meta event name. Staff can override it in the settings. */
export const DEFAULT_EVENT_MAP: EventMap = {
  'lead.created': 'Lead',
  'stage:qualified': 'QualifiedLead',
  'stage:admitted': 'Admission',
};

export const eventNameFor = (map: EventMap | undefined, trigger: 'created' | { stage: string }): string | null => {
  const m = { ...DEFAULT_EVENT_MAP, ...(map ?? {}) };
  const key = trigger === 'created' ? 'lead.created' : `stage:${trigger.stage}`;
  const name = m[key];
  return name && name.trim() ? name.trim() : null;
};

export const isValidEventName = (s: string): boolean => /^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(s);

// ---------- hashing (Meta wants SHA-256 of normalised values; never raw PII) ----------
export const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

export const hashEmail = (email?: string | null): string | null => {
  const e = email?.trim().toLowerCase();
  return e ? sha256(e) : null;
};

/** Digits only, with country code: "+91 98765-43210" -> "919876543210". */
export const hashPhone = (phone?: string | null): string | null => {
  const norm = phone ? normalizePhone(phone) : null;
  return norm ? sha256(norm.replace(/\D/g, '')) : null;
};

export interface ConversionInput {
  leadId: string;
  eventName: string;
  email?: string | null;
  phone?: string | null;
  timeSeconds: number;
}

/** event_id = lead id + event name, so Meta de-duplicates a repeated send. */
export const eventIdFor = (leadId: string, eventName: string): string => `${leadId}_${eventName}`;

export const buildConversionEvent = (i: ConversionInput) => {
  const em = hashEmail(i.email);
  const ph = hashPhone(i.phone);
  return {
    event_name: i.eventName,
    event_time: i.timeSeconds,
    event_id: eventIdFor(i.leadId, i.eventName),
    action_source: 'system_generated',
    user_data: { ...(em ? { em: [em] } : {}), ...(ph ? { ph: [ph] } : {}) },
    custom_data: { lead_event_source: 'CounsellorPlatform' },
  };
};

export const hasUserData = (e: { user_data: Record<string, unknown> }): boolean => Object.keys(e.user_data).length > 0;

// ---------- webhook signature ----------
/** `x-hub-signature-256: sha256=<hex hmac of the raw body with the app secret>` */
export const isValidSignature = (rawBody: Buffer | undefined, header: string | undefined, appSecret: string | undefined): boolean => {
  if (!rawBody || !header || !appSecret) return false;
  const expected = Buffer.from('sha256=' + createHmac('sha256', appSecret).update(rawBody).digest('hex'));
  const got = Buffer.from(header);
  return expected.length === got.length && timingSafeEqual(expected, got);
};
