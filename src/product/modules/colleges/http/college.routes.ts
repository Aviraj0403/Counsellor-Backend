import { Router } from 'express';
import { z } from 'zod';
import type { Guards } from '../../../../contracts/guards.js';
import { validate } from '../../../../shared/http/validate.js';
import { objectId, paging } from '../../../../shared/http/schemas.js';
import { COLLEGE_TYPES, COURSE_LEVELS } from '../domain/college.domain.js';
import {
  createCollege,
  createCourse,
  deactivateCollege,
  deactivateCourse,
  getCollegeDetail,
  importColleges,
  listColleges,
  listCourses,
  shortlist,
  updateCollege,
  updateCourse,
} from '../application/college.service.js';

const str = (n: number) => z.string().trim().max(n);
const id = z.object({ id: objectId });
const reqDoc = z.object({ type: str(60).min(1), label: str(120).min(1), mandatory: z.boolean().default(true) });
const bool = z.enum(['1', 'true', '0', 'false']).transform((v) => v === '1' || v === 'true');
const paise = z.coerce.number().int().min(0);

const collegeBody = {
  name: str(160).min(2),
  slug: str(80).optional(),
  type: z.enum(COLLEGE_TYPES).optional(),
  city: str(80).optional(),
  state: str(80).optional(),
  country: str(60).optional(),
  website: z.string().url().max(300).optional(),
  contact: z.object({ name: str(120).optional(), email: z.string().email().optional(), phone: str(20).optional() }).optional(),
  affiliation: str(160).optional(),
  accreditations: z.array(str(80)).max(20).optional(),
  description: str(4000).optional(),
  requiredDocuments: z.array(reqDoc).max(30).optional(),
  active: z.boolean().optional(),
};

const courseBody = {
  name: str(160).min(2),
  level: z.enum(COURSE_LEVELS),
  stream: str(80).optional(),
  durationMonths: z.number().int().min(1).max(120).optional(),
  annualFeePaise: z.number().int().min(0),
  totalFeePaise: z.number().int().min(0).optional(),
  intakes: z
    .array(z.object({ month: z.number().int().min(1).max(12), year: z.number().int().min(2000).max(2100), seats: z.number().int().min(0).optional(), deadline: z.string().datetime({ offset: true }).or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).optional() }))
    .max(24)
    .optional(),
  eligibility: z.object({ minPercentage: z.number().min(0).max(100).optional(), requiredExams: z.array(str(60)).max(10).optional(), notes: str(1000).optional() }).optional(),
  requiredDocuments: z.array(reqDoc).max(30).optional(),
  active: z.boolean().optional(),
};

const importRow = z.object({
  name: z.any().optional(),
  slug: z.any().optional(),
  type: z.any().optional(),
  city: z.any().optional(),
  state: z.any().optional(),
  website: z.any().optional(),
  affiliation: z.any().optional(),
  description: z.any().optional(),
  contactName: z.any().optional(),
  contactEmail: z.any().optional(),
  contactPhone: z.any().optional(),
  courseName: z.any().optional(),
  level: z.any().optional(),
  stream: z.any().optional(),
  durationMonths: z.any().optional(),
  annualFeeRupees: z.any().optional(),
});

export const collegeRoutes = (g: Guards): Router => {
  const r = Router();
  const wrap = (fn: (req: any) => Promise<unknown>, status = 200) => async (req: any, res: any, next: any) => {
    try {
      res.status(status).json(await fn(req));
    } catch (e) {
      next(e);
    }
  };

  // ---- fixed paths first (before /:id)
  r.post('/import', g.requirePermission('colleges:write'), validate({ body: z.object({ rows: z.array(importRow).min(1).max(500) }) }), wrap((req) => importColleges(req.principal, req.valid.body.rows)));

  r.post(
    '/shortlist',
    g.requirePermission('colleges:read'),
    validate({
      body: z.object({
        percentage: z.number().min(0).max(100),
        level: z.enum(COURSE_LEVELS),
        budgetMaxPaise: z.number().int().min(0).optional(),
        cities: z.array(str(80)).max(20).optional(),
        course: str(120).optional(),
        intakeYear: z.number().int().min(2000).max(2100).optional(),
      }),
    }),
    wrap((req) => shortlist(req.principal, req.valid.body)),
  );

  r.post('/', g.requirePermission('colleges:write'), validate({ body: z.object(collegeBody) }), wrap((req) => createCollege(req.principal, req.valid.body), 201));

  r.get(
    '/',
    g.requirePermission('colleges:read'),
    validate({
      query: paging.extend({
        search: z.string().max(80).optional(),
        city: z.string().max(80).optional(),
        state: z.string().max(80).optional(),
        type: z.enum(COLLEGE_TYPES).optional(),
        active: bool.optional(),
        level: z.enum(COURSE_LEVELS).optional(),
        course: z.string().max(120).optional(),
        feeMinPaise: paise.optional(),
        feeMaxPaise: paise.optional(),
        intakeYear: z.coerce.number().int().min(2000).max(2100).optional(),
      }),
    }),
    wrap((req) => listColleges(req.principal, req.valid.query)),
  );

  r.get('/:id', g.requirePermission('colleges:read'), validate({ params: id }), wrap((req) => getCollegeDetail(req.principal, req.valid.params.id)));
  r.patch('/:id', g.requirePermission('colleges:write'), validate({ params: id, body: z.object(collegeBody).partial() }), wrap((req) => updateCollege(req.principal, req.valid.params.id, req.valid.body)));
  r.delete('/:id', g.requirePermission('colleges:write'), validate({ params: id }), wrap((req) => deactivateCollege(req.principal, req.valid.params.id)));

  // ---- courses
  const cid = z.object({ id: objectId, courseId: objectId });
  r.get('/:id/courses', g.requirePermission('colleges:read'), validate({ params: id }), wrap((req) => listCourses(req.principal, req.valid.params.id)));
  r.post('/:id/courses', g.requirePermission('colleges:write'), validate({ params: id, body: z.object(courseBody) }), wrap((req) => createCourse(req.principal, req.valid.params.id, req.valid.body), 201));
  r.patch('/:id/courses/:courseId', g.requirePermission('colleges:write'), validate({ params: cid, body: z.object(courseBody).partial() }), wrap((req) => updateCourse(req.principal, req.valid.params.id, req.valid.params.courseId, req.valid.body)));
  r.delete('/:id/courses/:courseId', g.requirePermission('colleges:write'), validate({ params: cid }), wrap((req) => deactivateCourse(req.principal, req.valid.params.id, req.valid.params.courseId)));

  return r;
};
