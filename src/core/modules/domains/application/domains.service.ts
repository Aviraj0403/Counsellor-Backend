import mongoose, { isValidObjectId } from 'mongoose';
import { env } from '../../../../config/env.js';
import { getContext } from '../../../../shared/kernel/context.js';
import { badRequest, conflict, notFound } from '../../../../shared/kernel/errors.js';
import { recordPlatformAudit } from '../../audit/index.js';
import { tenantExists } from '../../organisations/index.js';
import { normalizeOrigin, parseOriginList } from '../domain/origin.js';
import { AllowedDomain, type AllowedDomainDoc } from '../infrastructure/allowedDomain.model.js';

const production = () => env.NODE_ENV === 'production';

/**
 * ORIGIN WHITELIST (the same idea as the ecommerce platform's origins.ts):
 *   1. server config   PLATFORM_ORIGINS + CORS_ORIGINS (env). Always allowed, cannot be removed from the UI.
 *   2. superadmin list domains added in the console (master DB). Take effect within seconds, no restart.
 *   3. local dev       http://localhost / 127.0.0.1, only outside production.
 * Everything else is refused. If the database is unreachable the answer is "no" (fail closed), and that answer is not cached.
 */
export const configuredOrigins = (): string[] => [...new Set([...parseOriginList(env.PLATFORM_ORIGINS, { production: production() }), ...parseOriginList(env.CORS_ORIGINS, { production: production() })])];

const POSITIVE_TTL_MS = 60_000;
const NEGATIVE_TTL_MS = 30_000;
const cache = new Map<string, { allowed: boolean; expires: number }>();
export const clearOriginCache = (): void => cache.clear();

const isLocalDev = (origin: string): boolean => {
  if (production()) return false;
  try {
    const { hostname } = new URL(origin);
    return hostname === 'localhost' || hostname === '127.0.0.1';
  } catch {
    return false;
  }
};

/** Used by the HTTP CORS check. `origin` is the raw Origin header value. */
export const isAllowedOrigin = async (origin: string): Promise<boolean> => {
  const checked = normalizeOrigin(origin, { production: production() });
  if (!checked.ok) return false;
  const o = checked.origin;
  if (isLocalDev(o) || configuredOrigins().includes(o)) return true;

  const hit = cache.get(o);
  if (hit && hit.expires > Date.now()) return hit.allowed;

  if (mongoose.connection.readyState !== 1) return false; // database not available: fail closed, do not cache
  try {
    const allowed = !!(await AllowedDomain.exists({ origin: o, active: true }));
    cache.set(o, { allowed, expires: Date.now() + (allowed ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS) });
    return allowed;
  } catch {
    return false;
  }
};

const shape = (d: any) => ({
  id: String(d._id),
  origin: d.origin,
  host: new URL(d.origin).hostname,
  label: d.label ?? '',
  kind: d.kind,
  tenantId: d.tenantId ?? null,
  active: d.active,
  note: d.note ?? '',
  createdAt: d.createdAt,
});

export const listDomains = async () => ({
  configured: configuredOrigins().map((origin) => ({ origin, source: 'server config (PLATFORM_ORIGINS / CORS_ORIGINS)' })),
  custom: (await AllowedDomain.find().sort({ createdAt: -1 }).limit(500).lean()).map(shape),
});

export const addDomain = async (input: { origin: string; label?: string; kind: AllowedDomainDoc['kind']; tenantId?: string | null; note?: string }) => {
  const checked = normalizeOrigin(input.origin, { production: production() });
  if (!checked.ok) throw badRequest(checked.reason);
  if (configuredOrigins().includes(checked.origin)) throw conflict('This domain is already allowed by the server configuration.');
  if (await AllowedDomain.exists({ origin: checked.origin })) throw conflict('This domain is already in the list.');
  if (input.tenantId && !(await tenantExists(input.tenantId))) throw badRequest('That organisation does not exist.');
  const d = await AllowedDomain.create({ origin: checked.origin, label: input.label, kind: input.kind, tenantId: input.tenantId ?? null, note: input.note, addedBy: getContext()?.userId });
  clearOriginCache();
  await recordPlatformAudit({ action: 'domain.added', targetType: 'domain', targetId: String(d._id), tenantId: input.tenantId ?? undefined, meta: { origin: checked.origin, kind: input.kind } });
  return shape(d.toObject());
};

export const updateDomain = async (id: string, input: Partial<{ active: boolean; label: string; kind: AllowedDomainDoc['kind']; note: string; tenantId: string | null }>) => {
  if (!isValidObjectId(id)) throw notFound('Domain');
  if (input.tenantId && !(await tenantExists(input.tenantId))) throw badRequest('That organisation does not exist.');
  const d = await AllowedDomain.findByIdAndUpdate(id, { $set: input }, { new: true }).lean();
  if (!d) throw notFound('Domain');
  clearOriginCache(); // a disabled domain must stop working at once, not after the cache expires
  await recordPlatformAudit({ action: input.active === false ? 'domain.disabled' : input.active === true ? 'domain.enabled' : 'domain.updated', targetType: 'domain', targetId: id, meta: { origin: d.origin } });
  return shape(d);
};

export const removeDomain = async (id: string) => {
  if (!isValidObjectId(id)) throw notFound('Domain');
  const d = await AllowedDomain.findByIdAndDelete(id).lean();
  if (!d) throw notFound('Domain');
  clearOriginCache();
  await recordPlatformAudit({ action: 'domain.removed', targetType: 'domain', targetId: id, meta: { origin: d.origin } });
  return { id, removed: true };
};
