import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { env } from '../../config/env.js';
import { AppError } from '../kernel/errors.js';
import { getContext } from '../kernel/context.js';
import { logger } from '../infra/logger.js';

/** One error shape for every endpoint: { error: { code, message, details?, requestId } } */
export const errorHandler = (err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const requestId = getContext()?.requestId;
  let status = 500;
  let code = 'INTERNAL_ERROR';
  let message = 'Something went wrong on our side. Please try again.';
  let details: unknown;

  if (err instanceof AppError) {
    ({ status, code, message, details } = err);
  } else if (err instanceof ZodError) {
    status = 400;
    code = 'VALIDATION_ERROR';
    message = 'Some fields are missing or invalid.';
    details = err.issues.map((i) => ({ field: i.path.join('.'), problem: i.message }));
  } else if ((err as any)?.code === 11000) {
    status = 409;
    code = 'DUPLICATE';
    message = 'This record already exists.';
  } else if ((err as any)?.type === 'entity.parse.failed') {
    status = 400;
    code = 'BAD_JSON';
    message = 'Request body is not valid JSON.';
  } else {
    logger.error({ err }, 'unhandled error');
    if (env.NODE_ENV !== 'production') message = (err as Error)?.message ?? message;
  }

  res.status(status).json({ error: { code, message, ...(details ? { details } : {}), requestId } });
};
