import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  buildConversionEvent, eventIdFor, eventNameFor, hashEmail, hashPhone, isValidSignature, leadAdsUtm, mapLeadFields,
} from '../src/product/modules/metaAds/domain/meta.domain.js';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

describe('metaAds domain', () => {
  it('maps lead form fields', () => {
    const m = mapLeadFields([
      { name: 'full_name', values: ['Asha Verma'] },
      { name: 'phone_number', values: ['+91 98765-43210'] },
      { name: 'email', values: ['Asha@Example.com '] },
      { name: 'city', values: ['Pune'] },
    ]);
    expect(m).toEqual({ name: 'Asha Verma', phone: '+919876543210', email: 'asha@example.com', city: 'Pune' });
  });

  it('falls back to first/last name and flags an invalid phone', () => {
    const m = mapLeadFields([{ name: 'first_name', values: ['Ravi'] }, { name: 'last_name', values: ['K'] }, { name: 'phone_number', values: ['123'] }]);
    expect(m.name).toBe('Ravi K');
    expect(m.phone).toBeNull();
  });

  it('builds utm from ad and form ids', () => {
    expect(leadAdsUtm({ form_id: 'F1', ad_id: 'A1' })).toEqual({ utmSource: 'facebook', utmMedium: 'ad_A1', utmCampaign: 'form_F1' });
  });

  it('maps events by default and honours overrides', () => {
    expect(eventNameFor(undefined, 'created')).toBe('Lead');
    expect(eventNameFor(undefined, { stage: 'qualified' })).toBe('QualifiedLead');
    expect(eventNameFor(undefined, { stage: 'admitted' })).toBe('Admission');
    expect(eventNameFor(undefined, { stage: 'contacted' })).toBeNull();
    expect(eventNameFor({ 'stage:contacted': 'Contacted', 'stage:admitted': 'Purchase' }, { stage: 'contacted' })).toBe('Contacted');
    expect(eventNameFor({ 'stage:admitted': 'Purchase' }, { stage: 'admitted' })).toBe('Purchase');
    expect(eventNameFor({ 'lead.created': '' }, 'created')).toBeNull();
  });

  it('hashes email (trimmed, lowercase) and phone (digits with country code)', () => {
    expect(hashEmail('  Asha@Example.COM ')).toBe(sha('asha@example.com'));
    expect(hashPhone('+919876543210')).toBe(sha('919876543210'));
    expect(hashPhone('98765 43210')).toBe(sha('919876543210'));
    expect(hashEmail('')).toBeNull();
    expect(hashPhone('abc')).toBeNull();
  });

  it('builds an event with hashed data only and a dedupe id', () => {
    const e = buildConversionEvent({ leadId: 'L1', eventName: 'Lead', email: 'a@b.com', phone: '+919876543210', timeSeconds: 1700000000 });
    expect(e).toEqual({
      event_name: 'Lead',
      event_time: 1700000000,
      event_id: eventIdFor('L1', 'Lead'),
      action_source: 'system_generated',
      user_data: { em: [sha('a@b.com')], ph: [sha('919876543210')] },
      custom_data: { lead_event_source: 'CounsellorPlatform' },
    });
    expect(JSON.stringify(e)).not.toContain('a@b.com');
    expect(JSON.stringify(e)).not.toContain('9876543210"');
  });

  it('verifies the webhook signature', () => {
    const body = Buffer.from('{"a":1}');
    const sig = 'sha256=' + createHmac('sha256', 'secret').update(body).digest('hex');
    expect(isValidSignature(body, sig, 'secret')).toBe(true);
    expect(isValidSignature(body, sig, 'other')).toBe(false);
    expect(isValidSignature(body, 'sha256=bad', 'secret')).toBe(false);
    expect(isValidSignature(undefined, sig, 'secret')).toBe(false);
    expect(isValidSignature(body, sig, undefined)).toBe(false);
  });
});
