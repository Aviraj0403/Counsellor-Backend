import { Router } from 'express';
import { AppError } from '../../../../shared/kernel/errors.js';
import { processWebhook, verifyHandshake, verifySignature } from '../application/whatsapp.webhook.js';

/** PUBLIC (no login). Authenticated by the verify token (GET) and the Meta signature over the raw body (POST). */
export const whatsappPublicRoutes = (): Router => {
  const r = Router();

  r.get('/hooks/whatsapp', (req, res, next) => {
    try {
      if (!verifyHandshake(req.query['hub.mode'], req.query['hub.verify_token'])) throw new AppError(403, 'FORBIDDEN', 'Verification failed.');
      res.status(200).type('text/plain').send(String(req.query['hub.challenge'] ?? ''));
    } catch (e) {
      next(e);
    }
  });

  r.post('/hooks/whatsapp', async (req, res, next) => {
    try {
      if (!verifySignature((req as any).rawBody, req.header('x-hub-signature-256'))) throw new AppError(401, 'BAD_SIGNATURE', 'Signature check failed.');
      res.json({ ok: true, ...(await processWebhook(req.body)) });
    } catch (e) {
      next(e);
    }
  });

  return r;
};
