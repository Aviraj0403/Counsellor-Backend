import { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { AppError, notFound } from '../../../../shared/kernel/errors.js';
import { sha256Hex } from '../../../../shared/infra/crypto.js';
import { loadBotSite, verifyInboundSignature, type BotSite } from '../application/bot.public.js';
import { handleTurn, publicBotConfig } from '../application/bot.service.js';
import { allowRate, MAX_MESSAGE_CHARS } from '../domain/bots.domain.js';
import { normalizePhone } from '../../../../shared/kernel/phone.js';

/** Per IP (router limiter) and per visitor (sliding window): generous for a person, hard for a script. */
export const BOT_IP_LIMIT = 300;
export const BOT_IP_WINDOW_MS = 10 * 60_000;
export const BOT_VISITOR_LIMIT = 12;
export const BOT_VISITOR_WINDOW_MS = 60_000;

const visitorBuckets = new Map<string, number[]>();
export const resetVisitorLimits = (): void => visitorBuckets.clear();

const wrap = (fn: (req: Request, res: Response) => Promise<void>): RequestHandler => (req, res, next: NextFunction) => {
  fn(req, res).catch(next);
};

const messageBody = z.object({
  visitorToken: z.string().regex(/^[a-f0-9]{32,128}$/i, 'Invalid visitor token.').optional(),
  message: z.string().trim().min(1, 'Please type a message.').max(MAX_MESSAGE_CHARS, `Messages can be at most ${MAX_MESSAGE_CHARS} characters.`),
  consent: z.boolean().optional(),
});

const inboundBody = z.object({
  slug: z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9-]{1,60}$/),
  from: z.string().trim().min(6).max(20),
  text: z.string().trim().min(1).max(MAX_MESSAGE_CHARS),
});

/** PUBLIC (no login). The organisation comes from the slug in the URL; unknown, suspended, module off or bot off = 404. */
export const botsPublicRoutes = (): Router => {
  const r = Router();
  const ipLimiter = rateLimit({
    windowMs: BOT_IP_WINDOW_MS,
    limit: BOT_IP_LIMIT,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (_req, _res, next) => next(new AppError(429, 'RATE_LIMITED', 'Too many messages from this connection. Please try again later.')),
  });

  r.get('/:slug/bot/config', wrap(async (req, res) => {
    const site = await loadBotSite(String(req.params.slug), 'web');
    if (!site) throw notFound('Assistant');
    res.set('Cache-Control', 'no-store').json(await publicBotConfig(site.tenantId));
  }));

  r.post('/:slug/bot/message', ipLimiter, wrap(async (req, res) => {
    const site: BotSite | null = await loadBotSite(String(req.params.slug), 'web');
    if (!site) throw notFound('Assistant');
    const body = messageBody.parse(req.body ?? {});
    // A first message (no token yet) is limited by the per-IP limiter above; a running conversation is limited per visitor.
    if (body.visitorToken && !allowRate(visitorBuckets, `${site.tenantId}:${sha256Hex(body.visitorToken)}`, Date.now(), BOT_VISITOR_LIMIT, BOT_VISITOR_WINDOW_MS)) throw new AppError(429, 'RATE_LIMITED', 'You are sending messages too fast. Please wait a minute.');
    const out = await handleTurn({ tenantId: site.tenantId, orgName: site.orgName, channel: 'web', text: body.message, visitorToken: body.visitorToken, consent: body.consent });
    res.set('Cache-Control', 'no-store').json({ reply: out.reply, visitorToken: out.visitorToken, status: out.status, handedOff: out.handedOff, handoffReason: out.handoffReason, offline: out.offline, limited: out.limited });
  }));

  /**
   * WhatsApp hand-over: a trusted relay (the platform's WhatsApp webhook worker, or a gateway) posts `{slug, from, text}` signed with
   * BOT_INBOUND_SECRET. The reply is returned in the response; sending it back to the student over WhatsApp is the relay's job
   * (the whatsapp module has no event for inbound text, and its public API sends templates only).
   */
  r.post('/bot/whatsapp/inbound', ipLimiter, wrap(async (req, res) => {
    if (!verifyInboundSignature((req as any).rawBody, req.header('x-bot-signature'))) throw new AppError(401, 'BAD_SIGNATURE', 'Signature check failed.');
    const body = inboundBody.parse(req.body ?? {});
    const phone = normalizePhone(body.from);
    if (!phone) throw new AppError(400, 'BAD_REQUEST', 'Invalid sender number.');
    const site = await loadBotSite(body.slug, 'whatsapp');
    if (!site) throw notFound('Assistant');
    if (!allowRate(visitorBuckets, `${site.tenantId}:wa:${phone}`, Date.now(), BOT_VISITOR_LIMIT, BOT_VISITOR_WINDOW_MS)) throw new AppError(429, 'RATE_LIMITED', 'Too many messages from this number.');
    const out = await handleTurn({ tenantId: site.tenantId, orgName: site.orgName, channel: 'whatsapp', text: body.text, externalKey: phone, consent: true });
    res.json({ reply: out.reply, status: out.status, handedOff: out.handedOff, handoffReason: out.handoffReason, offline: out.offline, limited: out.limited });
  }));

  return r;
};
