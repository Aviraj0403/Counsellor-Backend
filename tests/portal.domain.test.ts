import { describe, expect, it } from 'vitest';
import { COLLEGE_ALLOWED_STATUSES, collegeMayMoveTo, collegeStudentView, generateTempPassword, studentHistory, studentProfileView } from '../src/product/modules/portal/domain/portal.domain.js';

describe('temporary password', () => {
  it('is long, mixed and different every time', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const p = generateTempPassword();
      expect(p.length).toBeGreaterThanOrEqual(14);
      expect(p).toMatch(/[A-Z]/);
      expect(p).toMatch(/[a-z]/);
      expect(p).toMatch(/[0-9]/);
      expect(p).toMatch(/[^A-Za-z0-9]/);
      seen.add(p);
    }
    expect(seen.size).toBe(50);
  });
});

describe('what a college may do', () => {
  it('allows only review, offer, reject, accept confirmation and admit', () => {
    for (const s of COLLEGE_ALLOWED_STATUSES) expect(collegeMayMoveTo(s)).toBe(true);
    for (const s of ['draft', 'submitted', 'declined', 'fee_paid', 'withdrawn', 'bogus']) expect(collegeMayMoveTo(s)).toBe(false);
  });
});

describe('views never leak', () => {
  const s = {
    name: 'Ravi',
    phone: '+919876543210',
    email: 'r@x.test',
    address: { city: 'Pune' },
    guardian: { name: 'Dad', phone: '+91999' },
    dob: new Date(),
    assignedTo: 'staff1',
    leadId: 'l1',
    createdBy: 'u1',
    consent: { given: true },
    academics: [{ level: '12th', board: 'CBSE', institute: 'X School', year: 2020, percentage: 88, secret: 'x' }],
    testScores: [{ test: 'JEE', score: 90, year: 2020 }],
  };
  it('college view: name and academics only', () => {
    const v = collegeStudentView(s);
    expect(Object.keys(v).sort()).toEqual(['academics', 'name', 'testScores']);
    expect(JSON.stringify(v)).not.toMatch(/9876543210|r@x.test|Pune|Dad|secret/);
  });
  it('student view: no internal fields', () => {
    const v: any = studentProfileView(s);
    expect(v.assignedTo).toBeUndefined();
    expect(v.leadId).toBeUndefined();
    expect(v.consent).toBeUndefined();
    expect(v.guardian).toBeUndefined();
  });
  it('history hides who changed it and the notes', () => {
    expect(studentHistory([{ from: 'a', to: 'b', at: 1, by: 'staff', note: 'internal' }])).toEqual([{ from: 'a', to: 'b', at: 1 }]);
  });
});
