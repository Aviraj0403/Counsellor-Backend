import { randomInt } from 'node:crypto';

/** Pure rules for the portals. Unit-tested in tests/portal.domain.test.ts */

const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const LOWER = 'abcdefghijkmnopqrstuvwxyz';
const DIGIT = '23456789';
const SYMBOL = '!@#$%*-_';
const pick = (set: string) => set[randomInt(set.length)]!;

/** A random, readable temporary password (no look-alike characters) that satisfies any sensible password policy. */
export const generateTempPassword = (length = 14): string => {
  const all = UPPER + LOWER + DIGIT + SYMBOL;
  const chars = [pick(UPPER), pick(LOWER), pick(DIGIT), pick(SYMBOL)];
  while (chars.length < length) chars.push(pick(all));
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j]!, chars[i]!];
  }
  return chars.join('');
};

/**
 * Statuses a college may set from its portal. offered -> accepted/declined is the student's decision and
 * fee_paid is recorded by our staff, so those are not here.
 */
export const COLLEGE_ALLOWED_STATUSES = ['under_review', 'offered', 'rejected', 'accepted', 'admitted'] as const;

export const collegeMayMoveTo = (to: string): boolean => (COLLEGE_ALLOWED_STATUSES as readonly string[]).includes(to);

/** What a student sees of a status-history entry: never who changed it, never internal notes. */
export const studentHistory = (history: any[] | undefined) => (history ?? []).map((h) => ({ from: h.from, to: h.to, at: h.at }));

const pct = (v: unknown) => (typeof v === 'number' ? v : undefined);

/** College-facing student summary: name and academics only. No phone, email, address, guardian, dob, notes. */
export const collegeStudentView = (s: any) =>
  s
    ? {
        name: s.name,
        academics: (s.academics ?? []).map((a: any) => ({ level: a.level, board: a.board, institute: a.institute, year: a.year, percentage: pct(a.percentage) })),
        testScores: (s.testScores ?? []).map((t: any) => ({ test: t.test, score: t.score, year: t.year })),
      }
    : { name: 'Unknown student', academics: [], testScores: [] };

/** Student-facing own profile: no internal fields (assignee, lead, consent trail, creator). */
export const studentProfileView = (s: any) => ({
  name: s.name,
  phone: s.phone,
  email: s.email,
  dob: s.dob,
  gender: s.gender,
  address: s.address,
  academics: s.academics,
  testScores: s.testScores,
  preferences: s.preferences,
});

export const normalizeEmail = (e: string): string => e.trim().toLowerCase();
