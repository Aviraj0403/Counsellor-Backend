import { describe, expect, it } from 'vitest';
import { contactDueAt, describeLeadCreated, describeStageChange, dueRange, isOverdue, startOfDay } from '../src/product/modules/followups/domain/followup.domain.js';
import { validateImportRows } from '../src/product/modules/leads/domain/lead.domain.js';

const now = new Date('2026-11-14T10:30:00Z');

describe('due filters', () => {
  it('overdue is anything before now', () => {
    expect(dueRange('overdue', now)).toEqual({ $lt: now });
  });
  it('today covers the whole calendar day', () => {
    const r = dueRange('today', now);
    expect(r.$gte).toEqual(startOfDay(now));
    expect(r.$lt).toEqual(new Date('2026-11-15T00:00:00Z'));
  });
  it('week covers the next 7 days', () => {
    expect(dueRange('week', now).$lt).toEqual(new Date('2026-11-21T00:00:00Z'));
  });
  it('only open tasks can be overdue', () => {
    expect(isOverdue({ status: 'open', dueAt: new Date('2026-11-14T09:00:00Z') }, now)).toBe(true);
    expect(isOverdue({ status: 'done', dueAt: new Date('2026-11-14T09:00:00Z') }, now)).toBe(false);
    expect(isOverdue({ status: 'open', dueAt: new Date('2026-11-14T11:00:00Z') }, now)).toBe(false);
  });
});

describe('system text and contact task', () => {
  it('contact task is due in one hour', () => {
    expect(contactDueAt(now).toISOString()).toBe('2026-11-14T11:30:00.000Z');
  });
  it('describes events in plain language', () => {
    expect(describeLeadCreated('walk_in')).toBe('Lead created via walk_in');
    expect(describeStageChange('new', 'contacted')).toBe('Stage changed from new to contacted');
  });
});

describe('validateImportRows', () => {
  it('normalises good rows and reports bad ones with 1-based row numbers', () => {
    const r = validateImportRows([
      { name: ' Asha ', phone: '98765 43210', email: 'ASHA@X.COM', city: 'Pune' },
      { name: '', phone: '9876543211' },
      { name: 'Ravi', phone: '12345' },
      { name: 'Meena', phone: 9876543212, email: 'nope' },
    ]);
    expect(r.valid).toHaveLength(1);
    expect(r.valid[0]).toMatchObject({ row: 1, name: 'Asha', phone: '+919876543210', email: 'asha@x.com', city: 'Pune' });
    expect(r.invalid.map((i) => i.row)).toEqual([2, 3, 4]);
    expect(r.invalid[2]!.reason).toMatch(/Email/);
  });
  it('accepts numeric phones from Excel and flags repeats inside the file as duplicates', () => {
    const r = validateImportRows([
      { name: 'Asha', phone: 9876543210 },
      { name: 'Asha again', phone: '+91 98765 43210' },
    ]);
    expect(r.valid).toHaveLength(1);
    expect(r.duplicateRows).toEqual([2]);
    expect(r.invalid).toHaveLength(0);
  });
});
