import type { Principal } from '../../../../contracts/port.js';
import { badRequest, conflict, notFound } from '../../../../shared/kernel/errors.js';
import { audit } from '../../audit/index.js';
import {
  matchCourses,
  resolveRequiredDocuments,
  slugify,
  validateImportRow,
  type ImportRow,
  type RequiredDocument,
  type ShortlistCriteria,
} from '../domain/college.domain.js';
import { predictColleges, type PredictorInput } from '../domain/predictor.domain.js';
import { CollegeModel, CourseModel } from '../infrastructure/college.model.js';

const OBJECT_ID = /^[a-f\d]{24}$/i;
const isDuplicateKey = (e: any) => e?.code === 11000;
const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export interface CollegeInput {
  name: string;
  slug?: string;
  type?: string;
  city?: string;
  state?: string;
  country?: string;
  website?: string;
  contact?: { name?: string; email?: string; phone?: string };
  affiliation?: string;
  accreditations?: string[];
  description?: string;
  requiredDocuments?: RequiredDocument[];
  active?: boolean;
}

export interface CourseInput {
  name: string;
  level: string;
  stream?: string;
  durationMonths?: number;
  annualFeePaise: number;
  totalFeePaise?: number;
  intakes?: { month: number; year: number; seats?: number; deadline?: string }[];
  eligibility?: { minPercentage?: number; requiredExams?: string[]; notes?: string };
  requiredDocuments?: RequiredDocument[];
  active?: boolean;
}

const withIntakeDates = <T extends { intakes?: { deadline?: string }[] }>(c: T) => ({
  ...c,
  intakes: c.intakes?.map((i) => ({ ...i, deadline: i.deadline ? new Date(i.deadline) : undefined })),
});

export const createCollege = async (p: Principal, input: CollegeInput) => {
  const tenantId = p.tenantId!;
  const slug = slugify(input.slug ?? `${input.name}-${input.city ?? ''}`);
  if (!slug) throw badRequest('Could not make a web address (slug) from this name.');
  try {
    const doc = await CollegeModel(tenantId).create({ ...input, slug });
    await audit(tenantId, { action: 'college.created', entity: 'college', entityId: String(doc._id), meta: { slug } });
    return doc.toObject();
  } catch (e) {
    if (isDuplicateKey(e)) throw conflict(`A college with the web address "${slug}" already exists.`);
    throw e;
  }
};

export const updateCollege = async (p: Principal, id: string, patch: Partial<CollegeInput>) => {
  const tenantId = p.tenantId!;
  const set: Record<string, unknown> = { ...patch };
  if (patch.slug !== undefined) set.slug = slugify(patch.slug);
  try {
    const doc = await CollegeModel(tenantId).findByIdAndUpdate(id, { $set: set }, { new: true }).lean<any>();
    if (!doc) throw notFound('College');
    await audit(tenantId, { action: 'college.updated', entity: 'college', entityId: id, meta: { fields: Object.keys(patch) } });
    return doc;
  } catch (e) {
    if (isDuplicateKey(e)) throw conflict('Another college already uses this web address.');
    throw e;
  }
};

export interface CollegeListQuery {
  page: number;
  limit: number;
  search?: string;
  city?: string;
  state?: string;
  type?: string;
  active?: boolean;
  level?: string;
  course?: string;
  feeMinPaise?: number;
  feeMaxPaise?: number;
  intakeYear?: number;
}

export const listColleges = async (p: Principal, q: CollegeListQuery) => {
  const tenantId = p.tenantId!;
  const filter: Record<string, unknown> = {};
  if (q.search) filter.name = new RegExp(escapeRegex(q.search), 'i');
  if (q.city) filter.city = new RegExp(`^${escapeRegex(q.city)}$`, 'i');
  if (q.state) filter.state = new RegExp(`^${escapeRegex(q.state)}$`, 'i');
  if (q.type) filter.type = q.type;
  if (q.active !== undefined) filter.active = q.active;

  const courseFilter: Record<string, unknown> = {};
  if (q.level) courseFilter.level = q.level;
  if (q.course) courseFilter.name = new RegExp(escapeRegex(q.course), 'i');
  if (q.feeMinPaise !== undefined || q.feeMaxPaise !== undefined) {
    courseFilter.annualFeePaise = {
      ...(q.feeMinPaise !== undefined ? { $gte: q.feeMinPaise } : {}),
      ...(q.feeMaxPaise !== undefined ? { $lte: q.feeMaxPaise } : {}),
    };
  }
  if (q.intakeYear !== undefined) courseFilter['intakes.year'] = q.intakeYear;
  if (Object.keys(courseFilter).length) {
    const ids = await CourseModel(tenantId).distinct('collegeId', { ...courseFilter, active: true });
    filter._id = { $in: ids };
  }

  const College = CollegeModel(tenantId);
  const [items, total] = await Promise.all([
    College.find(filter).sort({ name: 1 }).skip((q.page - 1) * q.limit).limit(q.limit).lean(),
    College.countDocuments(filter),
  ]);
  return { items, total, page: q.page, limit: q.limit };
};

export const getCollegeDetail = async (p: Principal, id: string) => {
  const tenantId = p.tenantId!;
  const college = await CollegeModel(tenantId).findById(id).lean<any>();
  if (!college) throw notFound('College');
  const courses = await CourseModel(tenantId).find({ collegeId: id }).sort({ name: 1 }).lean();
  return { ...college, courses };
};

const requireCollege = async (tenantId: string, id: string) => {
  const c = await CollegeModel(tenantId).findById(id).lean<any>();
  if (!c) throw notFound('College');
  return c;
};

export const listCourses = async (p: Principal, collegeId: string) => {
  await requireCollege(p.tenantId!, collegeId);
  return { items: await CourseModel(p.tenantId!).find({ collegeId }).sort({ name: 1 }).lean() };
};

export const createCourse = async (p: Principal, collegeId: string, input: CourseInput) => {
  const tenantId = p.tenantId!;
  await requireCollege(tenantId, collegeId);
  try {
    const doc = await CourseModel(tenantId).create({ ...withIntakeDates(input), collegeId });
    await audit(tenantId, { action: 'course.created', entity: 'course', entityId: String(doc._id), meta: { collegeId } });
    return doc.toObject();
  } catch (e) {
    if (isDuplicateKey(e)) throw conflict('This college already has a course with the same name and level.');
    throw e;
  }
};

export const updateCourse = async (p: Principal, collegeId: string, courseId: string, patch: Partial<CourseInput>) => {
  const tenantId = p.tenantId!;
  try {
    const doc = await CourseModel(tenantId).findOneAndUpdate({ _id: courseId, collegeId }, { $set: withIntakeDates(patch) }, { new: true }).lean<any>();
    if (!doc) throw notFound('Course');
    await audit(tenantId, { action: 'course.updated', entity: 'course', entityId: courseId, meta: { collegeId, fields: Object.keys(patch) } });
    return doc;
  } catch (e) {
    if (isDuplicateKey(e)) throw conflict('This college already has a course with the same name and level.');
    throw e;
  }
};

/** Courses are deactivated, never deleted (applications may refer to them later). */
export const deactivateCourse = async (p: Principal, collegeId: string, courseId: string) => {
  const doc = await CourseModel(p.tenantId!).findOneAndUpdate({ _id: courseId, collegeId }, { $set: { active: false } }, { new: true }).lean<any>();
  if (!doc) throw notFound('Course');
  await audit(p.tenantId!, { action: 'course.deactivated', entity: 'course', entityId: courseId, meta: { collegeId } });
  return doc;
};

export const deactivateCollege = async (p: Principal, id: string) => {
  const doc = await CollegeModel(p.tenantId!).findByIdAndUpdate(id, { $set: { active: false } }, { new: true }).lean<any>();
  if (!doc) throw notFound('College');
  await audit(p.tenantId!, { action: 'college.deactivated', entity: 'college', entityId: id });
  return doc;
};

/** Bulk import: per-row validation, upsert college by slug, upsert course by (college, name, level). One audit summary row. */
export const importColleges = async (p: Principal, rows: ImportRow[]) => {
  const tenantId = p.tenantId!;
  const College = CollegeModel(tenantId);
  const Course = CourseModel(tenantId);
  const report = { total: rows.length, collegesCreated: 0, collegesUpdated: 0, coursesCreated: 0, coursesUpdated: 0, invalid: [] as { row: number; reason: string }[] };
  for (let i = 0; i < rows.length; i++) {
    const v = validateImportRow(rows[i]!);
    if (!v.ok) {
      report.invalid.push({ row: i + 1, reason: v.reason });
      continue;
    }
    try {
      const { college, course } = v.value;
      const { slug, ...rest } = college;
      const before = await College.findOneAndUpdate({ slug }, { $set: rest, $setOnInsert: { slug, country: 'India', active: true } }, { upsert: true, new: false }).lean<any>();
      if (before) report.collegesUpdated++;
      else report.collegesCreated++;
      if (course) {
        const saved = await College.findOne({ slug }).select('_id').lean<any>();
        const cid = String(saved._id);
        const prev = await Course.findOneAndUpdate(
          { collegeId: cid, name: course.name, level: course.level },
          { $set: { stream: course.stream, durationMonths: course.durationMonths, annualFeePaise: course.annualFeePaise }, $setOnInsert: { collegeId: cid, name: course.name, level: course.level, active: true } },
          { upsert: true, new: false },
        ).lean<any>();
        if (prev) report.coursesUpdated++;
        else report.coursesCreated++;
      }
    } catch (e: any) {
      report.invalid.push({ row: i + 1, reason: isDuplicateKey(e) ? 'Duplicate record in the same file.' : 'Could not save this row.' });
    }
  }
  await audit(tenantId, { action: 'college.imported', entity: 'college', meta: { ...report, invalid: report.invalid.length } });
  return report;
};

export const shortlist = async (p: Principal, criteria: ShortlistCriteria) => {
  const tenantId = p.tenantId!;
  const colleges = await CollegeModel(tenantId).find({ active: true }).lean<any[]>();
  const byId = new Map(colleges.map((c) => [String(c._id), c]));
  const courses = await CourseModel(tenantId).find({ active: true, level: criteria.level, collegeId: { $in: [...byId.keys()] } }).lean<any[]>();
  const items = courses.map((c) => {
    const col = byId.get(c.collegeId)!;
    return {
      course: { id: String(c._id), name: c.name, level: c.level, stream: c.stream, annualFeePaise: c.annualFeePaise, totalFeePaise: c.totalFeePaise, intakes: c.intakes ?? [], eligibility: c.eligibility },
      college: { id: String(col._id), name: col.name, city: col.city, state: col.state, type: col.type },
    };
  });
  const matches = matchCourses(items, criteria, new Date());
  return { total: matches.length, items: matches };
};

export const predictBTechAdmission = async (tenantId: string, input: PredictorInput) => {
  const colleges = await CollegeModel(tenantId).find({ active: true }).lean<any[]>();
  const byId = new Map(colleges.map((c) => [String(c._id), c]));
  const courses = await CourseModel(tenantId).find({ active: true, level: 'ug', collegeId: { $in: [...byId.keys()] } }).lean<any[]>();
  const items = courses.map((c) => {
    const col = byId.get(c.collegeId)!;
    return {
      course: { id: String(c._id), name: c.name, level: c.level, stream: c.stream, annualFeePaise: c.annualFeePaise, totalFeePaise: c.totalFeePaise, intakes: c.intakes ?? [], eligibility: c.eligibility },
      college: { id: String(col._id), name: col.name, city: col.city, state: col.state, type: col.type },
    };
  });
  return predictColleges(items, input);
};

/** ---- public API for other modules (inside one organisation) ---- */
export const getCollege = async (tenantId: string, id: string) => (OBJECT_ID.test(id) ? CollegeModel(tenantId).findById(id).lean<any>() : null);
export const getCourse = async (tenantId: string, id: string) => (OBJECT_ID.test(id) ? CourseModel(tenantId).findById(id).lean<any>() : null);
export const listActiveColleges = async (tenantId: string) => CollegeModel(tenantId).find({ active: true }).sort({ name: 1 }).lean<any[]>();

export const getRequiredDocuments = async (tenantId: string, collegeId: string, courseId?: string): Promise<RequiredDocument[]> => {
  const college = await getCollege(tenantId, collegeId);
  if (!college) return [];
  const course = courseId ? await getCourse(tenantId, courseId) : null;
  const strip = (l?: any[]): RequiredDocument[] | undefined => l?.map((d) => ({ type: d.type, label: d.label, mandatory: !!d.mandatory }));
  return resolveRequiredDocuments(strip(college.requiredDocuments), course && course.collegeId === collegeId ? strip(course.requiredDocuments) : undefined);
};
