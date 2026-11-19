import express, { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import { env } from '../../../../config/env.js';
import type { Guards } from '../../../../contracts/guards.js';
import type { ModuleKey, Permission } from '../../../../contracts/port.js';
import { objectId, paging } from '../../../../shared/http/schemas.js';
import { validate } from '../../../../shared/http/validate.js';
import { AppError, badRequest, forbidden } from '../../../../shared/kernel/errors.js';
import * as college from '../application/college.portal.service.js';
import { disableInvite, inviteCollegeUser, inviteStudent, isInviteDisabled, listInvites } from '../application/invite.service.js';
import * as student from '../application/student.portal.service.js';

const id = z.object({ id: objectId });
const wrap = (fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler => async (req, res, next) => {
  try {
    await fn(req, res);
  } catch (e) {
    next(e);
  }
};

/** Same raw-body parser as the staff upload, with a plain-language 413. */
const rawBody = (req: Request, res: Response, next: NextFunction) =>
  express.raw({ type: '*/*', limit: `${env.MAX_UPLOAD_MB}mb` })(req, res, (err?: unknown) => {
    if ((err as any)?.type === 'entity.too.large') return next(new AppError(413, 'FILE_TOO_LARGE', `The file is too large. The limit is ${env.MAX_UPLOAD_MB} MB.`));
    next(err);
  });

/**
 * One gate per surface: the right permission, the module switched on for the organisation, and a login that was not disabled.
 * (A portal user's id for data always comes from `req.principal.linkedId`, never from the client.)
 */
export const portalGate = (g: Guards, key: 'studentPortal' | 'collegePortal'): RequestHandler[] => {
  const perm: Permission = key === 'studentPortal' ? 'portal:student' : 'portal:college';
  const module: ModuleKey = key;
  return [
    g.requirePermission(perm),
    g.requireModule(module),
    async (req, _res, next) => {
      try {
        const p = req.principal!;
        if (!p.linkedId) throw forbidden('This login is not linked to a student or a college.');
        if (await isInviteDisabled(p.tenantId!, p.userId)) throw forbidden('This portal login has been disabled.');
        next();
      } catch (e) {
        next(e);
      }
    },
  ];
};

export const portalRoutes = (g: Guards): Router => {
  const r = Router();
  const studentOn = g.requireModule('studentPortal');
  const collegeOn = g.requireModule('collegePortal');

  // ---------------------------------------------------------------- staff: invites
  r.post('/student-invites', g.requirePermission('students:write'), studentOn, validate({ body: z.object({ studentId: objectId }) }), wrap(async (req, res) => {
    res.status(201).json(await inviteStudent(req.principal!, req.valid.body.studentId));
  }));
  r.get('/student-invites', g.requirePermission('students:read'), studentOn, validate({ query: paging }), wrap(async (req, res) => {
    res.json(await listInvites(req.principal!, 'student', req.valid.query));
  }));
  r.post('/student-invites/:id/disable', g.requirePermission('students:write'), studentOn, validate({ params: id }), wrap(async (req, res) => {
    res.json(await disableInvite(req.principal!, 'student', req.valid.params.id));
  }));

  r.post(
    '/college-invites',
    g.requirePermission('colleges:write'),
    collegeOn,
    validate({ body: z.object({ collegeId: objectId, name: z.string().trim().min(1).max(120), email: z.string().trim().toLowerCase().email().max(200) }) }),
    wrap(async (req, res) => {
      res.status(201).json(await inviteCollegeUser(req.principal!, req.valid.body));
    }),
  );
  r.get('/college-invites', g.requirePermission('colleges:read'), collegeOn, validate({ query: paging }), wrap(async (req, res) => {
    res.json(await listInvites(req.principal!, 'college', req.valid.query));
  }));
  r.post('/college-invites/:id/disable', g.requirePermission('colleges:write'), collegeOn, validate({ params: id }), wrap(async (req, res) => {
    res.json(await disableInvite(req.principal!, 'college', req.valid.params.id));
  }));

  // ---------------------------------------------------------------- student portal
  const s = Router();
  s.use(...portalGate(g, 'studentPortal'));
  s.get('/overview', wrap(async (req, res) => void res.json(await student.overview(req.principal!))));
  s.get('/applications/:id', validate({ params: id }), wrap(async (req, res) => void res.json(await student.applicationDetail(req.principal!, req.valid.params.id))));
  s.get('/documents', wrap(async (req, res) => void res.json(await student.myDocuments(req.principal!))));
  s.post(
    '/documents',
    rawBody,
    validate({ query: z.object({ type: z.string().trim().min(1).max(60), applicationId: objectId.optional(), label: z.string().trim().max(120).optional() }) }),
    wrap(async (req, res) => {
      if (!Buffer.isBuffer(req.body)) throw badRequest('Send the file as the raw request body.');
      res.status(201).json(await student.uploadOwnDocument(req.principal!, { ...req.valid.query, fileName: req.header('x-file-name') ?? undefined, bytes: req.body }));
    }),
  );
  r.use('/student', s);

  // ---------------------------------------------------------------- college portal
  const c = Router();
  c.use(...portalGate(g, 'collegePortal'));
  c.get('/applications', validate({ query: paging.extend({ status: z.string().max(40).optional() }) }), wrap(async (req, res) => void res.json(await college.listApplications(req.principal!, req.valid.query))));
  c.get('/applications/:id', validate({ params: id }), wrap(async (req, res) => void res.json(await college.applicationDetail(req.principal!, req.valid.params.id))));
  c.post(
    '/applications/:id/status',
    validate({ params: id, body: z.object({ to: z.string().trim().min(1).max(40), note: z.string().trim().max(500).optional() }) }),
    wrap(async (req, res) => void res.json(await college.updateStatus(req.principal!, req.valid.params.id, req.valid.body.to, req.valid.body.note))),
  );
  c.get('/applications/:id/documents', validate({ params: id }), wrap(async (req, res) => void res.json(await college.listDocuments(req.principal!, req.valid.params.id))));
  c.post(
    '/applications/:id/documents/:docId/download-link',
    validate({ params: z.object({ id: objectId, docId: objectId }) }),
    wrap(async (req, res) => void res.json(await college.downloadLink(req.principal!, req.valid.params.id, req.valid.params.docId))),
  );
  r.use('/college', c);

  return r;
};
