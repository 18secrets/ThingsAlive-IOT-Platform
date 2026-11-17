import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { RequestScope } from '../src/auth/types/request-scope';
import { createApp } from '../src/main';
import { MAX_RANGE_DAYS, OeeService, rangeBounds } from '../src/utilization/services/oee.service';
import { createTestDataSource, describeDb } from './db';

const SECRET = 'test-secret-oee-range';
const ISSUER = 'things-alive-oee-range-test';
const DAY = 86_400_000;
const SRC = 'iot-platform-1';
const acme: RequestScope = { tenantId: 'acme', userId: 'u-acme', roles: ['admin'], isPlatformRole: false };

/**
 * OEE over a picked range (test report P3-D4): Production detail offered today, this week
 * or this month, and "1 to 15 October" could not be asked. A range is only new bounds for
 * the same sums, so these hold it to the rules a named window already keeps — cut at now,
 * nothing before it starts — and to the same answer a named window gives for the same span.
 */
describe('a picked OEE range', () => {
  const now = new Date('2026-11-11T12:00:00Z');

  it('is cut at now, and says how many days it covers', () => {
    const b = rangeBounds(new Date('2026-11-01T00:00:00Z'), new Date('2026-11-20T00:00:00Z'), now);
    expect(b.to).toEqual(now);
    expect(b.daysCovered).toBe(11);
  });

  it('refuses one that runs backwards, one entirely in the future, and one over the cap', () => {
    expect(() => rangeBounds(new Date('2026-11-05Z'), new Date('2026-11-01Z'), now)).toThrow(/to must be after from/);
    expect(() => rangeBounds(new Date('2026-12-01Z'), new Date('2026-12-05Z'), now)).toThrow(/not started yet/);
    const from = new Date(now.getTime() - (MAX_RANGE_DAYS + 1) * DAY);
    expect(() => rangeBounds(from, now, now)).toThrow(new RegExp(`at most ${MAX_RANGE_DAYS} days`));
    expect(() => rangeBounds(new Date(now.getTime() - MAX_RANGE_DAYS * DAY), now, now)).not.toThrow();
  });
});

describeDb('a picked OEE range, through the service and GET …/oee?from&to', () => {
  let owner: DataSource;
  let app: INestApplication;
  let oee: OeeService;

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    Object.assign(process.env, {
      AUTH_JWT_SECRET: SECRET, AUTH_JWT_ISSUER: ISSUER, AUTH_TENANT_CLAIM: 'client_id', CORS_ORIGINS: 'http://localhost:3000',
    });
    app = await createApp({ database: true });
    await app.init();
    oee = app.get(OeeService);
    await owner.query(`INSERT INTO tenant (tenant_id, name) VALUES ('acme', 'acme')`);
    await owner.query(
      `INSERT INTO equipment_profile (tenant_id, source_system, external_id, name, tier, readiness, updated_by)
         VALUES ('acme', $1, 'EX-1', 'EX-1', 'standard', '{}'::jsonb, 'u')`, [SRC],
    );
  }, 90_000);

  afterAll(async () => { await app?.close(); await owner?.destroy(); });

  const ref = { sourceSystem: SRC, externalId: 'EX-1' };
  const get = async (qs: string) => request(app.getHttpServer())
    .get(`/api/v1/equipment/${SRC}/EX-1/oee?${qs}`)
    .set('Authorization', `Bearer ${await app.get(JwtService).signAsync(
      { sub: '00000000-0000-4000-8000-0000000000c1', client_id: 'acme', roles: ['admin'] }, { secret: SECRET, issuer: ISSUER },
    )}`);

  it('a range that is exactly one UTC day answers as the day window does, labelled a range', async () => {
    const day = new Date('2026-11-02T00:00:00Z');
    const after = new Date('2026-11-04T00:00:00Z');
    const named = await oee.forEquipment(acme, ref, 'day', day, after);
    const picked = await oee.forEquipment(acme, ref, { from: day, to: new Date(day.getTime() + DAY) }, day, after);
    expect(picked.window).toBe('range');
    expect({ ...picked, window: 'day' }).toEqual(named);
  });

  it('answers 200 over HTTP with the bounds it used', async () => {
    const res = await get('from=2026-11-01T00:00:00Z&to=2026-11-03T00:00:00Z');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ window: 'range', from: '2026-11-01T00:00:00.000Z', to: '2026-11-03T00:00:00.000Z', daysCovered: 2 });
  });

  it('refuses half a range, a backwards one, and "range" asked for by name', async () => {
    expect((await get('from=2026-11-01T00:00:00Z')).status).toBe(400);
    expect((await get('from=2026-11-05T00:00:00Z&to=2026-11-01T00:00:00Z')).status).toBe(400);
    expect((await get('window=range')).status).toBe(400);
    // The named windows are unchanged.
    expect((await get('window=week&at=2026-11-02T00:00:00Z')).status).toBe(200);
  });
});
