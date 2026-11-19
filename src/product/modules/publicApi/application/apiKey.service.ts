import type { Principal } from '../../../../contracts/port.js';
import { getPlatform } from '../../../../contracts/registry.js';
import { randomToken, sha256Hex } from '../../../../shared/infra/crypto.js';
import { AppError, badRequest, notFound, unauthorized } from '../../../../shared/kernel/errors.js';
import { audit } from '../../audit/index.js';
import { getCollege } from '../../colleges/index.js';
import { allowRequest, formatKey, hasScope, keyPrefix, parseKey, type Scope } from '../domain/publicApi.domain.js';
import { ApiKeyModel } from '../infrastructure/publicApi.model.js';

const view = (k: any) => ({
  id: String(k._id),
  name: k.name,
  prefix: k.prefix,
  scopes: k.scopes as string[],
  collegeId: k.collegeId ?? null,
  lastUsedAt: k.lastUsedAt ?? null,
  revokedAt: k.revokedAt ?? null,
  createdAt: k.createdAt,
});

/** Creates a key. The full key is in the answer ONCE; only its SHA-256 hash is stored. */
export const createKey = async (p: Principal, input: { name: string; scopes: Scope[]; collegeId?: string }) => {
  const tenantId = p.tenantId!;
  if (input.collegeId) {
    if (!(await getCollege(tenantId, input.collegeId))) throw badRequest('That college does not exist.');
  } else if (input.scopes.some((s) => s === 'applications:read' || s === 'applications:update')) {
    throw badRequest('Application access is only for a key tied to one college. Choose a college.');
  }
  const random = randomToken(24);
  const apiKey = formatKey(tenantId, random);
  const doc = await ApiKeyModel(tenantId).create({
    name: input.name,
    prefix: keyPrefix(tenantId, random),
    hash: sha256Hex(apiKey),
    scopes: [...new Set(input.scopes)],
    collegeId: input.collegeId,
    createdBy: p.userId,
  });
  await audit(tenantId, { action: 'apikey.created', entity: 'apiKey', entityId: String(doc._id), meta: { name: input.name, scopes: input.scopes, collegeId: input.collegeId } });
  return { ...view(doc.toObject()), apiKey };
};

export const listKeys = async (tenantId: string) => (await ApiKeyModel(tenantId).find().sort({ createdAt: -1 }).lean<any[]>()).map(view);

export const revokeKey = async (p: Principal, id: string) => {
  const tenantId = p.tenantId!;
  const k = await ApiKeyModel(tenantId).findOneAndUpdate({ _id: id, revokedAt: { $exists: false } }, { $set: { revokedAt: new Date() } }, { new: true }).lean<any>();
  if (!k) {
    if (await ApiKeyModel(tenantId).exists({ _id: id })) return view((await ApiKeyModel(tenantId).findById(id).lean<any>())!); // already revoked: idempotent
    throw notFound('API key');
  }
  await audit(tenantId, { action: 'apikey.revoked', entity: 'apiKey', entityId: id, meta: { name: k.name } });
  return view(k);
};

// ---- authentication of a presented key (public endpoints)
export interface KeyContext {
  tenantId: string;
  keyId: string;
  keyName: string;
  scopes: string[];
  collegeId?: string;
}

const hits = new Map<string, number[]>();
export const resetRateLimits = (): void => hits.clear();

/** Resolves the organisation from the key itself, checks it is live, the module is on and the per-key rate limit. */
export const authenticateKey = async (token: string | null, now = Date.now()): Promise<KeyContext> => {
  const parsed = parseKey(token);
  if (!parsed) throw unauthorized('A valid API key is required (Authorization: Bearer cpk_...).');
  const { tenantId } = parsed;
  const key = await ApiKeyModel(tenantId).findOne({ hash: sha256Hex(token!.trim()) }).lean<any>();
  if (!key || key.revokedAt) throw unauthorized('This API key is not valid or has been revoked.');
  let mods: Record<string, boolean> = {};
  try {
    mods = await getPlatform().enabledModules(tenantId);
  } catch {
    throw unauthorized('This API key is not valid or has been revoked.');
  }
  if (!mods['publicApi']) throw new AppError(403, 'MODULE_NOT_ENABLED', 'The API is not enabled for this organisation.');
  const id = String(key._id);
  const r = allowRequest(hits.get(id) ?? [], now);
  hits.set(id, r.hits);
  if (!r.allowed) throw new AppError(429, 'RATE_LIMITED', 'Too many requests for this API key. Wait a minute and try again.');
  void ApiKeyModel(tenantId).updateOne({ _id: key._id }, { $set: { lastUsedAt: new Date(now) } }).catch(() => undefined);
  return { tenantId, keyId: id, keyName: key.name, scopes: key.scopes ?? [], collegeId: key.collegeId || undefined };
};

export const requireScope = (ctx: KeyContext, scope: Scope): void => {
  if (!hasScope(ctx.scopes, scope)) throw new AppError(403, 'FORBIDDEN', `This API key does not have the "${scope}" permission.`);
};
