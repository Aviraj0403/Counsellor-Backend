import { Router } from 'express';
import { z } from 'zod';
import type { Guards } from '../../../../contracts/guards.js';
import { validate } from '../../../../shared/http/validate.js';
import { objectId, paging } from '../../../../shared/http/schemas.js';
import { ACTIVITY_KINDS, DUE_FILTERS, ENTITY_TYPES } from '../domain/followup.domain.js';
import { completeTask, createTask, deleteTask, listActivities, listTasks, logActivity, taskSummary, updateTask } from '../application/followup.service.js';

const id = z.object({ id: objectId });
const flag = z.enum(['1', 'true', '0', 'false']).transform((v) => v === '1' || v === 'true');

export const followupRoutes = (g: Guards): Router => {
  const r = Router();

  r.get('/summary', g.requirePermission('followups:read'), async (req, res, next) => {
    try {
      res.json(await taskSummary(req.principal!));
    } catch (e) {
      next(e);
    }
  });

  r.post(
    '/tasks',
    g.requirePermission('followups:write'),
    validate({
      body: z.object({
        entityType: z.enum(ENTITY_TYPES),
        entityId: objectId,
        title: z.string().min(2).max(160),
        notes: z.string().max(1000).optional(),
        dueAt: z.coerce.date(),
        assignedTo: objectId.optional(),
      }),
    }),
    async (req, res, next) => {
      try {
        res.status(201).json(await createTask(req.principal!, req.valid.body));
      } catch (e) {
        next(e);
      }
    },
  );

  r.get(
    '/tasks',
    g.requirePermission('followups:read'),
    validate({
      query: paging.extend({
        mine: flag.optional(),
        status: z.enum(['open', 'done', 'cancelled']).optional(),
        due: z.enum(DUE_FILTERS).optional(),
        entityType: z.enum(ENTITY_TYPES).optional(),
        entityId: objectId.optional(),
        assignedTo: objectId.optional(),
      }),
    }),
    async (req, res, next) => {
      try {
        res.json(await listTasks(req.principal!, req.valid.query));
      } catch (e) {
        next(e);
      }
    },
  );

  r.patch(
    '/tasks/:id',
    g.requirePermission('followups:write'),
    validate({
      params: id,
      body: z.object({
        title: z.string().min(2).max(160).optional(),
        notes: z.string().max(1000).optional(),
        dueAt: z.coerce.date().optional(),
        assignedTo: objectId.optional(),
        status: z.enum(['open', 'cancelled']).optional(),
      }),
    }),
    async (req, res, next) => {
      try {
        res.json(await updateTask(req.principal!, req.valid.params.id, req.valid.body));
      } catch (e) {
        next(e);
      }
    },
  );

  r.post(
    '/tasks/:id/complete',
    g.requirePermission('followups:write'),
    validate({ params: id, body: z.object({ outcome: z.string().max(500).optional() }) }),
    async (req, res, next) => {
      try {
        res.json(await completeTask(req.principal!, req.valid.params.id, req.valid.body.outcome));
      } catch (e) {
        next(e);
      }
    },
  );

  r.delete('/tasks/:id', g.requirePermission('followups:write'), validate({ params: id }), async (req, res, next) => {
    try {
      res.json(await deleteTask(req.principal!, req.valid.params.id));
    } catch (e) {
      next(e);
    }
  });

  r.post(
    '/activities',
    g.requirePermission('followups:write'),
    validate({
      body: z.object({
        entityType: z.enum(ENTITY_TYPES),
        entityId: objectId,
        kind: z.enum(ACTIVITY_KINDS).exclude(['system']),
        direction: z.enum(['in', 'out']).optional(),
        summary: z.string().min(1).max(1000),
        outcome: z.string().max(500).optional(),
        durationSec: z.number().int().min(0).max(86400).optional(),
        at: z.coerce.date().optional(),
      }),
    }),
    async (req, res, next) => {
      try {
        res.status(201).json(await logActivity(req.principal!, req.valid.body));
      } catch (e) {
        next(e);
      }
    },
  );

  r.get(
    '/activities',
    g.requirePermission('followups:read'),
    validate({ query: paging.extend({ entityType: z.enum(ENTITY_TYPES), entityId: objectId }) }),
    async (req, res, next) => {
      try {
        res.json(await listActivities(req.principal!, req.valid.query));
      } catch (e) {
        next(e);
      }
    },
  );

  return r;
};
