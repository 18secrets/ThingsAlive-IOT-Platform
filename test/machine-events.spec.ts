import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { RequestScope } from '../src/auth/types/request-scope';
import { createApp } from '../src/main';
import { eventWindow, MAX_EVENT_WINDOW_DAYS } from '../src/page/machine-events';
import { PageService } from '../src/page/page.service';
import { createTestDataSource, describeDb } from './db';

const SECRET = 'test-secret-machine-events';
const ISSUER = 'things-alive-machine-events-test';
const SRC = 'iot-platform-1';
const NOW = new Date('2026-11-10T12:00:00.000Z');
const MIN = 60_000;
const acme: RequestScope = { tenantId: 'acme', userId: 'u-acme', roles: ['admin'], isPlatformRole: false };

/**
 * A pump's event history (Crompton U6, 11 Nov): starts, trips with their reason and the
 * supply leaving the warning band, as one list, read from the signals the motor job and
 * the logger already write. A voltage event is judged against the machine's own band;
 * without one the answer says so rather than guessing a band.
 */
describe('the event window', () => {
  it('defaults to the last day, is cut at now, and refuses a backwards or over-long one', () => {
    expect(eventWindow(undefined, undefined, NOW)).toEqual({ from: new Date(NOW.getTime() - 86_400_000), to: NOW });
    expect(eventWindow(new Date('2026-11-09Z'), new Date('2026-12-01Z'), NOW).to).toEqual(NOW);
    expect(() => eventWindow(new Date('2026-11-10T13:00Z'), NOW, NOW)).toThrow(/before to/);
    expect(() => eventWindow(new Date(NOW.getTime() - (MAX_EVENT_WINDOW_DAYS + 1) * 86_400_000), NOW, NOW)).toThrow(/at most/);
  });
});

describeDb('GET /equipment/:ss/:id/events', () => {
  let owner: DataSource;
  let app: INestApplication;
  let pages: PageService;

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    Object.assign(process.env, {
      AUTH_JWT_SECRET: SECRET, AUTH_JWT_ISSUER: ISSUER, AUTH_TENANT_CLAIM: 'client_id', CORS_ORIGINS: 'http://localhost:3000',
    });
    app = await createApp({ database: true });
    await app.init();
    pages = app.get(PageService);
    await owner.query(`SELECT ensure_telemetry_partition('2026-11-01'::date)`);
    await owner.query(`INSERT INTO tenant (tenant_id, name) VALUES ('acme', 'acme')`);
    for (const id of ['PUMP-1', 'PUMP-2']) {
      await owner.query(
        `INSERT INTO equipment_profile (tenant_id, source_system, external_id, name, tier, readiness, updated_by)
           VALUES ('acme', $1, $2, $2, 'standard', '{}'::jsonb, 'u')`, [SRC, id],
      );
    }
    const bind = (id: string, signal: string) => owner.query(
      `INSERT INTO signal_binding_version (tenant_id, source_system, external_id, signal_key, measurement_role, component_id,
         origin, imei, channel, canonical_unit, valid_from, is_primary, status, discovered_by, approved_by, approved_at)
       VALUES ('acme', $1, $2, $3, $3, '', 'physical', $4, $3, 'x', '2026-01-01', true, 'active', 'manual', 'u', '2026-01-01')`,
      [SRC, id, signal, `imei-${id}`],
    );
    const read = (id: string, signal: string, minutesAgo: number, value: number) => owner.query(
      `INSERT INTO telemetry_reading (tenant_id, imei, signal, value, source_timestamp, received_at, source)
         VALUES ('acme', $1, $2, $3, $4, $4, 'live')`, [`imei-${id}`, signal, value, new Date(NOW.getTime() - minutesAgo * MIN)],
    );
    for (const s of ['motor_starts', 'trip_overload', 'trip_supply', 'trip_overtemp', 'supply_voltage_min', 'supply_voltage_max']) {
      await bind('PUMP-1', s);
    }
    await bind('PUMP-2', 'supply_voltage_min');
    // PUMP-1: started at -90 and -30, an overload trip at -60 (zero minutes are no events),
    // a sag to 176 V at -45 under its 190 V warning line, a surge to 255 V at -20 over 250 V.
    await read('PUMP-1', 'motor_starts', 90, 1); await read('PUMP-1', 'motor_starts', 30, 2); await read('PUMP-1', 'motor_starts', 10, 0);
    await read('PUMP-1', 'trip_overload', 60, 1); await read('PUMP-1', 'trip_supply', 60, 0);
    await read('PUMP-1', 'supply_voltage_min', 45, 176); await read('PUMP-1', 'supply_voltage_min', 40, 205);
    await read('PUMP-1', 'supply_voltage_max', 20, 255); await read('PUMP-1', 'supply_voltage_max', 15, 240);
    await read('PUMP-2', 'supply_voltage_min', 45, 150);
    // The band on PUMP-1 alone, as a nameplate value on the machine.
    const [{ id: p1 }] = await owner.query(`SELECT id FROM equipment_profile WHERE external_id = 'PUMP-1'`);
    for (const [name, value] of [['voltage_warn_low', 190], ['voltage_warn_high', 250]] as const) {
      await owner.query(
        `INSERT INTO tenant_parameter (tenant_id, scope, scope_ref, name, value, unit, effective_from, created_by)
           VALUES ('acme', 'equipment', $1, $2, $3::jsonb, 'V', '2026-01-01', 'u')`, [p1, name, JSON.stringify(value)],
      );
    }
  }, 90_000);

  afterAll(async () => { await app?.close(); await owner?.destroy(); });

  const ref = (id: string) => ({ sourceSystem: SRC, externalId: id });

  it('lists starts, trips with their reason and voltage events against the band, newest first', async () => {
    const r = await pages.machineEvents(acme, ref('PUMP-1'), undefined, undefined, NOW);
    expect(r.events.map((e) => [e.kind, e.value, e.limit ?? null])).toEqual([
      ['voltage_high', 255, 250],
      ['start', 2, null],
      ['voltage_low', 176, 190],
      ['trip_overload', 1, null],
      ['start', 1, null],
    ]);
    expect(r.unavailable).toEqual([]);
    expect(r.truncated).toBe(false);
  });

  it('a machine with no band gets no voltage events, said as such; unbound signals are named', async () => {
    const r = await pages.machineEvents(acme, ref('PUMP-2'), undefined, undefined, NOW);
    expect(r.events).toEqual([]);
    expect(r.unavailable).toEqual(expect.arrayContaining([
      { kind: 'starts', reason: 'unbound' }, { kind: 'trips', reason: 'unbound' }, { kind: 'voltage', reason: 'no_voltage_band' },
    ]));
  });

  it('answers over HTTP, and refuses an unreadable date and a window over a week', async () => {
    const token = `Bearer ${await app.get(JwtService).signAsync(
      { sub: '00000000-0000-4000-8000-0000000000c1', client_id: 'acme', roles: ['admin'] }, { secret: SECRET, issuer: ISSUER },
    )}`;
    const get = (qs: string) => request(app.getHttpServer()).get(`/api/v1/equipment/${SRC}/PUMP-1/events${qs}`).set('Authorization', token);
    expect((await get(`?from=${new Date(NOW.getTime() - 2 * 3_600_000).toISOString()}&to=${NOW.toISOString()}`)).body.events).toHaveLength(5);
    expect((await get('?from=yesterday')).status).toBe(400);
    expect((await get('?from=2026-10-01T00:00:00Z&to=2026-11-01T00:00:00Z')).status).toBe(400);
  });
});
