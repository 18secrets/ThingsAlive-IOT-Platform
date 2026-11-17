import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { createApp } from '../src/main';
import { createTestDataSource, describeDb } from './db';

/**
 * Test report MIN-2: "Malformed email at sign-in gives a generic banner 'Request
 * validation failed.' instead of a field-level message." The console was fixed to check
 * the field itself on 30 Oct; the API, which every other caller sees, still said nothing
 * about what was wrong. These send the malformed request through the real app — the
 * validation pipe and the error envelope — and read what comes back.
 */
describeDb('a request that fails validation says what failed (MIN-2)', () => {
  let app: INestApplication;
  let owner: DataSource;

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    process.env.AUTH_JWT_SECRET = 'test-secret';
    process.env.CORS_ORIGINS = 'http://localhost:3000';
    process.env.AUTH_JWT_ISSUER = '';
    // Sign-in lives in the identity module, which boots only with a database.
    app = await createApp({ database: true });
    await app.init();
  }, 60_000);

  afterAll(async () => { await app?.close(); await owner?.destroy(); });

  it('a malformed email at sign-in: 400, and the message is the sentence about the email', async () => {
    const res = await request(app.getHttpServer()).post('/api/v1/auth/sign-in').send({ email: 'abc', password: 'whatever' });
    expect(res.status).toBe(400);
    expect(res.body.error).toEqual({
      code: 'bad_request',
      message: 'That is not a valid email address. Check it reads like name@company.com.',
      details: { violations: ['That is not a valid email address. Check it reads like name@company.com.'] },
    });
  });

  it('several problems: the first leads and the rest are counted; every one stays in details', async () => {
    const res = await request(app.getHttpServer()).post('/api/v1/auth/sign-in').send({ email: 'abc' });
    expect(res.status).toBe(400);
    const { message, details } = res.body.error;
    expect(details.violations.length).toBeGreaterThan(1);
    expect(message).toBe(`${details.violations[0]} (and ${details.violations.length - 1} more problem${details.violations.length === 2 ? '' : 's'} with this request)`);
    expect(message).not.toBe('Request validation failed.');
  });
});
