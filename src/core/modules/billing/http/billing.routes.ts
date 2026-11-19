import { Router } from 'express';
import { z } from 'zod';
import type { Guards } from '../../../../contracts/guards.js';
import { MODULE_KEYS } from '../../../../contracts/port.js';
import { objectId, paging, period } from '../../../../shared/http/schemas.js';
import { validate } from '../../../../shared/http/validate.js';
import { assignPlan, createPlan, listPlans, updatePlan } from '../application/plans.service.js';
import { getBillingView, setPriceOverrides } from '../application/billing.service.js';
import { addCost, listCosts, voidCost } from '../application/costs.service.js';
import { platformDashboard } from '../application/dashboard.service.js';
import { generateInvoice, getInvoiceDoc, listInvoices, setInvoiceStatus } from '../application/invoices.service.js';
import { renderInvoicePdf } from '../application/invoicePdf.js';
import { createPaymentLink } from '../application/paymentLink.service.js';
import { getSettings, setBillingDetails, updateSettings } from '../application/settings.service.js';
import { currentPeriod } from '../domain/billing.domain.js';
import { COST_CATEGORIES } from '../infrastructure/cost.model.js';

const moduleKey = z.enum(MODULE_KEYS as unknown as [string, ...string[]]);

export interface BillingDeps {
  /** supplied by the composition root (from `identity`), so billing never imports identity */
  countActiveStaffAccounts: () => Promise<number>;
}

/** Plans, pricing, invoices, platform costs and the financial dashboard. Platform finance / super admin only. */
export const billingRoutes = (g: Guards, deps: BillingDeps): Router => {
  const r = Router();
  const billing = [g.authenticate, g.requirePermission('platform:billing:manage')];
  const costs = [g.authenticate, g.requirePermission('platform:costs:manage')];
  const idParam = z.object({ id: objectId });

  r.get('/platform/dashboard', ...billing, validate({ query: z.object({ month: period.optional() }) }), async (req, res, next) => {
    try {
      res.json(await platformDashboard(req.valid.query.month ?? currentPeriod(), await deps.countActiveStaffAccounts()));
    } catch (e) {
      next(e);
    }
  });

  // ---- plans
  r.get('/platform/plans', ...billing, async (_req, res, next) => {
    try {
      res.json({ plans: await listPlans() });
    } catch (e) {
      next(e);
    }
  });

  r.post(
    '/platform/plans',
    ...billing,
    validate({
      body: z.object({
        key: z.string().regex(/^[a-z0-9-]{2,30}$/, 'Use 2-30 lowercase letters, numbers or hyphens'),
        name: z.string().min(2).max(80),
        description: z.string().max(300).optional(),
        basePricePaise: z.number().int().min(0),
        includedModules: z.array(moduleKey).default([]),
        maxStaff: z.number().int().min(1).nullable().optional(),
      }),
    }),
    async (req, res, next) => {
      try {
        res.status(201).json(await createPlan(req.valid.body));
      } catch (e) {
        next(e);
      }
    },
  );

  r.patch(
    '/platform/plans/:id',
    ...billing,
    validate({
      params: idParam,
      body: z
        .object({
          name: z.string().min(2).max(80),
          description: z.string().max(300),
          basePricePaise: z.number().int().min(0),
          includedModules: z.array(moduleKey),
          maxStaff: z.number().int().min(1).nullable(),
          active: z.boolean(),
        })
        .partial()
        .refine((b) => Object.keys(b).length > 0, 'Nothing to update'),
    }),
    async (req, res, next) => {
      try {
        res.json(await updatePlan(req.valid.params.id, req.valid.body));
      } catch (e) {
        next(e);
      }
    },
  );

  // ---- one organisation's billing
  r.get('/platform/tenants/:id/billing', ...billing, validate({ params: idParam }), async (req, res, next) => {
    try {
      res.json(await getBillingView(req.valid.params.id));
    } catch (e) {
      next(e);
    }
  });

  r.patch('/platform/tenants/:id/plan', ...billing, validate({ params: idParam, body: z.object({ planKey: z.string().regex(/^[a-z0-9-]{2,30}$/).nullable() }) }), async (req, res, next) => {
    try {
      res.json(await assignPlan(req.valid.params.id, req.valid.body.planKey));
    } catch (e) {
      next(e);
    }
  });

  r.patch(
    '/platform/tenants/:id/pricing',
    ...billing,
    validate({ params: idParam, body: z.object({ priceOverrides: z.record(moduleKey, z.number().min(0).max(1_000_000).nullable()) }) }),
    async (req, res, next) => {
      try {
        res.json(await setPriceOverrides(req.valid.params.id, req.valid.body.priceOverrides));
      } catch (e) {
        next(e);
      }
    },
  );

  r.post('/platform/tenants/:id/invoices', ...billing, validate({ params: idParam, body: z.object({ period }) }), async (req, res, next) => {
    try {
      res.status(201).json(await generateInvoice(req.valid.params.id, req.valid.body.period));
    } catch (e) {
      next(e);
    }
  });

  // ---- invoices across organisations
  r.get('/platform/invoices', ...billing, validate({ query: paging.extend({ status: z.enum(['issued', 'paid', 'void']).optional(), period: period.optional() }) }), async (req, res, next) => {
    try {
      res.json(await listInvoices(req.valid.query));
    } catch (e) {
      next(e);
    }
  });

  r.patch(
    '/platform/invoices/:id',
    ...billing,
    validate({ params: idParam, body: z.object({ status: z.enum(['paid', 'void']), paidRef: z.string().max(120).optional() }) }),
    async (req, res, next) => {
      try {
        res.json(await setInvoiceStatus(req.valid.params.id, req.valid.body.status, req.valid.body.paidRef));
      } catch (e) {
        next(e);
      }
    },
  );

  // ---- company details (printed on invoices)
  const settingsGuard = [g.authenticate, g.requirePermission('platform:settings:manage')];
  const gstin = z.string().trim().toUpperCase().regex(/^$|^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/, 'GSTIN must be 15 characters, like 29ABCDE1234F1Z5');
  const text = (n: number) => z.string().trim().max(n);
  r.get('/platform/settings', ...settingsGuard, async (_req, res, next) => {
    try {
      res.json(await getSettings());
    } catch (e) {
      next(e);
    }
  });
  r.put(
    '/platform/settings',
    ...settingsGuard,
    validate({
      body: z
        .object({
          legalName: text(160),
          gstin,
          pan: z.string().trim().toUpperCase().regex(/^$|^[A-Z]{5}\d{4}[A-Z]$/, 'PAN must be 10 characters, like ABCDE1234F'),
          address: text(400),
          state: text(60),
          email: text(120),
          phone: text(30),
          bank: z.object({ name: text(80).optional(), account: text(30).optional(), ifsc: text(15).optional() }),
          invoiceFooter: text(500),
          gstRateBps: z.number().int().min(0).max(10_000),
        })
        .partial()
        .refine((b) => Object.keys(b).length > 0, 'Nothing to update'),
    }),
    async (req, res, next) => {
      try {
        res.json(await updateSettings(req.valid.body));
      } catch (e) {
        next(e);
      }
    },
  );

  r.patch(
    '/platform/tenants/:id/billing-details',
    ...billing,
    validate({
      params: idParam,
      body: z.object({ legalName: text(160), gstin, address: text(400), state: text(60) }).partial().refine((b) => Object.keys(b).length > 0, 'Nothing to update'),
    }),
    async (req, res, next) => {
      try {
        res.json(await setBillingDetails(req.valid.params.id, req.valid.body));
      } catch (e) {
        next(e);
      }
    },
  );

  r.get('/platform/invoices/:id/pdf', ...billing, validate({ params: idParam }), async (req, res, next) => {
    try {
      const inv = await getInvoiceDoc(req.valid.params.id);
      const s = await getSettings();
      const pdf = renderInvoicePdf(inv, s, s.invoiceFooter, s.bank);
      res.set({ 'content-type': 'application/pdf', 'content-disposition': `attachment; filename="${inv.invoiceNo}.pdf"`, 'content-length': String(pdf.length) }).send(pdf);
    } catch (e) {
      next(e);
    }
  });

  r.post('/platform/invoices/:id/payment-link', ...billing, validate({ params: idParam }), async (req, res, next) => {
    try {
      res.status(201).json(await createPaymentLink(req.valid.params.id));
    } catch (e) {
      next(e);
    }
  });

  // ---- platform running costs
  r.get('/platform/costs', ...costs, validate({ query: z.object({ month: period.optional() }) }), async (req, res, next) => {
    try {
      res.json(await listCosts(req.valid.query.month ?? currentPeriod()));
    } catch (e) {
      next(e);
    }
  });

  r.post(
    '/platform/costs',
    ...costs,
    validate({
      body: z.object({
        month: period,
        category: z.enum(COST_CATEGORIES),
        amountPaise: z.number().int().min(1).max(100_000_000_00),
        tenantId: objectId.optional(),
        note: z.string().max(300).optional(),
      }),
    }),
    async (req, res, next) => {
      try {
        res.status(201).json(await addCost(req.valid.body));
      } catch (e) {
        next(e);
      }
    },
  );

  r.post('/platform/costs/:id/void', ...costs, validate({ params: idParam }), async (req, res, next) => {
    try {
      res.json(await voidCost(req.valid.params.id));
    } catch (e) {
      next(e);
    }
  });

  return r;
};
