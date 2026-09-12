import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createApp } from '../src/main';

/**
 * The API convention from the architecture paper: every non-2xx response carries
 * { error: { code, message, details } }. Tested here because a response envelope
 * that is right on three endpoints and wrong on the fourth is worse than none.
 */
describe('error envelope', () => {
  let app: INestApplication;

  beforeAll(async () => {
    process.env.AUTH_JWT_SECRET = 'test-secret';
    process.env.CORS_ORIGINS = 'http://localhost:3000';
    app = await createApp();
    await app.init();
  });

  afterAll(async () => { await app?.close(); });

  it('wraps an unauthenticated request', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/me');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({
      error: { code: 'unauthenticated', message: expect.any(String), details: undefined },
    });
  });

  it('wraps a not-found', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/nothing-here');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not_found');
  });

  it('never leaks an internal message on a 500', async () => {
    // The filter logs the real error and returns a fixed message. Asserted so a
    // future change cannot start returning stack traces to callers.
    const { ErrorEnvelopeFilter } = await import('../src/common/filters/error-envelope.filter');
    const filter = new ErrorEnvelopeFilter();
    const json = jest.fn();
    const status = jest.fn(() => ({ json }));
    filter.catch(new Error('connection string is postgres://user:hunter2@host/db'), {
      switchToHttp: () => ({
        getResponse: () => ({ status }),
        getRequest: () => ({ method: 'GET', url: '/api/v1/x' }),
      }),
    } as any);
    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith({
      error: { code: 'internal_error', message: 'An unexpected error occurred.', details: undefined },
    });
    expect(JSON.stringify(json.mock.calls)).not.toContain('hunter2');
  });
});
