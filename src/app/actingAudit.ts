import type { NextFunction, Request, Response } from 'express';
import { audit } from '../product/modules/audit/index.js';

/**
 * While platform staff act inside an organisation (docs/adr/0004), every write and every blocked attempt is written to THAT
 * organisation's audit log (actor = the staff member, actingAs = true) BEFORE the response is sent, so the record exists by the
 * time the caller sees the answer. Reads are not logged here (they are high volume); they are covered by the start event and request logs.
 */
const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

export const actingAudit = (req: Request, res: Response, next: NextFunction) => {
  const end = res.end.bind(res) as (...a: unknown[]) => Response;
  let done = false;
  (res as any).end = (...args: unknown[]) => {
    const acting = req.principal?.actingAs;
    if (done || !acting) return end(...args);
    done = true;
    const blocked = res.statusCode === 403;
    if (SAFE.has(req.method) && !blocked) return end(...args);
    void audit(acting.tenantId, {
      action: blocked ? 'acting.blocked' : 'acting.write',
      entity: 'request',
      meta: { method: req.method, path: req.originalUrl.split('?')[0], status: res.statusCode, role: req.principal!.role },
    }).finally(() => end(...args));
    return res;
  };
  next();
};
