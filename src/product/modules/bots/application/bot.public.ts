import { env } from '../../../../config/env.js';
import { getPlatform } from '../../../../contracts/registry.js';
import { hmacHex, safeEqual } from '../../../../shared/infra/crypto.js';
import { loadSettings } from './bot.settings.js';

export interface BotSite {
  tenantId: string;
  orgName: string;
  slug: string;
}

/** Organisation found by its address. Unknown, suspended, module off or bot disabled all look the same: not found. */
export const loadBotSite = async (slug: string, channel: 'web' | 'whatsapp'): Promise<BotSite | null> => {
  const platform = getPlatform();
  const tenant = await platform.findTenantBySlug(slug.toLowerCase());
  if (!tenant || tenant.status !== 'active') return null;
  if (!(await platform.enabledModules(tenant.id))['aiBot']) return null;
  const s = await loadSettings(tenant.id);
  if (!s.enabled || (channel === 'web' && !s.publicChannelEnabled)) return null;
  return { tenantId: tenant.id, orgName: tenant.name, slug: slug.toLowerCase() };
};

/** `x-bot-signature: sha256=<hmac of the raw body with BOT_INBOUND_SECRET>` */
export const verifyInboundSignature = (rawBody: Buffer | undefined, header: string | undefined): boolean => {
  if (!env.BOT_INBOUND_SECRET || !rawBody || !header) return false;
  return safeEqual(`sha256=${hmacHex(env.BOT_INBOUND_SECRET, rawBody)}`, header);
};

