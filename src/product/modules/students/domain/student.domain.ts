/** Pure business rules for students. No database, no HTTP: unit-tested in tests/students.domain.test.ts */
export { normalizePhone } from '../../../../shared/kernel/phone.js';

export const MINOR_AGE = 18;

/** Whole years between dob and `on` (birthday not yet reached = one year less). */
export const ageOn = (dob: Date, on: Date): number => {
  let age = on.getUTCFullYear() - dob.getUTCFullYear();
  const beforeBirthday = on.getUTCMonth() < dob.getUTCMonth() || (on.getUTCMonth() === dob.getUTCMonth() && on.getUTCDate() < dob.getUTCDate());
  if (beforeBirthday) age -= 1;
  return age;
};

export const isMinor = (dob: Date | undefined, on: Date): boolean => !!dob && ageOn(dob, on) < MINOR_AGE;

/** DPDP: a child's data may only be processed with the parent/guardian's consent. Returns a plain message when it is missing. */
export const guardianConsentProblem = (dob: Date | undefined, guardianConsentGiven: boolean | undefined, on: Date): string | null => {
  if (isMinor(dob, on) && !guardianConsentGiven) {
    return 'This student is under 18. A parent or guardian must give consent before the profile can be created.';
  }
  return null;
};

export const ERASED_NAME = 'Erased student';

export const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
