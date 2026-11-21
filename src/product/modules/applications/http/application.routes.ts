import { Router } from 'express';
import { z } from 'zod';
import type { Guards } from '../../../../contracts/guards.js';
import { objectId, paging } from '../../../../shared/http/schemas.js';
import { validate } from '../../../../shared/http/validate.js';
import { STATUSES } from '../domain/application.domain.js';
import { changeApplicationStatus, createApplication, getApplicationForPrincipal, listApplications, updateApplication } from '../application/application.service.js';
import { createStudentFeeLink, listStudentFeeLinks, markStudentFeePaid } from '../application/studentFee.service.js';

const id = z.object({ id: objectId });
const paise = z.number().int().min(0).max(1_000_000_000_00);
const fee = z.object({ applicationFeePaise: paise.optional(), tuitionPaise: paise.optional() });

export const applicationRoutes = (g: Guards): Router => {
  const r = Router();

  r.post(
    '/',
    g.requirePermission('applications:write'),
    validate({
      body: z.object({
        studentId: objectId,
        collegeId: objectId,
        courseId: objectId,
        intake: z.object({ month: z.number().int().min(1).max(12), year: z.number().int().min(2000).max(2100) }),
        assignedTo: objectId.optional(),
        collegeRef: z.string().trim().max(80).optional(),
        fee: fee.optional(),
        notes: z.string().trim().max(2000).optional(),
      }),
    }),
    async (req, res, next) => {
      try {
        res.status(201).json(await createApplication(req.principal!, req.valid.body));
      } catch (e) {
        next(e);
      }
    },
  );

  r.get(
    '/',
    g.requirePermission('applications:read'),
    validate({ query: paging.extend({ status: z.enum(STATUSES).optional(), collegeId: objectId.optional(), assignedTo: objectId.optional(), studentId: objectId.optional() }) }),
    async (req, res, next) => {
      try {
        res.json(await listApplications(req.principal!, req.valid.query));
      } catch (e) {
        next(e);
      }
    },
  );

  r.get('/:id', g.requirePermission('applications:read'), validate({ params: id }), async (req, res, next) => {
    try {
      res.json(await getApplicationForPrincipal(req.principal!, req.valid.params.id));
    } catch (e) {
      next(e);
    }
  });

  r.patch(
    '/:id',
    g.requirePermission('applications:write'),
    validate({
      params: id,
      body: z.object({
        notes: z.string().trim().max(2000).optional(),
        collegeRef: z.string().trim().max(80).optional(),
        assignedTo: objectId.optional(),
        fee: fee.optional(),
        offer: z
          .object({ scholarshipPaise: paise.optional(), deadline: z.string().regex(/^\d{4}-\d{2}-\d{2}/, 'Use the format YYYY-MM-DD').optional(), note: z.string().trim().max(500).optional() })
          .optional(),
      }),
    }),
    async (req, res, next) => {
      try {
        res.json(await updateApplication(req.principal!, req.valid.params.id, req.valid.body));
      } catch (e) {
        next(e);
      }
    },
  );

  r.post(
    '/:id/status',
    g.requirePermission('applications:status'),
    validate({ params: id, body: z.object({ to: z.enum(STATUSES), note: z.string().trim().max(500).optional(), feePaidPaise: paise.optional() }) }),
    async (req, res, next) => {
      try {
        const b = req.valid.body;
        res.json(await changeApplicationStatus(req.principal!, req.valid.params.id, b.to, b.note, b.feePaidPaise));
      } catch (e) {
        next(e);
      }
    },
  );

  // ---- Student Fee Links & Online Payments
  r.get(
    '/fee-links/list',
    g.requirePermission('applications:read'),
    validate({ query: z.object({ studentId: objectId.optional(), applicationId: objectId.optional() }) }),
    async (req, res, next) => {
      try {
        res.json({ items: await listStudentFeeLinks(req.principal!.tenantId!, req.valid.query) });
      } catch (e) {
        next(e);
      }
    },
  );

  r.post(
    '/fee-links',
    g.requirePermission('applications:write'),
    validate({
      body: z.object({
        studentId: objectId,
        applicationId: objectId.optional(),
        title: z.string().min(2).max(150),
        amountRupees: z.number().min(1),
        notes: z.string().max(300).optional(),
      }),
    }),
    async (req, res, next) => {
      try {
        res.status(201).json(await createStudentFeeLink(req.principal!, req.valid.body));
      } catch (e) {
        next(e);
      }
    },
  );

  r.post(
    '/fee-links/:linkId/mark-paid',
    g.requirePermission('applications:write'),
    validate({
      params: z.object({ linkId: objectId }),
      body: z.object({
        paymentId: z.string().optional(),
        notes: z.string().max(200).optional(),
      }),
    }),
    async (req, res, next) => {
      try {
        res.json(await markStudentFeePaid(req.principal!.tenantId!, req.valid.params.linkId, req.valid.body, req.principal!.userId));
      } catch (e) {
        next(e);
      }
    },
  );

  return r;
};
