import express, { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { env } from '../../../../config/env.js';
import type { Guards } from '../../../../contracts/guards.js';
import { validate } from '../../../../shared/http/validate.js';
import { objectId, paging } from '../../../../shared/http/schemas.js';
import { AppError, badRequest } from '../../../../shared/kernel/errors.js';
import {
  deleteDocument,
  getChecklist,
  issueDownloadLink,
  listDocuments,
  listQueue,
  openByToken,
  rejectDocument,
  uploadDocument,
  verifyDocument,
} from '../application/document.service.js';

const id = z.object({ id: objectId });
const typeField = z.string().trim().min(1).max(60);

/** Raw body parser that turns "too large" into a plain-language 413 instead of an unhandled error. */
const rawBody = (req: Request, res: Response, next: NextFunction) =>
  express.raw({ type: '*/*', limit: `${env.MAX_UPLOAD_MB}mb` })(req, res, (err?: unknown) => {
    if ((err as any)?.type === 'entity.too.large') return next(new AppError(413, 'FILE_TOO_LARGE', `The file is too large. The limit is ${env.MAX_UPLOAD_MB} MB.`));
    next(err);
  });

export const documentRoutes = (g: Guards): Router => {
  const r = Router();

  r.post(
    '/',
    g.requirePermission('documents:write'),
    rawBody,
    validate({ query: z.object({ studentId: objectId, type: typeField, applicationId: objectId.optional(), label: z.string().trim().max(120).optional() }) }),
    async (req, res, next) => {
      try {
        const bytes = req.body;
        if (!Buffer.isBuffer(bytes)) throw badRequest('Send the file as the raw request body.');
        const q = req.valid.query;
        res.status(201).json(await uploadDocument(req.principal!, { ...q, fileName: req.header('x-file-name') ?? undefined, bytes }));
      } catch (e) {
        next(e);
      }
    },
  );

  r.get('/', g.requirePermission('documents:read'), validate({ query: z.object({ studentId: objectId, applicationId: objectId.optional() }) }), async (req, res, next) => {
    try {
      res.json(await listDocuments(req.principal!, req.valid.query));
    } catch (e) {
      next(e);
    }
  });

  r.get('/checklist', g.requirePermission('documents:read'), validate({ query: z.object({ studentId: objectId, applicationId: objectId.optional() }) }), async (req, res, next) => {
    try {
      res.json(await getChecklist(req.principal!, req.valid.query));
    } catch (e) {
      next(e);
    }
  });

  r.get(
    '/queue',
    g.requirePermission('documents:verify'),
    validate({ query: paging.extend({ status: z.enum(['pending_review', 'verified', 'rejected']).default('pending_review') }) }),
    async (req, res, next) => {
      try {
        res.json(await listQueue(req.principal!, req.valid.query));
      } catch (e) {
        next(e);
      }
    },
  );

  r.post('/:id/verify', g.requirePermission('documents:verify'), validate({ params: id }), async (req, res, next) => {
    try {
      res.json(await verifyDocument(req.principal!, req.valid.params.id));
    } catch (e) {
      next(e);
    }
  });

  r.post(
    '/:id/reject',
    g.requirePermission('documents:verify'),
    validate({ params: id, body: z.object({ reason: z.string().trim().min(3, 'Tell the student why it was rejected.').max(500) }) }),
    async (req, res, next) => {
      try {
        res.json(await rejectDocument(req.principal!, req.valid.params.id, req.valid.body.reason));
      } catch (e) {
        next(e);
      }
    },
  );

  r.post('/:id/download-link', g.requirePermission('documents:download'), validate({ params: id }), async (req, res, next) => {
    try {
      res.json(await issueDownloadLink(req.principal!, req.valid.params.id));
    } catch (e) {
      next(e);
    }
  });

  r.delete('/:id', g.requirePermission('documents:write'), validate({ params: id }), async (req, res, next) => {
    try {
      res.json(await deleteDocument(req.principal!, req.valid.params.id));
    } catch (e) {
      next(e);
    }
  });

  return r;
};

/** PUBLIC: GET /public/documents/file/:token (the signed link is the credential). */
export const documentPublicRoutes = (): Router => {
  const r = Router();
  r.get('/documents/file/:token', async (req, res, next) => {
    try {
      const f = await openByToken(String(req.params.token));
      res.setHeader('content-type', f.mimeType);
      res.setHeader('content-disposition', `attachment; filename="${f.fileName.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(f.fileName)}`);
      res.setHeader('cache-control', 'no-store');
      res.setHeader('x-content-type-options', 'nosniff');
      res.send(f.bytes);
    } catch (e) {
      next(e);
    }
  });
  return r;
};
