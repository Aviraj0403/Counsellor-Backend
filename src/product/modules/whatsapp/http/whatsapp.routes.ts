import { Router } from 'express';
import { z } from 'zod';
import type { Guards } from '../../../../contracts/guards.js';
import { validate } from '../../../../shared/http/validate.js';
import { objectId, paging } from '../../../../shared/http/schemas.js';
import { RULE_EVENTS } from '../domain/whatsapp.domain.js';
import { createRule, deleteRule, listRules, updateRule } from '../application/whatsapp.rules.js';
import { createTemplate, deleteTemplate, dispatchDue, listMessages, listTemplates, sendMessage, updateTemplate } from '../application/whatsapp.service.js';
import { createCampaign, executeCampaign, getCampaign, listCampaigns } from '../application/whatsapp.campaign.service.js';

const id = z.object({ id: objectId });
const lang = z.string().min(2).max(10);
const tplBody = {
  name: z.string().min(1).max(80).regex(/^[a-z0-9_]+$/, 'Use lowercase letters, digits and underscores, as approved in WhatsApp'),
  language: lang.default('en'),
  body: z.string().min(1).max(1024),
  purpose: z.string().max(200).optional(),
  active: z.boolean().optional(),
};
const ruleBody = {
  event: z.enum(RULE_EVENTS),
  filter: z.string().max(60).optional(),
  template: z.string().min(1).max(80),
  language: lang.default('en'),
  params: z.array(z.string().max(200)).max(10).default([]),
  delayMinutes: z.number().int().min(0).max(60 * 24 * 30).default(0),
  active: z.boolean().optional(),
};
const campaignBody = {
  name: z.string().min(1).max(120),
  template: z.string().min(1).max(80),
  language: lang.default('en'),
  audience: z.enum(['leads', 'students', 'all']).default('leads'),
  filters: z.object({
    stage: z.string().max(60).optional(),
    city: z.string().max(60).optional(),
    course: z.string().max(100).optional(),
  }).optional(),
  paramMapping: z.array(z.string().max(50)).default(['name']),
  scheduledAt: z.string().datetime().optional().transform((v) => (v ? new Date(v) : undefined)),
};

export const whatsappRoutes = (g: Guards): Router => {
  const r = Router();
  const wrap = (fn: (req: any, res: any) => Promise<void>) => async (req: any, res: any, next: any) => {
    try {
      await fn(req, res);
    } catch (e) {
      next(e);
    }
  };

  r.post(
    '/send',
    g.requirePermission('whatsapp:send'),
    validate({
      body: z
        .object({ leadId: objectId.optional(), studentId: objectId.optional(), template: z.string().min(1).max(80), language: lang.optional(), params: z.array(z.string().max(200)).max(10).default([]) })
        .refine((b) => !!b.leadId !== !!b.studentId, 'Give either leadId or studentId'),
    }),
    wrap(async (req, res) => {
      const out = await sendMessage(req.principal!, req.valid.body);
      res.status(out.duplicate ? 200 : 201).json(out);
    }),
  );

  r.get(
    '/messages',
    g.requirePermission('whatsapp:send'),
    validate({ query: paging.extend({ leadId: objectId.optional(), studentId: objectId.optional() }) }),
    wrap(async (req, res) => void res.json(await listMessages(req.principal!, req.valid.query))),
  );

  r.post('/process-due', g.requirePermission('integrations:manage'), wrap(async (req, res) => void res.json(await dispatchDue(req.principal!.tenantId!))));

  // templates: everyone who can send may read the list; changing needs integrations:manage
  r.get('/templates', g.requirePermission('whatsapp:send'), wrap(async (req, res) => void res.json({ items: await listTemplates(req.principal!.tenantId!) })));
  r.post('/templates', g.requirePermission('integrations:manage'), validate({ body: z.object(tplBody) }), wrap(async (req, res) => void res.status(201).json(await createTemplate(req.principal!, req.valid.body))));
  r.patch('/templates/:id', g.requirePermission('integrations:manage'), validate({ params: id, body: z.object(tplBody).partial() }), wrap(async (req, res) => void res.json(await updateTemplate(req.principal!, req.valid.params.id, req.valid.body))));
  r.delete('/templates/:id', g.requirePermission('integrations:manage'), validate({ params: id }), wrap(async (req, res) => void res.json(await deleteTemplate(req.principal!, req.valid.params.id))));

  r.get('/rules', g.requirePermission('integrations:manage'), wrap(async (req, res) => void res.json({ items: await listRules(req.principal!.tenantId!) })));
  r.post('/rules', g.requirePermission('integrations:manage'), validate({ body: z.object(ruleBody) }), wrap(async (req, res) => void res.status(201).json(await createRule(req.principal!, req.valid.body))));
  r.patch('/rules/:id', g.requirePermission('integrations:manage'), validate({ params: id, body: z.object(ruleBody).partial() }), wrap(async (req, res) => void res.json(await updateRule(req.principal!, req.valid.params.id, req.valid.body))));
  r.delete('/rules/:id', g.requirePermission('integrations:manage'), validate({ params: id }), wrap(async (req, res) => void res.json(await deleteRule(req.principal!, req.valid.params.id))));

  // campaigns: broadcast WhatsApp campaigns
  r.get('/campaigns', g.requirePermission('integrations:manage'), wrap(async (req, res) => void res.json({ items: await listCampaigns(req.principal!.tenantId!) })));
  r.get('/campaigns/:id', g.requirePermission('integrations:manage'), validate({ params: id }), wrap(async (req, res) => void res.json(await getCampaign(req.principal!.tenantId!, req.valid.params.id))));
  r.post('/campaigns', g.requirePermission('integrations:manage'), validate({ body: z.object(campaignBody) }), wrap(async (req, res) => void res.status(201).json(await createCampaign(req.principal!, req.valid.body))));
  r.post('/campaigns/:id/execute', g.requirePermission('integrations:manage'), validate({ params: id }), wrap(async (req, res) => void res.json(await executeCampaign(req.principal!.tenantId!, req.valid.params.id, req.principal!.userId))));

  return r;
};
