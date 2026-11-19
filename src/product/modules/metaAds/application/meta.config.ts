import type { Principal } from '../../../../contracts/port.js';
import { env } from '../../../../config/env.js';
import { decryptString, encryptString, randomToken } from '../../../../shared/infra/crypto.js';
import { badRequest } from '../../../../shared/kernel/errors.js';
import { audit } from '../../audit/index.js';
import { DEFAULT_EVENT_MAP, isValidEventName, type EventMap } from '../domain/meta.domain.js';
import { MetaConfigModel } from '../infrastructure/meta.model.js';

export interface ConfigInput {
  pixelId?: string;
  pageId?: string;
  /** write-only. Omit or send empty to keep the saved token. */
  accessToken?: string;
  verifyToken?: string;
  testEventCode?: string;
  enabled?: boolean;
  eventMap?: EventMap;
}

export const webhookUrl = (tenantId: string): string => `${env.PUBLIC_BASE_URL.replace(/\/$/, '')}/public/hooks/meta/${tenantId}`;

/** What the API may show: the token itself is NEVER included, only `tokenSet`. */
const toView = (tenantId: string, c: any | null) => ({
  pixelId: c?.pixelId ?? '',
  pageId: c?.pageId ?? '',
  tokenSet: Boolean(c?.accessTokenEnc),
  verifyToken: c?.verifyToken ?? '',
  testEventCode: c?.testEventCode ?? '',
  enabled: Boolean(c?.enabled),
  eventMap: { ...DEFAULT_EVENT_MAP, ...(c?.eventMap ?? {}) },
  webhookUrl: webhookUrl(tenantId),
  appSecretConfigured: Boolean(env.META_APP_SECRET),
});

export const getConfigView = async (tenantId: string) => toView(tenantId, await MetaConfigModel(tenantId).findOne({ key: 'main' }).lean<any>());

export const putConfig = async (p: Principal, input: ConfigInput) => {
  const tenantId = p.tenantId!;
  if (input.eventMap) {
    for (const [k, v] of Object.entries(input.eventMap)) {
      if (v && !isValidEventName(v)) throw badRequest(`"${v}" is not a valid Meta event name (letters, digits and underscore, starting with a letter).`);
      if (!/^(lead\.created|stage:[a-z_]+)$/.test(k)) throw badRequest(`"${k}" is not something that can trigger an event.`);
    }
  }
  const Model = MetaConfigModel(tenantId);
  const existing = await Model.findOne({ key: 'main' }).lean<any>();
  const set: Record<string, unknown> = {};
  if (input.pixelId !== undefined) set.pixelId = input.pixelId;
  if (input.pageId !== undefined) set.pageId = input.pageId;
  if (input.testEventCode !== undefined) set.testEventCode = input.testEventCode;
  if (input.enabled !== undefined) set.enabled = input.enabled;
  if (input.eventMap !== undefined) set.eventMap = input.eventMap;
  if (input.accessToken) set.accessTokenEnc = encryptString(input.accessToken);
  if (input.verifyToken) set.verifyToken = input.verifyToken;
  else if (!existing) set.verifyToken = randomToken(16);
  const next = { ...(existing ?? {}), ...set } as any;
  if (next.enabled && (!next.pixelId || !next.accessTokenEnc)) throw badRequest('Add the Pixel ID and the access token before switching the connection on.');
  const saved = await Model.findOneAndUpdate({ key: 'main' }, { $set: set, $setOnInsert: { key: 'main' } }, { upsert: true, new: true }).lean<any>();
  await audit(tenantId, {
    action: 'meta.config_updated',
    entity: 'metaConfig',
    meta: { fields: Object.keys(set).map((k) => (k === 'accessTokenEnc' ? 'accessToken' : k)), enabled: Boolean(saved.enabled) }, // never the token
  });
  return toView(tenantId, saved);
};

export const loadConfig = async (tenantId: string) => MetaConfigModel(tenantId).findOne({ key: 'main' }).lean<any>();

/** Internal: the decrypted token, only for calls to Meta. Never leaves the server. */
export const tokenOf = (c: any): string => decryptString(c.accessTokenEnc);
