import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../../../../shared/http/validate.js';
import { Tenant } from '../../../../core/modules/organisations/infrastructure/tenant.model.js';
import { createLead } from '../application/lead.service.js';
import { notFound, badRequest } from '../../../../shared/kernel/errors.js';
import type { Principal } from '../../../../contracts/port.js';

const slugParam = z.object({
  slug: z.string().trim().toLowerCase(),
});

export const universalLeadRoutes = (): Router => {
  const r = Router();

  /**
   * Universal Inbound Webhook:
   * Accepts leads from Meta Lead Ads, Google Ads Webhook, Justdial, Sulekha, Shiksha, Zapier, Make, or custom landing pages.
   */
  r.post(
    '/leads/webhook/:slug',
    validate({
      params: slugParam,
      body: z.object({
        name: z.string().min(2).max(120).optional(),
        fullName: z.string().optional(),
        studentName: z.string().optional(),
        phone: z.string().min(10).max(20).optional(),
        mobile: z.string().optional(),
        phoneNumber: z.string().optional(),
        email: z.string().email().optional().or(z.literal('')),
        city: z.string().max(80).optional(),
        course: z.string().max(120).optional(),
        interestedCourse: z.string().max(120).optional(),
        source: z.string().optional(), // 'meta_ads' | 'google_ads' | 'justdial' | 'sulekha' | 'shiksha' | 'website'
        channel: z.string().optional(),
        utmSource: z.string().optional(),
        utmCampaign: z.string().optional(),
        referralCode: z.string().optional(),
      }).passthrough(), // Allow any extra fields from webhook payloads
    }),
    async (req, res, next) => {
      try {
        const slug = req.valid.params.slug;
        const tenant = await Tenant.findOne({ slug }).lean<any>();
        if (!tenant) throw notFound('Organisation');

        const b = req.body || {};
        const name = (b.name || b.fullName || b.studentName || 'Prospective Student').trim();
        const phone = (b.phone || b.mobile || b.phoneNumber || '').trim();
        const email = b.email ? String(b.email).trim().toLowerCase() : undefined;
        const city = (b.city || '').trim();
        const interestedCourse = (b.interestedCourse || b.course || '').trim();

        if (!phone) {
          throw badRequest('Missing phone number in webhook payload.');
        }

        const channel = (b.channel || b.source || 'api').toLowerCase();

        const principal: Principal = {
          userId: `system:webhook:${channel}`,
          email: 'webhook@system.local',
          name: 'Inbound Webhook System',
          role: 'system',
          scope: 'tenant',
          tenantId: String(tenant._id),
          permissions: ['leads:write', 'leads:read'],
        };

        const result = await createLead(principal, {
          name,
          phone,
          email,
          city: city || undefined,
          interestedCourse: interestedCourse || undefined,
          source: {
            channel,
            utmSource: b.utmSource || channel,
            utmCampaign: b.utmCampaign || b.campaign_name,
            referralCode: b.referralCode,
          },
          consent: {
            given: true,
            source: `Inbound Webhook: ${channel}`,
          },
          autoAssign: true,
        });

        res.status(result.duplicate ? 200 : 201).json({
          ok: true,
          leadId: String(result.lead._id),
          duplicate: result.duplicate,
          assignedTo: result.lead.assignedTo || null,
        });
      } catch (e) {
        next(e);
      }
    }
  );

  return r;
};
