import { logger } from '../../../../shared/infra/logger.js';
import { getContext } from '../../../../shared/kernel/context.js';
import { PlatformAudit } from '../infrastructure/platformAudit.model.js';

/** Records a platform-level event. Never blocks the user's action; a failed write is logged for operators. */
export const recordPlatformAudit = async (entry: {
  action: string;
  targetType: 'tenant' | 'user' | 'module' | 'plan' | 'invoice' | 'cost';
  targetId?: string;
  tenantId?: string;
  meta?: Record<string, unknown>;
}) => {
  const ctx = getContext();
  try {
    await PlatformAudit.create({ ...entry, actorId: ctx?.userId, requestId: ctx?.requestId });
  } catch (err) {
    logger.error({ err, entry }, 'platform audit write failed');
  }
};

export const listPlatformAudit = async (q: { page: number; limit: number; tenantId?: string }) => {
  const filter = q.tenantId ? { tenantId: q.tenantId } : {};
  const [items, total] = await Promise.all([
    PlatformAudit.find(filter).sort({ at: -1 }).skip((q.page - 1) * q.limit).limit(q.limit).lean(),
    PlatformAudit.countDocuments(filter),
  ]);
  return { items, total, page: q.page, limit: q.limit };
};
