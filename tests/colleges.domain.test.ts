import { describe, expect, it } from 'vitest';
import {
  intakeIsOpen,
  matchCourses,
  resolveRequiredDocuments,
  slugify,
  validateImportRow,
  type CollegeLike,
  type CourseLike,
} from '../src/product/modules/colleges/domain/college.domain.js';

const now = new Date('2026-11-15T00:00:00Z');
const college = (id: string, city: string): CollegeLike => ({ id, name: `College ${id}`, city });
const course = (id: string, over: Partial<CourseLike> = {}): CourseLike => ({
  id,
  name: 'B.Tech Computer Science',
  level: 'ug',
  annualFeePaise: 100_000_00,
  intakes: [{ month: 8, year: 2027 }],
  eligibility: { minPercentage: 60 },
  ...over,
});
const crit = { percentage: 75, level: 'ug' as const };

describe('slugify', () => {
  it('makes url-safe slugs', () => {
    expect(slugify('St. Xavier’s College, Mumbai!')).toBe('st-xavier-s-college-mumbai');
  });
});

describe('intakeIsOpen', () => {
  it('uses the deadline when present', () => {
    expect(intakeIsOpen({ month: 8, year: 2027, deadline: '2026-11-01' }, now)).toBe(false);
    expect(intakeIsOpen({ month: 8, year: 2027, deadline: '2026-12-01' }, now)).toBe(true);
  });
  it('without a deadline, the intake month must not be over', () => {
    expect(intakeIsOpen({ month: 10, year: 2026 }, now)).toBe(false);
    expect(intakeIsOpen({ month: 11, year: 2026 }, now)).toBe(true);
  });
});

describe('matchCourses', () => {
  it('drops by level, eligibility, budget, city, name and passed deadlines', () => {
    const items = [
      { course: course('ok'), college: college('1', 'Pune') },
      { course: course('pg', { level: 'pg' }), college: college('1', 'Pune') },
      { course: course('hi', { eligibility: { minPercentage: 90 } }), college: college('1', 'Pune') },
      { course: course('dear', { annualFeePaise: 900_000_00 }), college: college('1', 'Pune') },
      { course: course('late', { intakes: [{ month: 8, year: 2027, deadline: '2026-01-01' }] }), college: college('1', 'Pune') },
      { course: course('delhi'), college: college('2', 'Delhi') },
      { course: course('arts', { name: 'BA History' }), college: college('3', 'Pune') },
    ];
    const all = matchCourses(items, crit, now).map((m) => m.courseId);
    expect(all.sort()).toEqual(['arts', 'dear', 'delhi', 'ok']);
    expect(matchCourses(items, { ...crit, budgetMaxPaise: 200_000_00, cities: ['pune'], course: 'computer' }, now).map((m) => m.courseId)).toEqual(['ok']);
  });
  it('ranks cheaper and better-margin courses first', () => {
    const items = [
      { course: course('a', { annualFeePaise: 150_000_00 }), college: college('1', 'Pune') },
      { course: course('b', { annualFeePaise: 100_000_00 }), college: college('2', 'Pune') },
    ];
    expect(matchCourses(items, { ...crit, budgetMaxPaise: 200_000_00 }, now).map((m) => m.courseId)).toEqual(['b', 'a']);
  });
  it('filters by intake year and reports the next intake', () => {
    const c = course('x', { intakes: [{ month: 1, year: 2028 }, { month: 8, year: 2027 }] });
    const r = matchCourses([{ course: c, college: college('1', 'Pune') }], crit, now);
    expect(r[0]!.nextIntake).toMatchObject({ month: 8, year: 2027 });
    expect(matchCourses([{ course: c, college: college('1', 'Pune') }], { ...crit, intakeYear: 2030 }, now)).toEqual([]);
  });
});

describe('required documents', () => {
  it('course list overrides the college list', () => {
    const c = [{ type: 'marksheet', label: 'Marksheet', mandatory: true }];
    const k = [{ type: 'photo', label: 'Photo', mandatory: false }];
    expect(resolveRequiredDocuments(c, k)).toEqual(k);
    expect(resolveRequiredDocuments(c, [])).toEqual(c);
    expect(resolveRequiredDocuments(undefined, undefined)).toEqual([]);
  });
});

describe('validateImportRow', () => {
  it('accepts a college with a course and converts rupees to paise', () => {
    const r = validateImportRow({ name: 'ABC Institute', city: 'Pune', courseName: 'MBA', level: 'PG', annualFeeRupees: '1,25,000' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.college.slug).toBe('abc-institute-pune');
      expect(r.value.course).toMatchObject({ level: 'pg', annualFeePaise: 12_500_000 });
    }
  });
  it('rejects bad rows with a plain reason', () => {
    expect(validateImportRow({ city: 'Pune' })).toMatchObject({ ok: false });
    expect(validateImportRow({ name: 'ABC', city: 'Pune', type: 'zoo' })).toMatchObject({ ok: false });
    expect(validateImportRow({ name: 'ABC', city: 'Pune', website: 'abc.com' })).toMatchObject({ ok: false });
    expect(validateImportRow({ name: 'ABC', city: 'Pune', courseName: 'MBA', level: 'pg' })).toMatchObject({ ok: false });
  });
});
