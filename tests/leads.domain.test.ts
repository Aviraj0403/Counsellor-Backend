import { describe, expect, it } from 'vitest';
import { canTransition, isOpenStage, normalizePhone, pickAssignee } from '../src/product/modules/leads/domain/lead.domain.js';

describe('normalizePhone', () => {
  it.each(['98765 43210', '+91-98765-43210', '09876543210', '919876543210', '(98765) 43210'])('normalises %s', (raw) => {
    expect(normalizePhone(raw)).toBe('+919876543210');
  });
  it.each(['12345', '5876543210', '', 'abc', '98765432101234'])('rejects %s', (raw) => {
    expect(normalizePhone(raw)).toBeNull();
  });
});

describe('stage transitions', () => {
  it('allows the normal journey', () => {
    expect(canTransition('new', 'contacted')).toBe(true);
    expect(canTransition('application_started', 'admitted')).toBe(true);
  });
  it('blocks skipping steps and leaving a final stage', () => {
    expect(canTransition('new', 'admitted')).toBe(false);
    expect(canTransition('admitted', 'new')).toBe(false);
  });
  it('lets a lost lead be reopened', () => {
    expect(canTransition('lost', 'new')).toBe(true);
    expect(isOpenStage('lost')).toBe(false);
    expect(isOpenStage('contacted')).toBe(true);
  });
});

describe('pickAssignee', () => {
  it('picks the least loaded counsellor, ties by id', () => {
    expect(pickAssignee([{ id: 'b', openLeads: 3 }, { id: 'a', openLeads: 3 }, { id: 'c', openLeads: 9 }])).toBe('a');
    expect(pickAssignee([{ id: 'x', openLeads: 5 }, { id: 'y', openLeads: 1 }])).toBe('y');
  });
  it('returns undefined with nobody available', () => {
    expect(pickAssignee([])).toBeUndefined();
  });
});
