/** Pure business rules for colleges and courses. No database, no HTTP: unit-tested in tests/colleges.domain.test.ts */

export const COLLEGE_TYPES = ['university', 'college', 'institute', 'school'] as const;
export const COURSE_LEVELS = ['diploma', 'ug', 'pg', 'phd', 'certificate'] as const;
export type CollegeType = (typeof COLLEGE_TYPES)[number];
export type CourseLevel = (typeof COURSE_LEVELS)[number];

export interface RequiredDocument {
  type: string;
  label: string;
  mandatory: boolean;
}

export interface Intake {
  month: number;
  year: number;
  seats?: number;
  deadline?: Date | string;
}

export interface CourseLike {
  id: string;
  name: string;
  level: CourseLevel;
  stream?: string;
  annualFeePaise: number;
  totalFeePaise?: number;
  intakes: Intake[];
  eligibility?: { minPercentage?: number; requiredExams?: string[]; notes?: string };
}

export interface CollegeLike {
  id: string;
  name: string;
  city?: string;
  state?: string;
  type?: string;
}

export interface ShortlistCriteria {
  percentage: number;
  level: CourseLevel;
  budgetMaxPaise?: number;
  cities?: string[];
  course?: string;
  intakeYear?: number;
}

export interface ShortlistMatch {
  courseId: string;
  collegeId: string;
  courseName: string;
  collegeName: string;
  city?: string;
  annualFeePaise: number;
  score: number;
  reasons: string[];
  nextIntake?: { month: number; year: number; deadline?: string };
}

export const slugify = (s: string): string =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);

const norm = (s: string | undefined) => (s ?? '').trim().toLowerCase();

/** An intake can still be applied to when it has not passed: its deadline (if any) is in the future, otherwise its month is not over. */
export const intakeIsOpen = (i: Intake, now: Date): boolean => {
  if (i.deadline) return new Date(i.deadline).getTime() >= now.getTime();
  const endOfMonth = Date.UTC(i.year, i.month, 1); // first instant of the next month
  return endOfMonth > now.getTime();
};

/** Required documents for a course: the course's own list when it has one, otherwise the college's defaults. */
export const resolveRequiredDocuments = (college: RequiredDocument[] | undefined, course: RequiredDocument[] | undefined): RequiredDocument[] =>
  course && course.length ? course : college ?? [];

/**
 * Shortlist: which courses fit a student? A course is dropped when the level differs, the marks are below the minimum,
 * the yearly fee is over budget, the city is not wanted, the course name does not match, or no intake is still open.
 * Survivors are ranked: closer-to-budget headroom, marks margin, and an exact course-name match score higher.
 */
export const matchCourses = (items: { course: CourseLike; college: CollegeLike }[], c: ShortlistCriteria, now: Date): ShortlistMatch[] => {
  const cities = (c.cities ?? []).map(norm).filter(Boolean);
  const wanted = norm(c.course);
  const out: ShortlistMatch[] = [];
  for (const { course, college } of items) {
    if (course.level !== c.level) continue;
    const min = course.eligibility?.minPercentage;
    if (min !== undefined && c.percentage < min) continue;
    if (c.budgetMaxPaise !== undefined && course.annualFeePaise > c.budgetMaxPaise) continue;
    if (cities.length && !cities.includes(norm(college.city))) continue;
    const nameHit = wanted ? norm(course.name).includes(wanted) || norm(course.stream).includes(wanted) : false;
    if (wanted && !nameHit) continue;
    const open = course.intakes.filter((i) => (c.intakeYear ? i.year === c.intakeYear : true) && intakeIsOpen(i, now));
    if (!open.length) continue;
    open.sort((a, b) => a.year - b.year || a.month - b.month);
    const next = open[0]!;

    const reasons: string[] = [];
    let score = 50;
    if (min !== undefined) {
      const margin = c.percentage - min;
      score += Math.min(20, margin);
      reasons.push(`Marks ${c.percentage}% meet the ${min}% requirement`);
    } else reasons.push('No minimum marks listed');
    if (c.budgetMaxPaise !== undefined && c.budgetMaxPaise > 0) {
      const headroom = (c.budgetMaxPaise - course.annualFeePaise) / c.budgetMaxPaise;
      score += Math.round(headroom * 20);
      reasons.push('Yearly fee is within budget');
    }
    if (cities.length) {
      score += 5;
      reasons.push(`In ${college.city}`);
    }
    if (nameHit) {
      score += 10;
      reasons.push('Matches the course you asked for');
    }
    out.push({
      courseId: course.id,
      collegeId: college.id,
      courseName: course.name,
      collegeName: college.name,
      city: college.city,
      annualFeePaise: course.annualFeePaise,
      score,
      reasons,
      nextIntake: { month: next.month, year: next.year, deadline: next.deadline ? new Date(next.deadline).toISOString() : undefined },
    });
  }
  return out.sort((a, b) => b.score - a.score || a.annualFeePaise - b.annualFeePaise || a.collegeName.localeCompare(b.collegeName));
};

export interface ImportRow {
  name?: string;
  slug?: string;
  type?: string;
  city?: string;
  state?: string;
  website?: string;
  affiliation?: string;
  description?: string;
  contactName?: string;
  contactEmail?: string;
  contactPhone?: string;
  courseName?: string;
  level?: string;
  stream?: string;
  durationMonths?: number | string;
  annualFeeRupees?: number | string;
}

export interface CleanImportRow {
  college: { name: string; slug: string; type: CollegeType; city: string; state?: string; website?: string; affiliation?: string; description?: string; contact?: { name?: string; email?: string; phone?: string } };
  course?: { name: string; level: CourseLevel; stream?: string; durationMonths?: number; annualFeePaise: number };
}

const num = (v: unknown): number | undefined => {
  if (v === undefined || v === null || String(v).trim() === '') return undefined;
  const n = Number(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : NaN;
};

/** Validates one import row. Returns the cleaned data, or a plain-language reason the row was rejected. */
export const validateImportRow = (row: ImportRow): { ok: true; value: CleanImportRow } | { ok: false; reason: string } => {
  const name = (row.name ?? '').toString().trim();
  if (name.length < 2) return { ok: false, reason: 'College name is missing.' };
  const city = (row.city ?? '').toString().trim();
  if (!city) return { ok: false, reason: 'City is missing.' };
  const type = norm(row.type) || 'college';
  if (!(COLLEGE_TYPES as readonly string[]).includes(type)) return { ok: false, reason: `Type "${row.type}" is not one of ${COLLEGE_TYPES.join(', ')}.` };
  const slug = slugify(row.slug ? String(row.slug) : `${name}-${city}`);
  if (!slug) return { ok: false, reason: 'Could not make a web address (slug) from the name.' };
  const website = row.website ? String(row.website).trim() : undefined;
  if (website && !/^https?:\/\/\S+$/i.test(website)) return { ok: false, reason: 'Website must start with http:// or https://.' };
  const email = row.contactEmail ? String(row.contactEmail).trim() : undefined;
  if (email && !/^\S+@\S+\.\S+$/.test(email)) return { ok: false, reason: 'Contact email is not valid.' };

  const value: CleanImportRow = {
    college: {
      name,
      slug,
      type: type as CollegeType,
      city,
      state: row.state ? String(row.state).trim() : undefined,
      website,
      affiliation: row.affiliation ? String(row.affiliation).trim() : undefined,
      description: row.description ? String(row.description).trim() : undefined,
      contact: row.contactName || email || row.contactPhone ? { name: row.contactName ? String(row.contactName).trim() : undefined, email, phone: row.contactPhone ? String(row.contactPhone).trim() : undefined } : undefined,
    },
  };

  const courseName = (row.courseName ?? '').toString().trim();
  if (courseName) {
    const level = norm(row.level);
    if (!(COURSE_LEVELS as readonly string[]).includes(level)) return { ok: false, reason: `Course level "${row.level ?? ''}" must be one of ${COURSE_LEVELS.join(', ')}.` };
    const fee = num(row.annualFeeRupees);
    if (fee === undefined || Number.isNaN(fee) || fee < 0) return { ok: false, reason: 'Annual fee (in rupees) is missing or not a number.' };
    const dur = num(row.durationMonths);
    if (dur !== undefined && (Number.isNaN(dur) || dur < 1 || dur > 120)) return { ok: false, reason: 'Duration must be between 1 and 120 months.' };
    value.course = {
      name: courseName,
      level: level as CourseLevel,
      stream: row.stream ? String(row.stream).trim() : undefined,
      durationMonths: dur,
      annualFeePaise: Math.round(fee * 100),
    };
  }
  return { ok: true, value };
};
