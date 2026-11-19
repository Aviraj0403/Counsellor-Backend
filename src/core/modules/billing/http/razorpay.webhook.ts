import { Router } from 'express';
import { AppError } from '../../../../shared/kernel/errors.js';
import { assertWebhookConfigured, handleRazorpayEvent, verifyRazorpaySignature } from '../application/paymentLink.service.js';

/** POST /public/webhooks/razorpay: authenticated by the x-razorpay-signature HMAC over the raw request bytes. */
export const razorpayWebhookRoutes = (): Router => {
  const r = Router();
  r.post('/webhooks/razorpay', async (req, res, next) => {
    try {
      assertWebhookConfigured();
      const sig = req.header('x-razorpay-signature');
      if (!verifyRazorpaySignature((req as any).rawBody, sig)) throw new AppError(401, 'BAD_SIGNATURE', 'Signature check failed.');
      const out = await handleRazorpayEvent(req.body);
      res.json({ ok: true, ...out });
    } catch (e) {
      next(e);
    }
  });
  return r;
};
