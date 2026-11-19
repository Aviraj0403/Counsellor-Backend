import type { ModuleConfigStatus } from '../../../../shared/kernel/configStatus.js';
import { CollegePageModel, SeoSettingsModel } from '../infrastructure/seo.model.js';

export const configStatus = async (tenantId: string): Promise<ModuleConfigStatus> => {
  const [settings, published] = await Promise.all([
    SeoSettingsModel(tenantId).findOne({ key: 'default' }).select('orgSlug leadFormEnabled').lean<{ orgSlug?: string; leadFormEnabled?: boolean } | null>(),
    CollegePageModel(tenantId).countDocuments({ published: true }),
  ]);
  const slugSet = !!settings?.orgSlug;
  const items = [
    { label: 'Public address (slug) set', value: slugSet },
    { label: 'Published college pages', value: published },
    { label: 'Enquiry form on pages', value: settings?.leadFormEnabled !== false },
  ];
  if (!slugSet) return { configured: false, health: 'attention', summary: 'SEO pages are on but the public address is not set, so nothing is visible on the web.', items, nextStep: 'Ask the organisation to save their SEO settings (public address) once.' };
  return { configured: true, health: 'ok', summary: published > 0 ? `${published} college page(s) published.` : 'Public address is set. College pages are shown from the college directory.', items };
};
