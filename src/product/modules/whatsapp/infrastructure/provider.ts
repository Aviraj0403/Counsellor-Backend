import { env } from '../../../../config/env.js';
import { httpRequest } from '../../../../shared/infra/http.js';
import { logger } from '../../../../shared/infra/logger.js';
import { AppError } from '../../../../shared/kernel/errors.js';
import { toWhatsappNumber, templateComponents } from '../domain/whatsapp.domain.js';

export interface SendResult {
  providerId: string;
}

export interface WhatsAppProvider {
  name: string;
  isConfigured(): boolean;
  sendTemplate(to: string, template: string, language: string, params: string[]): Promise<SendResult>;
  sendText(to: string, text: string): Promise<SendResult>;
}

/**
 * Official Meta Cloud API Driver for WhatsApp Business.
 * Endpoint: https://graph.facebook.com/<version>/<phone_number_id>/messages
 */
export class MetaCloudApiProvider implements WhatsAppProvider {
  readonly name = 'meta';

  isConfigured(): boolean {
    return Boolean((process.env.WHATSAPP_TOKEN || env.WHATSAPP_TOKEN) && (process.env.WHATSAPP_PHONE_NUMBER_ID || env.WHATSAPP_PHONE_NUMBER_ID));
  }

  private endpoint(): string {
    const ver = process.env.META_GRAPH_VERSION || env.META_GRAPH_VERSION;
    const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID || env.WHATSAPP_PHONE_NUMBER_ID;
    return `https://graph.facebook.com/${ver}/${phoneId}/messages`;
  }

  async sendTemplate(to: string, template: string, language: string, params: string[]): Promise<SendResult> {
    if (!this.isConfigured()) {
      throw new AppError(503, 'WHATSAPP_NOT_CONFIGURED', 'WhatsApp Meta Cloud API is not configured.');
    }

    const payload = {
      messaging_product: 'whatsapp',
      to: toWhatsappNumber(to),
      type: 'template',
      template: {
        name: template,
        language: { code: language || 'en' },
        components: templateComponents(params ?? []),
      },
    };

    const token = process.env.WHATSAPP_TOKEN || env.WHATSAPP_TOKEN;
    try {
      const res = await httpRequest(this.endpoint(), {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
        body: payload,
      });

      if (res.ok && res.data?.messages?.[0]?.id) {
        return { providerId: String(res.data.messages[0].id) };
      }

      const msg = res.data?.error?.message ?? `Meta returned status ${res.status}`;
      logger.warn({ status: res.status, err: msg }, 'Meta WhatsApp API send rejected');
      throw new Error(String(msg).slice(0, 300));
    } catch (err: any) {
      if (err instanceof AppError) throw err;
      logger.warn({ err: err?.message }, 'Meta WhatsApp API request failed');
      throw new Error(err?.message || 'Could not reach Meta WhatsApp Cloud API.');
    }
  }

  async sendText(to: string, text: string): Promise<SendResult> {
    if (!this.isConfigured()) {
      throw new AppError(503, 'WHATSAPP_NOT_CONFIGURED', 'WhatsApp Meta Cloud API is not configured.');
    }

    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: toWhatsappNumber(to),
      type: 'text',
      text: { preview_url: false, body: text.slice(0, 4096) },
    };

    try {
      const res = await httpRequest(this.endpoint(), {
        method: 'POST',
        headers: { authorization: `Bearer ${env.WHATSAPP_TOKEN}` },
        body: payload,
      });

      if (res.ok && res.data?.messages?.[0]?.id) {
        return { providerId: String(res.data.messages[0].id) };
      }

      const msg = res.data?.error?.message ?? `Meta returned status ${res.status}`;
      logger.warn({ status: res.status, err: msg }, 'Meta WhatsApp API sendText rejected');
      throw new Error(String(msg).slice(0, 300));
    } catch (err: any) {
      if (err instanceof AppError) throw err;
      logger.warn({ err: err?.message }, 'Meta WhatsApp API request failed');
      throw new Error(err?.message || 'Could not reach Meta WhatsApp Cloud API.');
    }
  }
}

/**
 * Generic Webhook / Gateway Provider (Fallback).
 * Posts JSON payload to WHATSAPP_GATEWAY_URL.
 */
export class GenericWebhookProvider implements WhatsAppProvider {
  readonly name = 'webhook';

  isConfigured(): boolean {
    return Boolean(env.WHATSAPP_GATEWAY_URL);
  }

  async sendTemplate(to: string, template: string, language: string, params: string[]): Promise<SendResult> {
    if (!this.isConfigured()) {
      throw new AppError(503, 'WHATSAPP_NOT_CONFIGURED', 'WhatsApp gateway URL is not configured.');
    }

    try {
      const res = await httpRequest(env.WHATSAPP_GATEWAY_URL!, {
        method: 'POST',
        body: {
          type: 'template',
          to: toWhatsappNumber(to),
          template,
          language: language || 'en',
          params: params ?? [],
        },
      });

      if (res.ok && (res.data?.id || res.data?.messageId || res.data?.providerId)) {
        return { providerId: String(res.data.id || res.data.messageId || res.data.providerId) };
      }

      throw new Error(res.data?.error || `Gateway answered with status ${res.status}`);
    } catch (err: any) {
      logger.warn({ err: err?.message }, 'Generic WhatsApp Gateway request failed');
      throw new Error(err?.message || 'Could not reach WhatsApp Gateway.');
    }
  }

  async sendText(to: string, text: string): Promise<SendResult> {
    if (!this.isConfigured()) {
      throw new AppError(503, 'WHATSAPP_NOT_CONFIGURED', 'WhatsApp gateway URL is not configured.');
    }

    try {
      const res = await httpRequest(env.WHATSAPP_GATEWAY_URL!, {
        method: 'POST',
        body: {
          type: 'text',
          to: toWhatsappNumber(to),
          text,
        },
      });

      if (res.ok && (res.data?.id || res.data?.messageId || res.data?.providerId)) {
        return { providerId: String(res.data.id || res.data.messageId || res.data.providerId) };
      }

      throw new Error(res.data?.error || `Gateway answered with status ${res.status}`);
    } catch (err: any) {
      logger.warn({ err: err?.message }, 'Generic WhatsApp Gateway request failed');
      throw new Error(err?.message || 'Could not reach WhatsApp Gateway.');
    }
  }
}

let activeProvider: WhatsAppProvider | null = null;

export const getWhatsAppProvider = (): WhatsAppProvider => {
  if (activeProvider) return activeProvider;
  if (env.WHATSAPP_PROVIDER === 'webhook') {
    activeProvider = new GenericWebhookProvider();
  } else {
    activeProvider = new MetaCloudApiProvider();
  }
  return activeProvider;
};

export const setWhatsAppProvider = (p: WhatsAppProvider | null): void => {
  activeProvider = p;
};
