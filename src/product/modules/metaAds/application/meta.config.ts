import type { Principal } from '../../../../contracts/port.js';
import { env } from '../../../../config/env.js';
import { decryptString, encryptString, randomToken } from '../../../../shared/infra/crypto.js';
import { badRequest } from '../../../../shared/kernel/errors.js';
import { audit } from '../../audit/index.js';
import { DEFAULT_EVENT_MAP, isValidEventName, type EventMap } from '../domain/meta.domain.js';
import { maskToken, normaliseAdAccountId, normaliseGraphVersion } from '../domain/meta.insights.domain.js';
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
  /** ad accounts to read insights from: "123" or "act_123". [] clears. */
  adAccountIds?: string[];
  /** e.g. v21.0. Empty = the server default. */
  apiVersion?: string;
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
  tokenHint: c?.accessTokenEnc ? (c?.tokenHint ?? '') : '',
  adAccountIds: (c?.adAccountIds ?? []) as string[],
  apiVersion: c?.apiVersion ?? '',
  defaultApiVersion: env.META_GRAPH_VERSION,
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
  let adAccountIds: string[] | undefined;
  if (input.adAccountIds) {
    adAccountIds = [];
    for (const raw of input.adAccountIds) {
      const id = normaliseAdAccountId(raw);
      if (!id) throw badRequest(`"${raw}" is not an ad account id. It is a number like 1234567890 (Meta Business Settings, Ad accounts).`);
      if (!adAccountIds.includes(id)) adAccountIds.push(id);
    }
    if (adAccountIds.length > 10) throw badRequest('At most 10 ad accounts.');
  }
  let apiVersion: string | undefined;
  if (input.apiVersion !== undefined) {
    apiVersion = input.apiVersion.trim() === '' ? '' : (normaliseGraphVersion(input.apiVersion) ?? undefined);
    if (apiVersion === undefined) throw badRequest('The API version must look like v21.0.');
  }
  if (input.accessToken && (input.accessToken.length < 20 || /s/.test(input.accessToken))) throw badRequest('That does not look like a Meta access token (it is one long string with no spaces).');
  const Model = MetaConfigModel(tenantId);
  const existing = await Model.findOne({ key: 'main' }).lean<any>();
  const set: Record<string, unknown> = {};
  if (input.pixelId !== undefined) set.pixelId = input.pixelId;
  if (input.pageId !== undefined) set.pageId = input.pageId;
  if (input.testEventCode !== undefined) set.testEventCode = input.testEventCode;
  if (input.enabled !== undefined) set.enabled = input.enabled;
  if (input.eventMap !== undefined) set.eventMap = input.eventMap;
  if (input.accessToken) {
    set.accessTokenEnc = encryptString(input.accessToken);
    set.tokenHint = maskToken(input.accessToken);
    set.consecutiveFailures = 0; // a new token deserves a fresh start
    set.lastError = null;
    set.lastErrorCode = null;
  }
  if (adAccountIds) set.adAccountIds = adAccountIds;
  if (apiVersion !== undefined) set.apiVersion = apiVersion;
  if (input.verifyToken) set.verifyToken = input.verifyToken;
  else if (!existing) set.verifyToken = randomToken(16);
  const next = { ...(existing ?? {}), ...set } as any;
  if (next.enabled && (!next.pixelId || !next.accessTokenEnc)) throw badRequest('Add the Pixel ID and the access token before switching the connection on.');
  const update: Record<string, unknown> = { $set: set, $setOnInsert: { key: 'main' } };
  // other ad accounts = history is incomplete: the next sync backfills 30 days again
  if (adAccountIds && [...adAccountIds].sort().join() !== [...(existing?.adAccountIds ?? [])].sort().join()) update.$unset = { lastSuccessAt: '' };
  const saved = await Model.findOneAndUpdate({ key: 'main' }, update, { upsert: true, new: true }).lean<any>();
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
