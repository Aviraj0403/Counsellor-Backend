import { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import type { Guards } from '../../../../contracts/guards.js';
import { getPlatform } from '../../../../contracts/registry.js';
import { objectId, paging } from '../../../../shared/http/schemas.js';
import { validate } from '../../../../shared/http/validate.js';
import { closeConversation, getConversation, listConversations, purgeExpired, summary, takeover } from '../application/bot.admin.js';
import { handleTurn } from '../application/bot.service.js';
import { getSettingsView, updateSettings } from '../application/bot.settings.js';
import { BANDS, CHANNELS, STATUSES, MAX_MESSAGE_CHARS } from '../domain/bots.domain.js';

const wrap = (fn: (req: Request, res: Response) => Promise<void>): RequestHandler => (req: Request, res: Response, next: NextFunction) => {
  fn(req, res).catch(next);
};
const id = z.object({ id: objectId });

const settingsBody = z
  .object({
    orgSlug: z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9-]{1,60}$/, 'Use the organisation address, for example my-academy.').optional(),
    enabled: z.boolean().optional(),
    name: z.string().trim().min(2).max(60).optional(),
    greeting: z.string().trim().min(2).max(400).optional(),
    languages: z.array(z.string().trim().min(2).max(20)).max(10).optional(),
    handoffKeywords: z.array(z.string().trim().min(1).max(40)).max(30).optional(),
    workingHoursNote: z.string().trim().max(200).optional(),
    consentText: z.string().trim().min(10).max(400).optional(),
    qualificationFields: z.array(z.enum(['course', 'stage', 'percentage', 'budgetBand', 'city', 'timeline'])).optional(),
    publicChannelEnabled: z.boolean().optional(),
    retentionDays: z.number().int().min(1).max(365).optional(),
    dailyMessageCap: z.number().int().min(0).max(100000).optional(),
    monthlyBudgetPaise: z.number().int().min(0).max(100_000_00).optional(),
  })
  .strict();

/** Staff endpoints, mounted at /bots behind requireModule('aiBot'). */
export const botsRoutes = (g: Guards): Router => {
  const r = Router();
  const read = g.requirePermission('bots:read');
  const manage = g.requirePermission('bots:manage');

  r.get('/settings', read, wrap(async (req, res) => void res.json(await getSettingsView(req.principal!))));
  r.put('/settings', manage, validate({ body: settingsBody }), wrap(async (req, res) => void res.json(await updateSettings(req.principal!, req.valid.body))));

  r.get(
    '/conversations',
    read,
    validate({
      query: paging.extend({
        status: z.enum(STATUSES).optional(),
        band: z.enum(BANDS).optional(),
        channel: z.enum(CHANNELS).optional(),
        from: z.coerce.date().optional(),
        to: z.coerce.date().optional(),
      }),
    }),
    wrap(async (req, res) => void res.json(await listConversations(req.principal!, req.valid.query))),
  );
  r.get('/conversations/:id', read, validate({ params: id }), wrap(async (req, res) => void res.json(await getConversation(req.principal!, req.valid.params.id))));
  r.post('/conversations/:id/takeover', manage, validate({ params: id }), wrap(async (req, res) => void res.json(await takeover(req.principal!, req.valid.params.id))));
  r.post('/conversations/:id/close', manage, validate({ params: id }), wrap(async (req, res) => void res.json(await closeConversation(req.principal!, req.valid.params.id))));

  r.get('/summary', read, validate({ query: z.object({ from: z.coerce.date().optional(), to: z.coerce.date().optional() }) }), wrap(async (req, res) => void res.json(await summary(req.principal!, req.valid.query))));
  r.post('/purge', manage, wrap(async (req, res) => void res.json(await purgeExpired(req.principal!))));

  // Staff test console: same service as the public widget, channel "staff_test", works even while the bot is switched off for visitors.
  r.post(
    '/test',
    manage,
    validate({ body: z.object({ message: z.string().trim().min(1).max(MAX_MESSAGE_CHARS), conversationId: objectId.optional() }) }),
    wrap(async (req, res) => {
      const tenantId = req.principal!.tenantId!;
      const org = (await getPlatform().listTenants()).find((t) => t.id === tenantId);
      res.json(await handleTurn({ tenantId, orgName: org?.name ?? 'the organisation', channel: 'staff_test', text: req.valid.body.message, conversationId: req.valid.body.conversationId }));
    }),
  );

  return r;
};
