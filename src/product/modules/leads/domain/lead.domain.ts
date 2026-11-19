/** Pure business rules for leads. No database, no HTTP: unit-tested in tests/leads.domain.test.ts */

export const LEAD_STAGES = ['new', 'contacted', 'qualified', 'counselling_done', 'application_started', 'admitted', 'lost'] as const;
export type LeadStage = (typeof LEAD_STAGES)[number];

/** Allowed moves. A lead cannot jump from "new" straight to "admitted". A lost lead can be reopened as "new". */
const NEXT: Record<LeadStage, LeadStage[]> = {
  new: ['contacted', 'qualified', 'lost'],
  contacted: ['qualified', 'lost'],
  qualified: ['counselling_done', 'lost'],
  counselling_done: ['application_started', 'lost'],
  application_started: ['admitted', 'lost'],
  admitted: [],
  lost: ['new'],
};

export const canTransition = (from: LeadStage, to: LeadStage): boolean => NEXT[from].includes(to);
export const nextStages = (from: LeadStage): LeadStage[] => [...NEXT[from]];
export const isOpenStage = (s: LeadStage): boolean => s !== 'admitted' && s !== 'lost';

import { normalizePhone } from '../../../../shared/kernel/phone.js';
export { normalizePhone };

export interface ImportRowInput {
  name?: unknown;
  phone?: unknown;
  email?: unknown;
  city?: unknown;
  interestedCourse?: unknown;
}
export interface ImportRowClean {
  row: number;
  name: string;
  phone: string;
  email?: string;
  city?: string;
  interestedCourse?: string;
}
export interface ImportValidation {
  valid: ImportRowClean[];
  invalid: { row: number; reason: string }[];
  /** Rows (1-based) whose phone already appeared earlier in the same file. */
  duplicateRows: number[];
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const text = (v: unknown): string => (v === undefined || v === null ? '' : String(v).trim());

/** Normalises and validates import rows. Row numbers are 1-based positions in the submitted list. A repeated phone inside the file is a duplicate, not invalid. */
export const validateImportRows = (rows: ImportRowInput[]): ImportValidation => {
  const out: ImportValidation = { valid: [], invalid: [], duplicateRows: [] };
  const seen = new Set<string>();
  rows.forEach((raw, i) => {
    const row = i + 1;
    const name = text(raw.name);
    if (name.length < 2) return void out.invalid.push({ row, reason: 'Name is missing (at least 2 letters).' });
    if (name.length > 120) return void out.invalid.push({ row, reason: 'Name is too long (max 120 characters).' });
    const phone = normalizePhone(text(raw.phone));
    if (!phone) return void out.invalid.push({ row, reason: 'Phone is not a valid 10-digit Indian mobile number.' });
    const email = text(raw.email).toLowerCase();
    if (email && !EMAIL.test(email)) return void out.invalid.push({ row, reason: 'Email is not valid.' });
    const city = text(raw.city);
    if (city.length > 80) return void out.invalid.push({ row, reason: 'City is too long (max 80 characters).' });
    const interestedCourse = text(raw.interestedCourse);
    if (interestedCourse.length > 120) return void out.invalid.push({ row, reason: 'Course is too long (max 120 characters).' });
    if (seen.has(phone)) return void out.duplicateRows.push(row);
    seen.add(phone);
    out.valid.push({ row, name, phone, email: email || undefined, city: city || undefined, interestedCourse: interestedCourse || undefined });
  });
  return out;
};

export interface Assignable {
  id: string;
  openLeads: number;
}

/** Least-loaded counsellor gets the next lead; ties go to the lowest id so the result is predictable. */
export const pickAssignee = (candidates: Assignable[]): string | undefined => {
  if (!candidates.length) return undefined;
  return [...candidates].sort((a, b) => a.openLeads - b.openLeads || a.id.localeCompare(b.id))[0]!.id;
};
