import pino from 'pino';
import { env } from '../../config/env.js';
import { getContext } from '../kernel/context.js';

/** Structured JSON logs. Secrets are redacted; requestId/tenantId are attached automatically. */
export const logger = pino({
  level: env.LOG_LEVEL,
  redact: ['req.headers.authorization', '*.password', '*.passwordHash', '*.token'],
  mixin() {
    const c = getContext();
    return c ? { requestId: c.requestId, tenantId: c.tenantId, userId: c.userId } : {};
  },
});
