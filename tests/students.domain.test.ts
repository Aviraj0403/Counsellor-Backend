import { describe, expect, it } from 'vitest';
import { ageOn, guardianConsentProblem, isMinor, normalizePhone } from '../src/product/modules/students/domain/student.domain.js';

const on = new Date('2026-11-15T00:00:00Z');

describe('age and minors', () => {
  it('counts whole years and respects the birthday', () => {
    expect(ageOn(new Date('2008-11-16'), on)).toBe(17);
    expect(ageOn(new Date('2008-11-15'), on)).toBe(18);
    expect(ageOn(new Date('2000-01-01'), on)).toBe(26);
  });
  it('isMinor is false without a date of birth', () => {
    expect(isMinor(undefined, on)).toBe(false);
    expect(isMinor(new Date('2010-01-01'), on)).toBe(true);
    expect(isMinor(new Date('2008-11-15'), on)).toBe(false);
  });
});

describe('DPDP guardian consent', () => {
  it('requires guardian consent for under 18', () => {
    expect(guardianConsentProblem(new Date('2010-05-05'), false, on)).toMatch(/under 18/);
    expect(guardianConsentProblem(new Date('2010-05-05'), undefined, on)).toMatch(/guardian/);
    expect(guardianConsentProblem(new Date('2010-05-05'), true, on)).toBeNull();
  });
  it('does not require it for adults or unknown age', () => {
    expect(guardianConsentProblem(new Date('2000-05-05'), false, on)).toBeNull();
    expect(guardianConsentProblem(undefined, false, on)).toBeNull();
  });
});

describe('phone', () => {
  it('normalises to +91', () => {
    expect(normalizePhone('98765 43210')).toBe('+919876543210');
    expect(normalizePhone('12345')).toBeNull();
  });
});
