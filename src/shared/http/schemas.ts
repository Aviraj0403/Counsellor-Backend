import { z } from 'zod';

/** Request-validation building blocks shared by every module's routes. */
export const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'Invalid id');

export const paging = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

/** Billing month, e.g. 2026-11 */
export const period = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use the format 2026-11');

export const password = z.string().min(10, 'Use at least 10 characters').max(128);
