import { logger } from '../../../../shared/infra/logger.js';
import { getContext } from '../../../../shared/kernel/context.js';
import { AuditModel } from '../infrastructure/audit.model.js';

/** Writes one audit row. Audit must never break the user's action, but a failure must be visible to operators. */
export const audit = async (
  tenantId: string,
  entry: { action: string; entity: string; entityId?: string; meta?: Record<string, unknown> },
) => {
  const ctx = getContext();
  try {
    await AuditModel(tenantId).create({ ...entry, actorId: ctx?.userId, requestId: ctx?.requestId, ...(ctx?.actingAs ? { actingAs: true } : {}) });
  } catch (err) {
    logger.error({ err, entry }, 'audit write failed');
  }
};

export const listAudit = async (tenantId: string, q: { page: number; limit: number; entityId?: string }) => {
  const filter = q.entityId ? { entityId: q.entityId } : {};
  const M = AuditModel(tenantId);
  const [items, total] = await Promise.all([M.find(filter).sort({ at: -1 }).skip((q.page - 1) * q.limit).limit(q.limit).lean(), M.countDocuments(filter)]);
  return { items, total, page: q.page, limit: q.limit };
};

/** Most recent activity of an organisation (used by platform research). */
export const lastActivityAt = async (tenantId: string): Promise<Date | null> => {
  const row = await AuditModel(tenantId).findOne().sort({ at: -1 }).select('at').lean<any>();
  return row?.at ?? null;
};
