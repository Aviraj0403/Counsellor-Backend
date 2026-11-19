/**
 * Outbound HTTP (Meta, WhatsApp, Razorpay, customer webhooks). One function, injectable, so every integration can be
 * tested with a fake and no test ever touches the internet.
 *   production: httpRequest() uses fetch with a timeout
 *   tests:      setHttpClient(fake) then resetHttpClient() in afterEach
 * It never throws on a non-2xx answer (check `ok`); it throws only when the network itself fails or times out.
 */
export interface HttpRequest {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  headers?: Record<string, string>;
  /** an object is sent as JSON; a string is sent as is */
  body?: unknown;
  timeoutMs?: number;
}

export interface HttpResponse<T = any> {
  status: number;
  ok: boolean;
  data: T;
  text: string;
}

export type HttpClient = (url: string, req?: HttpRequest) => Promise<HttpResponse>;

const fetchClient: HttpClient = async (url, req = {}) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), req.timeoutMs ?? 10_000);
  try {
    const isJson = req.body !== undefined && typeof req.body !== 'string';
    const res = await fetch(url, {
      method: req.method ?? (req.body !== undefined ? 'POST' : 'GET'),
      headers: { ...(isJson ? { 'content-type': 'application/json' } : {}), ...req.headers },
      body: req.body === undefined ? undefined : isJson ? JSON.stringify(req.body) : (req.body as string),
      signal: controller.signal,
    });
    const text = await res.text();
    let data: unknown = text;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      /* not JSON: keep the text */
    }
    return { status: res.status, ok: res.ok, data, text };
  } finally {
    clearTimeout(timer);
  }
};

let client: HttpClient = fetchClient;

export const httpRequest: HttpClient = (url, req) => client(url, req);
export const setHttpClient = (c: HttpClient): void => {
  client = c;
};
export const resetHttpClient = (): void => {
  client = fetchClient;
};
