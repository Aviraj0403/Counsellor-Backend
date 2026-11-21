import { Router } from 'express';
import { z } from 'zod';
import type { Guards } from '../../../../contracts/guards.js';
import { validate } from '../../../../shared/http/validate.js';
import { objectId, paging } from '../../../../shared/http/schemas.js';
import { badRequest } from '../../../../shared/kernel/errors.js';
import {
  createStudent,
  createStudentFromLead,
  eraseStudent,
  exportStudent,
  getStudentForPrincipal,
  listStudents,
  updateStudent,
} from '../application/student.service.js';
import {
  addStudentsToBatch,
  createBatch,
  createSession,
  getBatch,
  listBatches,
  listSessions,
  markAttendance,
  removeStudentFromBatch,
} from '../application/batch.service.js';

const id = z.object({ id: objectId });
const str = (n: number) => z.string().trim().max(n);
const consent = z.object({
  given: z.boolean(),
  source: str(80).optional(),
  guardianConsent: z.object({ given: z.boolean(), by: str(120).optional() }).optional(),
});
const dob = z.string().regex(/^\d{4}-\d{2}-\d{2}/, 'Use the format YYYY-MM-DD');
const profile = {
  email: z.string().email().optional(),
  dob: dob.optional(),
  gender: z.enum(['male', 'female', 'other']).optional(),
  address: z.object({ line: str(200).optional(), city: str(80).optional(), state: str(80).optional(), pincode: str(10).optional() }).optional(),
  guardian: z.object({ name: str(120).optional(), phone: str(20).optional(), relation: str(40).optional() }).optional(),
  academics: z
    .array(z.object({ level: str(40).optional(), board: str(80).optional(), institute: str(160).optional(), year: z.number().int().min(1950).max(2100).optional(), percentage: z.number().min(0).max(100).optional() }))
    .max(20)
    .optional(),
  testScores: z.array(z.object({ test: str(60).optional(), score: z.number().min(0).optional(), year: z.number().int().min(1950).max(2100).optional() })).max(20).optional(),
  preferences: z
    .object({ courses: z.array(str(120)).max(20).optional(), cities: z.array(str(80)).max(20).optional(), budgetMaxPaise: z.number().int().min(0).optional() })
    .optional(),
  assignedTo: objectId.optional(),
};

export const studentRoutes = (g: Guards): Router => {
  const r = Router();

  r.post(
    '/',
    g.requirePermission('students:write'),
    validate({ body: z.object({ name: z.string().trim().min(2).max(120), phone: z.string().min(10).max(20), ...profile, consent }) }),
    async (req, res, next) => {
      try {
        res.status(201).json(await createStudent(req.principal!, req.valid.body));
      } catch (e) {
        next(e);
      }
    },
  );

  r.post(
    '/from-lead/:leadId',
    g.requirePermission('students:write'),
    validate({
      params: z.object({ leadId: objectId }),
      body: z.object({ dob: dob.optional(), guardianConsent: z.object({ given: z.boolean(), by: str(120).optional() }).optional(), extra: z.object({ ...profile }).optional() }).default({}),
    }),
    async (req, res, next) => {
      try {
        res.status(201).json(await createStudentFromLead(req.principal!, req.valid.params.leadId, req.valid.body));
      } catch (e) {
        next(e);
      }
    },
  );

  r.get(
    '/',
    g.requirePermission('students:read'),
    validate({ query: paging.extend({ search: z.string().max(60).optional(), includeErased: z.enum(['1', 'true', '0', 'false']).optional() }) }),
    async (req, res, next) => {
      try {
        const q = req.valid.query;
        res.json(await listStudents(req.principal!, { page: q.page, limit: q.limit, search: q.search, includeErased: q.includeErased === '1' || q.includeErased === 'true' }));
      } catch (e) {
        next(e);
      }
    },
  );

  r.get('/:id/export', g.requirePermission('students:export'), validate({ params: id }), async (req, res, next) => {
    try {
      res.json(await exportStudent(req.principal!, req.valid.params.id));
    } catch (e) {
      next(e);
    }
  });

  r.get('/:id', g.requirePermission('students:read'), validate({ params: id }), async (req, res, next) => {
    try {
      res.json(await getStudentForPrincipal(req.principal!, req.valid.params.id));
    } catch (e) {
      next(e);
    }
  });

  r.patch(
    '/:id',
    g.requirePermission('students:write'),
    validate({ params: id, body: z.object({ name: z.string().trim().min(2).max(120).optional(), phone: z.string().min(10).max(20).optional(), ...profile, consent: consent.optional() }) }),
    async (req, res, next) => {
      try {
        res.json(await updateStudent(req.principal!, req.valid.params.id, req.valid.body));
      } catch (e) {
        next(e);
      }
    },
  );

  r.post(
    '/:id/erase',
    g.requirePermission('students:erase'),
    validate({ params: id, body: z.object({ confirm: z.string(), reason: z.string().trim().min(3).max(500) }) }),
    async (req, res, next) => {
      try {
        if (req.valid.body.confirm !== 'ERASE') throw badRequest('Type ERASE to confirm. This cannot be undone.');
        res.json(await eraseStudent(req.principal!, req.valid.params.id, req.valid.body.reason));
      } catch (e) {
        next(e);
      }
    },
  );

  // ---- Batches, Sessions & Attendance
  r.get('/batches/list', g.requirePermission('students:read'), async (req, res, next) => {
    try {
      res.json({ items: await listBatches(req.principal!.tenantId!, req.query as any) });
    } catch (e) {
      next(e);
    }
  });

  r.get('/batches/:id', g.requirePermission('students:read'), validate({ params: id }), async (req, res, next) => {
    try {
      res.json(await getBatch(req.principal!.tenantId!, req.valid.params.id));
    } catch (e) {
      next(e);
    }
  });

  r.post(
    '/batches',
    g.requirePermission('students:write'),
    validate({
      body: z.object({
        name: z.string().min(2).max(120),
        academicYear: z.string().min(4).max(20),
        courseStream: z.string().max(100).optional(),
        counsellorId: objectId.optional(),
        capacity: z.number().int().min(1).default(50),
        notes: z.string().max(300).optional(),
      }),
    }),
    async (req, res, next) => {
      try {
        res.status(201).json(await createBatch(req.principal!, req.valid.body));
      } catch (e) {
        next(e);
      }
    },
  );

  r.post(
    '/batches/:id/students',
    g.requirePermission('students:write'),
    validate({ params: id, body: z.object({ studentIds: z.array(objectId).min(1) }) }),
    async (req, res, next) => {
      try {
        res.json(await addStudentsToBatch(req.principal!.tenantId!, req.valid.params.id, req.valid.body.studentIds, req.principal!.userId));
      } catch (e) {
        next(e);
      }
    },
  );

  r.delete(
    '/batches/:id/students/:studentId',
    g.requirePermission('students:write'),
    validate({ params: z.object({ id: objectId, studentId: objectId }) }),
    async (req, res, next) => {
      try {
        res.json(await removeStudentFromBatch(req.principal!.tenantId!, req.valid.params.id, req.valid.params.studentId, req.principal!.userId));
      } catch (e) {
        next(e);
      }
    },
  );

  r.get(
    '/batches/:id/sessions',
    g.requirePermission('students:read'),
    validate({ params: id }),
    async (req, res, next) => {
      try {
        res.json({ items: await listSessions(req.principal!.tenantId!, req.valid.params.id) });
      } catch (e) {
        next(e);
      }
    },
  );

  r.post(
    '/batches/:id/sessions',
    g.requirePermission('students:write'),
    validate({
      params: id,
      body: z.object({
        title: z.string().min(2).max(150),
        description: z.string().max(500).optional(),
        sessionDate: z.string().datetime().transform((v) => new Date(v)),
        startTime: z.string().min(2).max(20),
        endTime: z.string().min(2).max(20),
        venue: z.string().max(100).optional(),
      }),
    }),
    async (req, res, next) => {
      try {
        res.status(201).json(await createSession(req.principal!, { ...req.valid.body, batchId: req.valid.params.id }));
      } catch (e) {
        next(e);
      }
    },
  );

  r.post(
    '/sessions/:sessionId/attendance',
    g.requirePermission('students:write'),
    validate({
      params: z.object({ sessionId: objectId }),
      body: z.object({
        records: z.array(
          z.object({
            studentId: objectId,
            status: z.enum(['present', 'absent', 'late', 'excused']),
            notes: z.string().max(150).optional(),
          }),
        ),
      }),
    }),
    async (req, res, next) => {
      try {
        res.json(await markAttendance(req.principal!.tenantId!, req.valid.params.sessionId, req.valid.body.records, req.principal!.userId));
      } catch (e) {
        next(e);
      }
    },
  );

  return r;
};
