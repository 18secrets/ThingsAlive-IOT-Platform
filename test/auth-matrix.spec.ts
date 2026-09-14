import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { createApp } from '../src/main';

/**
 * Task P0-04 — the auth matrix.
 *
 * Enumerates every route the application actually registers and asserts each one
 * either refuses an anonymous caller or is a deliberately public route. New
 * controllers are covered the moment they are added; nobody has to remember to
 * extend this file.
 */
describe('auth matrix (P0-03 / P0-04)', () => {
  let app: INestApplication;
  let routes: { method: string; path: string }[];

  beforeAll(async () => {
    process.env.AUTH_JWT_SECRET = 'test-secret';
    process.env.CORS_ORIGINS = 'http://localhost:3000';
    // These suites exercise HTTP behaviour and need no database. Saying so
    // explicitly beats depending on whether DB_HOST happens to be set.
    app = await createApp({ database: false });
    await app.init();
    routes = listRoutes(app);
  });

  afterAll(async () => { await app?.close(); });

  const PUBLIC_ROUTES = new Set(['GET /api/v1/health', 'GET /api/v1/ready']);

  it('registers routes to check', () => {
    expect(routes.length).toBeGreaterThan(0);
  });

  it('refuses anonymous callers on every non-public route', async () => {
    const leaks: string[] = [];
    for (const r of routes) {
      const key = `${r.method} ${r.path}`;
      if (PUBLIC_ROUTES.has(key)) continue;
      const res = await (request(app.getHttpServer()) as any)[r.method.toLowerCase()](r.path);
      if (res.status !== 401) leaks.push(`${key} → ${res.status}`);
    }
    // Naming the offending routes matters more than the count when this fails.
    expect(leaks).toEqual([]);
  });

  it('serves the declared public routes without a token', async () => {
    for (const key of PUBLIC_ROUTES) {
      const [method, path] = key.split(' ');
      const res = await (request(app.getHttpServer()) as any)[method.toLowerCase()](path);
      expect(res.status).toBe(200);
    }
  });

  it('rejects a token that carries no tenant claim', async () => {
    const jwt = app.get(JwtService);
    const token = await jwt.signAsync({ sub: 'u1' }, { secret: 'test-secret' });
    const res = await request(app.getHttpServer())
      .get('/api/v1/me')
      .set('Authorization', `Bearer ${token}`);
    // The legacy prerequisite (P0-15): no tenant claim, no request.
    expect(res.status).toBe(401);
    expect(res.body.error.message).toMatch(/client_id/);
  });

  it('rejects a malformed bearer token on a protected route', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/me')
      .set('Authorization', 'Bearer not-a-jwt');
    expect(res.status).toBe(401);
  });

  it('resolves a scope from a well-formed token', async () => {
    const jwt = app.get(JwtService);
    const token = await jwt.signAsync(
      { sub: 'u-42', client_id: 'tenant-7', roles: ['Admin'], plant_ids: ['p1', 'p2'] },
      { secret: 'test-secret' },
    );
    const res = await request(app.getHttpServer())
      .get('/api/v1/me')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      tenantId: 'tenant-7',
      userId: 'u-42',
      roles: ['admin'],
      isPlatformRole: false,
    });
    expect(res.body.scope.plants).toEqual(['p1', 'p2']);
    // Unset means unrestricted within the tenant — not "none".
    expect(res.body.scope.equipment).toBe('unrestricted');
  });
});

function listRoutes(app: INestApplication): { method: string; path: string }[] {
  const instance: any = app.getHttpAdapter().getInstance();
  const stack = instance?.router?.stack ?? instance?._router?.stack ?? [];
  const out: { method: string; path: string }[] = [];
  for (const layer of stack) {
    if (!layer.route) continue;
    const path = layer.route.path;
    const methods = layer.route.methods ?? {};
    for (const m of Object.keys(methods)) {
      if (methods[m] && m !== '_all') out.push({ method: m.toUpperCase(), path });
    }
  }
  return out;
}
