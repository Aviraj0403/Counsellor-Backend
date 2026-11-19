import { describe, expect, it } from 'vitest';
import {
  DEDUPE_WINDOW_MS,
  dedupeKey,
  dedupeSince,
  fillTemplate,
  nextStatus,
  placeholderCount,
  placeholdersAreSequential,
  resolveRuleParams,
  ruleMatches,
  templateComponents,
  toWhatsappNumber,
} from '../src/product/modules/whatsapp/domain/whatsapp.domain.js';

describe('template filling', () => {
  it('fills numbered placeholders, also repeated ones', () => {
    expect(fillTemplate('Hi {{1}}, join {{2}}. Bye {{1}}', ['Asha', 'MBA'])).toBe('Hi Asha, join MBA. Bye Asha');
    expect(placeholderCount('Hi {{1}} {{ 3 }}')).toBe(3);
  });
  it('refuses the wrong number of values with a plain message', () => {
    expect(() => fillTemplate('Hi {{1}} {{2}}', ['a'])).toThrow(/needs 2 values but 1 was given/);
    expect(() => fillTemplate('Hi {{1}}', ['a', 'b'])).toThrow(/takes 1 value but 2 were given/);
  });
  it('checks placeholders are sequential', () => {
    expect(placeholdersAreSequential('{{1}} {{2}}')).toBe(true);
    expect(placeholdersAreSequential('{{1}} {{3}}')).toBe(false);
    expect(placeholdersAreSequential('no values')).toBe(true);
  });
  it('builds API components and digits-only numbers', () => {
    expect(templateComponents([])).toEqual([]);
    expect(templateComponents(['x'])).toEqual([{ type: 'body', parameters: [{ type: 'text', text: 'x' }] }]);
    expect(toWhatsappNumber('+919876543210')).toBe('919876543210');
  });
});

describe('dedupe', () => {
  it('same number+template+values gives the same key; any change differs', () => {
    const k = dedupeKey('+919876543210', 'welcome', 'en', ['Asha']);
    expect(dedupeKey('+919876543210', 'welcome', 'en', ['Asha'])).toBe(k);
    expect(dedupeKey('+919876543210', 'welcome', 'en', ['Asha2'])).not.toBe(k);
    expect(dedupeKey('+919876543211', 'welcome', 'en', ['Asha'])).not.toBe(k);
    expect(dedupeKey('+919876543210', 'other', 'en', ['Asha'])).not.toBe(k);
  });
  it('window is 10 minutes', () => {
    const now = new Date('2026-01-01T10:00:00Z');
    expect(DEDUPE_WINDOW_MS).toBe(600_000);
    expect(dedupeSince(now).toISOString()).toBe('2026-01-01T09:50:00.000Z');
  });
});

describe('automation rule matching', () => {
  const rule = { event: 'lead.stage_changed' as const, filter: 'qualified', active: true };
  it('matches event and filter', () => {
    expect(ruleMatches(rule, { event: 'lead.stage_changed', value: 'qualified' })).toBe(true);
    expect(ruleMatches(rule, { event: 'lead.stage_changed', value: 'contacted' })).toBe(false);
    expect(ruleMatches(rule, { event: 'lead.created', value: 'qualified' })).toBe(false);
  });
  it('empty filter matches everything; inactive never matches', () => {
    expect(ruleMatches({ ...rule, filter: '' }, { event: 'lead.stage_changed', value: 'x' })).toBe(true);
    expect(ruleMatches({ ...rule, filter: undefined }, { event: 'lead.stage_changed', value: 'x' })).toBe(true);
    expect(ruleMatches({ ...rule, active: false }, { event: 'lead.stage_changed', value: 'qualified' })).toBe(false);
  });
  it('resolves {name} {course} {city} in rule params', () => {
    expect(resolveRuleParams(['{name}', 'Course: {course}', 'plain'], { name: 'Asha' })).toEqual(['Asha', 'Course: ', 'plain']);
  });
});

describe('status progression', () => {
  it('never goes backwards', () => {
    expect(nextStatus('read', 'delivered')).toBe('read');
    expect(nextStatus('sent', 'delivered')).toBe('delivered');
    expect(nextStatus('delivered', 'read')).toBe('read');
  });
  it('failed does not overwrite delivered/read', () => {
    expect(nextStatus('sent', 'failed')).toBe('failed');
    expect(nextStatus('delivered', 'failed')).toBe('delivered');
  });
});
