import { env } from '../../../../config/env.js';
import { httpRequest } from '../../../../shared/infra/http.js';
import { classifyGraphError, type SyncErrorCode } from '../domain/meta.insights.domain.js';

/**
 * Minimal Meta Graph reader for the insights sync and the connection test. The token travels in the Authorization header
 * (never in the URL) and is never part of an error message. Goes through shared/infra/http, so tests fake it with setHttpClient.
 */
export class GraphError extends Error {
  constructor(
    public readonly code: SyncErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'GraphError';
  }
}

const HOST = 'graph.facebook.com';
const MAX_PAGES = 50;

export const graphBase = (apiVersion?: string): string => `https://${HOST}/${apiVersion || env.META_GRAPH_VERSION}`;

const get = async (url: string, token: string): Promise<any> => {
  let res;
  try {
    res = await httpRequest(url, { method: 'GET', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, timeoutMs: 30_000 });
  } catch {
    throw new GraphError('NETWORK', 'Could not reach Meta (network problem or timeout). It will be tried again on the next run.');
  }
  if (!res.ok) {
    const c = classifyGraphError(res.status, res.data?.error);
    throw new GraphError(c.code, c.message);
  }
  return res.data;
};

const qs = (q: Record<string, string | number>): string => new URLSearchParams(Object.entries(q).map(([k, v]) => [k, String(v)])).toString();

export const graphGet = (path: string, token: string, apiVersion: string | undefined, query: Record<string, string | number> = {}): Promise<any> =>
  get(`${graphBase(apiVersion)}/${path.replace(/^\/+/, '')}${Object.keys(query).length ? `?${qs(query)}` : ''}`, token);

/** Follows `paging.next` (same host only, access_token stripped) and returns every row. */
export const graphGetAll = async (path: string, token: string, apiVersion: string | undefined, query: Record<string, string | number> = {}, maxPages = MAX_PAGES): Promise<any[]> => {
  const out: any[] = [];
  let url: string | undefined = `${graphBase(apiVersion)}/${path.replace(/^\/+/, '')}?${qs(query)}`;
  for (let page = 0; url && page < maxPages; page++) {
    const j = await get(url, token);
    if (Array.isArray(j?.data)) out.push(...j.data);
    const next: unknown = j?.paging?.next;
    url = undefined;
    if (typeof next === 'string') {
      try {
        const u = new URL(next);
        if (u.protocol === 'https:' && u.hostname === HOST) {
          u.searchParams.delete('access_token');
          url = u.toString();
        }
      } catch {
        /* ignore a malformed next link */
      }
    }
  }
  return out;
};
