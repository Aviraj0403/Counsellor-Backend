import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

/** Per-request facts available anywhere (logs, audit) without passing them through every function. */
export interface RequestContext {
  requestId: string;
  userId?: string;
  tenantId?: string;
  /** platform staff acting inside an organisation: audit rows written in this request are stamped actingAs */
  actingAs?: boolean;
}

const storage = new AsyncLocalStorage<RequestContext>();

export const getContext = (): RequestContext | undefined => storage.getStore();

export const requestContext = (req: Request, res: Response, next: NextFunction) => {
  const incoming = req.header('x-request-id');
  const requestId = incoming && /^[\w-]{8,64}$/.test(incoming) ? incoming : randomUUID();
  res.setHeader('x-request-id', requestId);
  storage.run({ requestId }, next);
};
