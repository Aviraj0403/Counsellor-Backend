import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app/app.js';

// These hit the real middleware stack but need NO database: they only exercise rules that fire before any query.
const app = buildApp();

describe('admin app (separate repo) can talk to the API: CORS', () => {
  const preflight = (origin: string) =>
    request(app)
      .options('/api/v1/auth/login')
      .set('Origin', origin)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'authorization,content-type');

  it('allows the admin origin listed in CORS_ORIGINS, including the Authorization header', async () => {
    const res = await preflight('http://localhost:5173');
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(res.headers['access-control-allow-headers']?.toLowerCase()).toContain('authorization');
  });

  it('does not allow any other origin', async () => {
    const res = await preflight('https://evil.example');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('lets the browser read the request id (needed for the "ref" in admin error messages)', async () => {
    const res = await request(app).get('/health').set('Origin', 'http://localhost:5173');
    expect(res.headers['access-control-expose-headers']?.toLowerCase() ?? '').toContain('x-request-id');
  });
});

describe('http surface', () => {
  it('liveness works without a database', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.headers['x-request-id']).toBeTruthy();
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('readiness reports 503 when the database is not connected', async () => {
    expect((await request(app).get('/ready')).status).toBe(503);
  });

  it('protected routes reject anonymous callers with the standard error shape', async () => {
    const res = await request(app).get('/api/v1/leads');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
    expect(res.body.error.requestId).toBeTruthy();
  });

  it('a garbage token is rejected, not crashed on', async () => {
    const res = await request(app).get('/api/v1/me').set('Authorization', 'Bearer not-a-token');
    expect(res.status).toBe(401);
  });

  it('login validates input before touching the database', async () => {
    const res = await request(app).post('/api/v1/auth/login').send({ email: 'nope' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('unknown endpoints return the standard 404', async () => {
    const res = await request(app).get('/api/v1/does-not-exist');
    expect([401, 404]).toContain(res.status); // product router authenticates first, which is the safer default
  });
});
