import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { createApp } from '../src/main';
import { MAX_BODY_BYTES, MotorBatch, readingTimes, validateBatch } from '../src/motor-ingest/motor-ingest.service';
import { batches, MINI_1HP, SCENARIOS, simulate } from '../scripts/motor-logger-sim';
import { mintPlatformToken } from '../src/platform/platform-token';
import { createTestDataSource, describeDb, undoMigrationNamed } from './db';

const MIGRATION = 'MotorLoggerIngest1763900000000';
const SECRET = 'test-secret-motor-ingest';
const ISSUER = 'things-alive-motor-ingest-test';

/** A batch the way the firmware sends one: seq range, device clock, one record a second. */
const batch = (first: number, last: number, extra: Partial<MotorBatch> = {}): MotorBatch => {
  const records = Array.from({ length: last - first + 1 }, (_, i) => ({
    seq: first + i, timestamp: 1000 + (first - 1001) + i,
    voltage: 230.5, current: 0.85 + i / 100, power_factor: 0.92, temperature: 45.6, rpm: 1450,
  }));
  return {
    device_id: 'MOTOR_001', batch_id: `MOTOR_001-${first}-${last}`, first_seq: first, last_seq: last,
    count: records.length, boot: 3, lost_total: 0, dropped_total: 0,
    device_now: records[records.length - 1].timestamp + 10, records, ...extra,
  };
};

/**
 * The motor logger contract (SIM800L GSM loggers). The device deletes its flash copy
 * only on an ACK, so every rule here is about never ACKing what was not stored and
 * always ACKing what was — including the second, third and tenth time it arrives.
 */
describe('motor logger: reading times', () => {
  const arrived = new Date('2026-11-09T12:00:00.000Z');

  it('with device_now, each reading is placed by how long before the send it was taken', () => {
    const [first] = readingTimes(batch(1001, 1002), arrived);
    expect(first).toEqual({ readingAt: new Date('2026-11-09T11:59:49.000Z'), basis: 'device_now' });
  });

  it('a batch resent three hours late still lands at the right time', () => {
    const late = new Date(arrived.getTime() + 3 * 3_600_000);
    const b = batch(1001, 1002, { device_now: 1001 + 10 + 3 * 3600 });
    expect(readingTimes(b, late)[0].readingAt).toEqual(new Date('2026-11-09T11:59:49.000Z'));
  });

  it('without device_now (older firmware) the time is approximate, and says so', () => {
    const times = readingTimes(batch(1001, 1002, { device_now: undefined }), arrived);
    expect(times.map((t) => t.basis)).toEqual(['approximate', 'approximate']);
    expect(times[1].readingAt).toEqual(arrived);
  });

  it('a record dated after device_now came from before a reboot: approximate, never in the future', () => {
    const b = batch(1001, 1002, { device_now: 5 });
    expect(readingTimes(b, arrived).every((t) => t.basis === 'approximate' && t.readingAt <= arrived)).toBe(true);
  });
});

/**
 * The simulator (`scripts/motor-logger-sim.ts`) stands in for the real logger until one
 * is wired, so it is held to the same contract the server enforces, and each scenario
 * to the signature the RCA matrix says it leaves.
 */
describe('motor logger: the simulator', () => {
  const END = 1_794_200_000;
  const BOOT = END - 3600;
  const run = (scenario: (typeof SCENARIOS)[number], seconds = 600) => simulate(scenario, seconds, END, BOOT);
  const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

  it('every scenario sends batches the server accepts, under the body limit', () => {
    for (const scenario of SCENARIOS) {
      for (const b of batches('MOTOR_001', run(scenario), END - BOOT)) {
        expect(() => validateBatch(b)).not.toThrow();
        expect(Buffer.byteLength(JSON.stringify(b))).toBeLessThanOrEqual(MAX_BODY_BYTES);
        expect(b.records.length).toBeLessThanOrEqual(50);
      }
    }
  });

  it('normal runs near 0.85 of rated current at ~230 V, F4 speed just under synchronous', () => {
    const r = run('normal');
    expect(avg(r.map((x) => x.current)) / MINI_1HP.ratedCurrent).toBeCloseTo(0.85, 1);
    expect(avg(r.map((x) => x.voltage))).toBeCloseTo(230, 0);
    expect(Math.max(...r.map((x) => x.rpm))).toBeLessThan(3000);
  });

  it('overload ends above 1.2 × rated current; low voltage ends below the 180 V fault line, drawing more current', () => {
    const over = run('overload');
    expect(avg(over.slice(-30).map((x) => x.current))).toBeGreaterThan(1.2 * MINI_1HP.ratedCurrent);
    const low = run('low-voltage');
    expect(avg(low.slice(-30).map((x) => x.voltage))).toBeLessThan(180);
    expect(avg(low.slice(-30).map((x) => x.current))).toBeGreaterThan(avg(low.slice(0, 30).map((x) => x.current)));
    expect(avg(run('high-voltage').slice(-30).map((x) => x.voltage))).toBeGreaterThan(260);
  });

  it('dry run: current drops about 30% and power factor falls (RCA 1)', () => {
    const r = run('dry-run', 900);
    const before = avg(r.slice(0, 200).map((x) => x.current));
    const after = avg(r.slice(-200).map((x) => x.current));
    expect(after / before).toBeLessThan(0.75);
    expect(avg(r.slice(-200).map((x) => x.power_factor))).toBeLessThan(avg(r.slice(0, 200).map((x) => x.power_factor)));
  });

  it('cycling stops and restarts every two minutes (RCA 10): zero current and speed while off', () => {
    const r = run('cycling', 600);
    const starts = r.filter((x, i) => i > 0 && r[i - 1].current === 0 && x.current > 0).length;
    expect(starts).toBeGreaterThanOrEqual(4);
    expect(r.filter((x) => x.current === 0).every((x) => x.rpm === 0)).toBe(true);
  });
});

describeDb('motor logger: the bulk upload over HTTP', () => {
  let app: INestApplication;
  let owner: DataSource;
  let key: string;

  const master = () => `Bearer ${mintPlatformToken({ role: 'master-admin', subject: 'deepak@things-alive.io' }, { secret: SECRET, issuer: ISSUER }).token}`;
  const client = async (tenant: string) => `Bearer ${await app.get(JwtService).signAsync(
    { sub: '00000000-0000-4000-8000-0000000000e1', client_id: tenant, roles: ['super admin'] }, { secret: SECRET, issuer: ISSUER },
  )}`;
  const post = (body: unknown, deviceKey: string | null = key) => {
    const r = request(app.getHttpServer()).post('/api/sensor-data/bulk').set('Content-Type', 'application/json');
    return (deviceKey ? r.set('X-Device-Key', deviceKey) : r).send(JSON.stringify(body));
  };
  const count = async (sql: string) => (await owner.query(sql))[0].n as number;

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    process.env.AUTH_JWT_SECRET = SECRET;
    process.env.AUTH_JWT_ISSUER = ISSUER;
    process.env.AUTH_TENANT_CLAIM = 'client_id';
    process.env.CORS_ORIGINS = 'http://localhost:3000';
    app = await createApp({ database: true });
    await app.init();
  }, 60_000);

  afterAll(async () => { await app?.close(); await owner?.destroy(); });

  beforeEach(async () => {
    await owner.query(`TRUNCATE "motor_sensor_records", "motor_upload_log", "motor_logger_key", "telemetry_reading", "device_inventory" CASCADE`);
    const issued = await request(app.getHttpServer()).post('/api/v1/motor-loggers/MOTOR_001/key').set('Authorization', master());
    expect(issued.status).toBe(201);
    key = issued.body.key;
  });

  const assign = (tenant = 'motors') => owner.query(
    `INSERT INTO "device_inventory" ("imei", "tenant_id", "state") VALUES ('MOTOR_001', $1, 'assigned')`, [tenant],
  );

  it('stores a batch and ACKs its last seq: 200, one line, status first, under 90 bytes', async () => {
    const res = await post(batch(1001, 1050));
    expect(res.status).toBe(200);
    expect(res.text).toBe('{"status":"ok","ack_seq":1050}');
    expect(Buffer.byteLength(res.text)).toBeLessThan(90);
    expect(await count(`SELECT count(*)::int AS n FROM "motor_sensor_records"`)).toBe(50);
    expect(await owner.query(`SELECT "record_count", "stored_count", "device_now"::int FROM "motor_upload_log"`))
      .toEqual([{ record_count: 50, stored_count: 50, device_now: 1059 }]);
  });

  it('a resent range is the same 200 ACK, stored once — never a 409', async () => {
    await post(batch(1001, 1050));
    const again = await post(batch(1001, 1050));
    expect(again.status).toBe(200);
    expect(again.text).toBe('{"status":"ok","ack_seq":1050}');
    expect(await count(`SELECT count(*)::int AS n FROM "motor_sensor_records"`)).toBe(50);
    expect(await owner.query(`SELECT "stored_count" FROM "motor_upload_log" ORDER BY "id"`)).toEqual([{ stored_count: 50 }, { stored_count: 0 }]);
  });

  it('the same records resent halved after a 413 are deduplicated per record, not per batch', async () => {
    await post(batch(1001, 1050));
    await post(batch(1001, 1025));
    await post(batch(1026, 1060));
    expect(await count(`SELECT count(*)::int AS n FROM "motor_sensor_records"`)).toBe(60);
  });

  it('two copies of one batch arriving together both get the ACK, and the records are stored once', async () => {
    const results = await Promise.allSettled([post(batch(1001, 1050)), post(batch(1001, 1050))]);
    expect(results.map((r) => r.status === 'fulfilled' && r.value.status)).toEqual([200, 200]);
    expect(await count(`SELECT count(*)::int AS n FROM "motor_sensor_records"`)).toBe(50);
  });

  it('an empty batch is ACKed', async () => {
    const res = await post({ ...batch(1001, 1001), records: [], count: 0 });
    expect(res.text).toBe('{"status":"ok","ack_seq":1001}');
  });

  it('no key, a wrong key, or an unknown device is 401, and nothing is stored', async () => {
    expect((await post(batch(1001, 1002), null)).status).toBe(401);
    expect((await post(batch(1001, 1002), 'f'.repeat(48))).status).toBe(401);
    expect((await post({ ...batch(1001, 1002), device_id: 'MOTOR_404' })).status).toBe(401);
    expect(await count(`SELECT count(*)::int AS n FROM "motor_sensor_records"`)).toBe(0);
  });

  it('a malformed batch is 422 naming the problem, and nothing is stored', async () => {
    const bad = batch(1001, 1002);
    bad.records[1].power_factor = 1.5;
    const res = await post(bad);
    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body)).toMatch(/record 2: power_factor is 0-1/);
    expect((await post({ ...batch(1001, 1002), count: 5 })).status).toBe(422);
    expect(await count(`SELECT count(*)::int AS n FROM "motor_sensor_records"`)).toBe(0);
  });

  it('a body over the limit is 413, so the device halves its batch', async () => {
    const res = await request(app.getHttpServer()).post('/api/sensor-data/bulk')
      .set('Content-Type', 'application/json').set('X-Device-Key', key)
      .send(JSON.stringify({ ...batch(1001, 1002), padding: 'x'.repeat(9000) }));
    expect(res.status).toBe(413);
  });

  it('an assigned logger\'s readings reach telemetry as one-minute aggregates, in its account', async () => {
    await assign();
    await post(batch(1001, 1050));
    const rows = await owner.query(
      `SELECT "signal", "value", "unit", "tenant_id" FROM "telemetry_reading" WHERE "imei" = 'MOTOR_001' ORDER BY "signal", "source_timestamp"`,
    );
    const signals = [...new Set(rows.map((r: { signal: string }) => r.signal))].sort();
    // The readings' nine, plus the logger's own health (no ratings here, so no running status).
    expect(signals).toEqual(['input_power', 'logger_records_dropped', 'logger_records_lost', 'motor_current', 'motor_current_max',
      'motor_speed_est', 'motor_temperature', 'power_factor', 'supply_voltage', 'supply_voltage_max', 'supply_voltage_min']);
    expect(rows.every((r: { tenant_id: string }) => r.tenant_id === 'motors')).toBe(true);
    // 50 readings, one a second: one or two minutes, never fifty rows a signal.
    expect(rows.filter((r: { signal: string }) => r.signal === 'motor_current').length).toBeLessThanOrEqual(2);
  });

  it('a minute split across two batches is recomputed whole, not left as its first half', async () => {
    await assign();
    const minuteOf = (b: MotorBatch) => ({ ...b, device_now: 1000 + 60 });
    await post(minuteOf(batch(1001, 1030)));
    await post(minuteOf(batch(1031, 1060)));
    const [{ n }] = await owner.query(
      `SELECT count(*)::int AS n FROM "motor_sensor_records" WHERE date_trunc('minute', "reading_at") =
         (SELECT date_trunc('minute', "reading_at") FROM "motor_sensor_records" WHERE "seq" = 1031)`,
    );
    const [agg] = await owner.query(
      `SELECT t."value" FROM "telemetry_reading" t WHERE t."imei" = 'MOTOR_001' AND t."signal" = 'motor_current'
         AND t."source_timestamp" = (SELECT date_trunc('minute', "reading_at") FROM "motor_sensor_records" WHERE "seq" = 1031)`,
    );
    const [expected] = await owner.query(
      `SELECT avg("current_a")::float8 AS v FROM "motor_sensor_records" WHERE date_trunc('minute', "reading_at") =
         (SELECT date_trunc('minute', "reading_at") FROM "motor_sensor_records" WHERE "seq" = 1031)`,
    );
    expect(n).toBeGreaterThan(30); // the minute really does hold readings from both batches
    expect(agg.value).toBeCloseTo(expected.v, 6);
  });

  it('an unassigned logger\'s readings are kept but never reach telemetry under a guessed account', async () => {
    await post(batch(1001, 1050));
    expect(await count(`SELECT count(*)::int AS n FROM "motor_sensor_records"`)).toBe(50);
    expect(await count(`SELECT count(*)::int AS n FROM "telemetry_reading"`)).toBe(0);
  });

  it('recent: an account sees its own loggers only; another account sees none of them', async () => {
    await assign('motors');
    await post(batch(1001, 1003));
    const mine = await request(app.getHttpServer()).get('/api/motor/recent?device_id=MOTOR_001&limit=2').set('Authorization', await client('motors'));
    expect(mine.status).toBe(200);
    expect(mine.body.records).toHaveLength(2);
    expect(mine.body.records[0]).toMatchObject({ device_id: 'MOTOR_001', seq: 1003, voltage_v: 230.5, time_basis: 'device_now' });
    expect(mine.body.devices).toEqual([expect.objectContaining({ device_id: 'MOTOR_001', total_records: 3, last_seq: 1003 })]);
    const theirs = await request(app.getHttpServer()).get('/api/motor/recent').set('Authorization', await client('acme'));
    expect(theirs.body).toEqual({ records: [], devices: [], uploads: [] });
    expect((await request(app.getHttpServer()).get('/api/motor/recent?device_id=MOTOR_001').set('Authorization', await client('acme'))).status).toBe(404);
    expect((await request(app.getHttpServer()).get('/api/motor/recent')).status).toBe(401);
  });

  it('only Master Admin issues keys, and a reissued key replaces the old one at once', async () => {
    expect((await request(app.getHttpServer()).post('/api/v1/motor-loggers/MOTOR_001/key').set('Authorization', await client('motors'))).status).toBe(403);
    const old = key;
    const reissued = await request(app.getHttpServer()).post('/api/v1/motor-loggers/MOTOR_001/key').set('Authorization', master());
    expect((await post(batch(1001, 1002), old)).status).toBe(401);
    expect((await post(batch(1001, 1002), reissued.body.key)).status).toBe(200);
    expect(await owner.query(`SELECT "key_hash" FROM "motor_logger_key"`)).not.toContainEqual({ key_hash: reissued.body.key });
  });

  it('a simulated overload, sent the way the device sends it, reaches telemetry above 1.2 × rated current', async () => {
    await assign();
    const end = Math.floor(Date.now() / 1000);
    const records = simulate('overload', 600, end, end - 700);
    for (const b of batches('MOTOR_001', records, 700)) {
      expect((await post(b)).text).toBe(`{"status":"ok","ack_seq":${b.last_seq}}`);
    }
    const [{ peak }] = await owner.query(
      `SELECT max("value")::float8 AS peak FROM "telemetry_reading" WHERE "imei" = 'MOTOR_001' AND "signal" = 'motor_current_max'`,
    );
    expect(peak).toBeGreaterThan(1.2 * MINI_1HP.ratedCurrent);
  });

  /** The logger claimed onto a machine of the account, with or without its ratings. */
  const fitted = async (ratings: boolean) => {
    await owner.query(`DELETE FROM "equipment_profile" WHERE "external_id" = 'PUMP-1'`);
    await owner.query(`TRUNCATE "tenant_parameter"`);
    const [{ id }] = await owner.query(
      `INSERT INTO "equipment_profile" ("tenant_id", "source_system", "external_id", "tier", "readiness")
       VALUES ('motors', 'ta-2.0', 'PUMP-1', 'basic', '{}') RETURNING "id"`);
    await owner.query(`INSERT INTO "device_inventory" ("imei", "tenant_id", "state", "equipment_external_id")
       VALUES ('MOTOR_001', 'motors', 'assigned', 'PUMP-1')`);
    if (ratings) {
      for (const [name, value, unit] of [['rated_current', 5.5, 'A'], ['rated_voltage', 220, 'V']] as const) {
        await owner.query(
          `INSERT INTO "tenant_parameter" ("tenant_id", "scope", "scope_ref", "name", "value", "unit", "effective_from", "created_by")
           VALUES ('motors', 'equipment', $1, $2, $3::jsonb, $4, '2026-01-01', 'test')`, [id, name, JSON.stringify(value), unit]);
      }
    }
  };
  const series = (signal: string) => owner.query(
    `SELECT "value"::float8 AS "v" FROM "telemetry_reading" WHERE "imei" = 'MOTOR_001' AND "signal" = $1 ORDER BY "source_timestamp"`, [signal],
  ).then((rows: { v: number }[]) => rows.map((r) => r.v));

  it('counts starts per second before averaging, and says when the motor ran (U6, U9)', async () => {
    await fitted(true);
    const end = Math.floor(Date.now() / 1000);
    // Cycling: 90 s on, 30 s off. Five minutes hold two restarts, at 120 s and 240 s.
    for (const b of batches('MOTOR_001', simulate('cycling', 300, end, end - 400), 400)) await post(b);
    expect((await series('motor_starts')).reduce((a, b) => a + b, 0)).toBe(2);
    expect(await series('engine_running_status')).toEqual(expect.arrayContaining([1]));
    expect((await series('engine_running_status')).every((v) => v === 0 || v === 1)).toBe(true);
  });

  it('with no ratings for the machine, running is unknown: nothing written, no floor guessed', async () => {
    await fitted(false);
    const end = Math.floor(Date.now() / 1000);
    for (const b of batches('MOTOR_001', simulate('cycling', 300, end, end - 400), 400)) await post(b);
    expect(await series('engine_running_status')).toEqual([]);
    expect(await series('motor_starts')).toEqual([]);
    expect((await series('motor_current')).length).toBeGreaterThan(0);
  });

  it('logger health: the growth of lost and dropped records since the last upload (U10)', async () => {
    await assign();
    await post(batch(1001, 1002, { lost_total: 3, dropped_total: 0 }));
    await post(batch(1003, 1004, { lost_total: 8, dropped_total: 0 }));
    await post(batch(1003, 1004, { lost_total: 8, dropped_total: 0 })); // a retry: nothing new lost
    expect((await series('logger_records_lost')).reduce((a, b) => a + b, 0)).toBe(5);
    expect((await series('logger_records_dropped')).reduce((a, b) => a + b, 0)).toBe(0);
  });

  it('undoes its own migration, and the chain re-applies', async () => {
    await undoMigrationNamed(owner, MIGRATION);
    expect(await owner.query(`SELECT 1 FROM information_schema.tables WHERE table_name LIKE 'motor_%'`)).toHaveLength(0);
    await owner.runMigrations({ transaction: 'all' });
    expect(await owner.query(`SELECT 1 FROM information_schema.tables WHERE table_name LIKE 'motor_%'`)).toHaveLength(3);
  });
});
