import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { createApp } from '../src/main';
import { MotorIngestService } from '../src/motor-ingest/motor-ingest.service';
import { batches, MINI_1HP, SCENARIOS, simulate, SimRecord } from '../scripts/motor-logger-sim';
import { createAppDataSource, createTestDataSource, describeDb, undoMigrationNamed } from './db';

const MIGRATION = 'MotorLoggerIngest1763900000000';
const SECRET = 'test-secret-motor-ingest';
const ISSUER = 'things-alive-motor-ingest-test';
const MAX_BODY_BYTES = 8192;

/**
 * The receiver's own SQL, verbatim from motor_logger_http_server.py (_ensure_schema and
 * _store_to_db). The receiver writes into this database; if these statements work against
 * 2.0's migration, the receiver does.
 */
const RECEIVER_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS motor_sensor_records (
      device_id       VARCHAR(64)     NOT NULL,
      seq             BIGINT          NOT NULL,
      device_ts       BIGINT          NOT NULL,
      voltage_v       NUMERIC(7,1)    NOT NULL,
      current_a       NUMERIC(7,2)    NOT NULL,
      power_factor    NUMERIC(4,2)    NOT NULL,
      temperature_c   NUMERIC(7,1)    NOT NULL,
      rpm             INTEGER         NOT NULL,
      batch_id        VARCHAR(128)    NOT NULL,
      received_at     TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
      PRIMARY KEY (device_id, seq)
  );`,
  `CREATE TABLE IF NOT EXISTS motor_upload_log (
      id              BIGSERIAL       PRIMARY KEY,
      device_id       VARCHAR(64)     NOT NULL,
      batch_id        VARCHAR(128)    NOT NULL,
      first_seq       BIGINT          NOT NULL,
      last_seq        BIGINT          NOT NULL,
      record_count    INTEGER         NOT NULL,
      stored_count    INTEGER         NOT NULL,
      boot            BIGINT,
      lost_total      BIGINT,
      dropped_total   BIGINT,
      received_at     TIMESTAMPTZ     NOT NULL DEFAULT NOW()
  );`,
  `CREATE INDEX IF NOT EXISTS idx_motor_records_device_received
      ON motor_sensor_records (device_id, received_at);`,
  `CREATE INDEX IF NOT EXISTS idx_motor_upload_log_device
      ON motor_upload_log (device_id, received_at);`,
];

type Batch = ReturnType<typeof batches>[number];

/** One POST as the receiver stores it: each record ON CONFLICT DO NOTHING, then the log row, one transaction. */
const receive = (ds: DataSource, b: Batch, receivedAt: Date) => ds.transaction(async (m) => {
  let stored = 0;
  for (const rec of b.records) {
    const r = await m.query(
      `INSERT INTO motor_sensor_records
          (device_id, seq, device_ts, voltage_v, current_a,
           power_factor, temperature_c, rpm, batch_id, received_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (device_id, seq) DO NOTHING RETURNING seq`,
      [b.device_id, rec.seq, rec.timestamp, rec.voltage, rec.current, rec.power_factor, rec.temperature, rec.rpm, b.batch_id, receivedAt],
    );
    stored += r.length;
  }
  await m.query(
    `INSERT INTO motor_upload_log
        (device_id, batch_id, first_seq, last_seq,
         record_count, stored_count, boot, lost_total, dropped_total, received_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [b.device_id, b.batch_id, b.first_seq, b.last_seq, b.records.length, stored, b.boot, b.lost_total, b.dropped_total, receivedAt],
  );
});

/**
 * The simulator (`scripts/motor-logger-sim.ts`) stands in for the real logger until one
 * is wired, so it is held to the logger contract, and each scenario to the signature the
 * RCA matrix says it leaves.
 */
describe('motor logger: the simulator', () => {
  const END = 1_794_200_000;
  const BOOT = END - 3600;
  const run = (scenario: (typeof SCENARIOS)[number], seconds = 600) => simulate(scenario, seconds, END, BOOT);
  const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

  it('every scenario sends batches the contract allows: ≤ 50 records, ≤ 8 KiB, ascending seq inside the range', () => {
    for (const scenario of SCENARIOS) {
      for (const b of batches('MOTOR_001', run(scenario), END - BOOT)) {
        expect(b.records.length).toBeLessThanOrEqual(50);
        expect(b.count).toBe(b.records.length);
        expect(Buffer.byteLength(JSON.stringify(b))).toBeLessThanOrEqual(MAX_BODY_BYTES);
        expect(b.records.every((r: SimRecord, i: number) => r.seq >= b.first_seq && r.seq <= b.last_seq
          && (i === 0 || r.seq > b.records[i - 1].seq))).toBe(true);
        expect(b.records.every((r: SimRecord) => r.power_factor >= 0 && r.power_factor <= 1 && r.voltage >= 0 && r.current >= 0)).toBe(true);
      }
    }
  });

  it('normal runs near 0.85 of rated current at ~230 V, F4 speed just under synchronous', () => {
    const r = run('normal');
    expect(avg(r.map((x) => x.current)) / MINI_1HP.ratedCurrent).toBeCloseTo(0.85, 1);
    expect(avg(r.map((x) => x.voltage))).toBeCloseTo(230, 0);
    expect(Math.max(...r.map((x) => x.rpm))).toBeLessThan(3000);
  });

  it('overload ends above 1.2 × rated current; low voltage below the 180 V fault line, drawing more current', () => {
    expect(avg(run('overload').slice(-30).map((x) => x.current))).toBeGreaterThan(1.2 * MINI_1HP.ratedCurrent);
    const low = run('low-voltage');
    expect(avg(low.slice(-30).map((x) => x.voltage))).toBeLessThan(180);
    expect(avg(low.slice(-30).map((x) => x.current))).toBeGreaterThan(avg(low.slice(0, 30).map((x) => x.current)));
    expect(avg(run('high-voltage').slice(-30).map((x) => x.voltage))).toBeGreaterThan(260);
  });

  it('dry run: current drops about 30% and power factor falls (RCA 1)', () => {
    const r = run('dry-run', 900);
    expect(avg(r.slice(-200).map((x) => x.current)) / avg(r.slice(0, 200).map((x) => x.current))).toBeLessThan(0.75);
    expect(avg(r.slice(-200).map((x) => x.power_factor))).toBeLessThan(avg(r.slice(0, 200).map((x) => x.power_factor)));
  });

  it('cycling stops and restarts every two minutes (RCA 10): zero current and speed while off', () => {
    const r = run('cycling', 600);
    expect(r.filter((x, i) => i > 0 && r[i - 1].current === 0 && x.current > 0).length).toBeGreaterThanOrEqual(4);
    expect(r.filter((x) => x.current === 0).every((x) => x.rpm === 0)).toBe(true);
  });
});

describeDb('motor logger: from what the receiver stores to telemetry', () => {
  let owner: DataSource;
  let ds: DataSource;
  let motors: MotorIngestService;

  const NOW = new Date('2026-11-09T12:00:00.000Z');
  const END = Math.floor(NOW.getTime() / 1000);
  const count = async (sql: string) => (await owner.query(sql))[0].n as number;
  const series = (signal: string) => owner.query(
    `SELECT "value"::float8 AS "v" FROM "telemetry_reading" WHERE "imei" = 'MOTOR_001' AND "signal" = $1 ORDER BY "source_timestamp"`, [signal],
  ).then((rows: { v: number }[]) => rows.map((r) => r.v));

  /** A simulated stretch, sent the way the device sends it, stored the way the receiver stores it. */
  const sendAndStore = async (scenario: (typeof SCENARIOS)[number], seconds: number, endUnix = END, lostTotal = 0) => {
    const records = simulate(scenario, seconds, endUnix, endUnix - seconds - 60);
    for (const b of batches('MOTOR_001', records, 0, 50, lostTotal)) {
      // Each batch reaches the receiver a second after its newest reading.
      await receive(owner, b, new Date((b.records[b.records.length - 1].seq + 1) * 1000));
    }
  };

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    ds = await createAppDataSource();
    motors = new MotorIngestService(ds);
  }, 30_000);

  afterAll(async () => { await ds?.destroy(); await owner?.destroy(); });

  beforeEach(async () => {
    await owner.query(`TRUNCATE "motor_sensor_records", "motor_upload_log", "telemetry_reading", "device_inventory", "tenant_parameter" CASCADE`);
    await owner.query(`DELETE FROM "equipment_profile"`);
  });

  const assign = (machine: string | null = null) => owner.query(
    `INSERT INTO "device_inventory" ("imei", "tenant_id", "state", "equipment_external_id") VALUES ('MOTOR_001', 'motors', 'assigned', $1)`, [machine],
  );

  /** The logger claimed onto a machine, with or without its ratings. */
  const fitted = async (ratings: boolean) => {
    const [{ id }] = await owner.query(
      `INSERT INTO "equipment_profile" ("tenant_id", "source_system", "external_id", "tier", "readiness")
       VALUES ('motors', 'ta-2.0', 'PUMP-1', 'basic', '{}') RETURNING "id"`);
    await assign('PUMP-1');
    if (!ratings) return;
    for (const [name, value, unit] of [['rated_current', 5.5, 'A'], ['rated_voltage', 220, 'V']] as const) {
      await owner.query(
        `INSERT INTO "tenant_parameter" ("tenant_id", "scope", "scope_ref", "name", "value", "unit", "effective_from", "created_by")
         VALUES ('motors', 'equipment', $1, $2, $3::jsonb, $4, '2026-01-01', 'test')`, [id, name, JSON.stringify(value), unit]);
    }
  };

  it('the receiver\'s own CREATE ... IF NOT EXISTS finds the migration\'s tables and indexes: nothing new, nothing refused', async () => {
    const before = await count(`SELECT count(*)::int AS n FROM pg_indexes WHERE tablename IN ('motor_sensor_records', 'motor_upload_log')`);
    for (const sql of RECEIVER_SCHEMA) await owner.query(sql);
    expect(await count(`SELECT count(*)::int AS n FROM pg_indexes WHERE tablename IN ('motor_sensor_records', 'motor_upload_log')`)).toBe(before);
  });

  it('the receiver\'s inserts work unchanged, and a resent range is stored once', async () => {
    const [b] = batches('MOTOR_001', simulate('normal', 50, END, END - 100), 0);
    await receive(owner, b, NOW);
    await receive(owner, b, NOW);
    expect(await count(`SELECT count(*)::int AS n FROM motor_sensor_records`)).toBe(50);
    expect(await owner.query(`SELECT stored_count FROM motor_upload_log ORDER BY id`)).toEqual([{ stored_count: 50 }, { stored_count: 0 }]);
  });

  it('places each reading in time: the newest at the batch\'s arrival, the rest by the device clock, marked approximate', async () => {
    await sendAndStore('normal', 50);
    const summary = await motors.processPending(NOW);
    expect(summary.readings).toBe(50);
    const rows = await owner.query(`SELECT seq::float8 AS seq, reading_at, time_basis FROM motor_sensor_records ORDER BY seq`);
    expect(rows.every((r: { time_basis: string }) => r.time_basis === 'approximate')).toBe(true);
    const newest = rows[rows.length - 1];
    expect(new Date(newest.reading_at).getTime()).toBe((newest.seq + 1) * 1000);
    expect(new Date(newest.reading_at).getTime() - new Date(rows[0].reading_at).getTime()).toBe(49_000);
  });

  it('a burst of batches arriving together spreads back over the time it covers, not into the moment it arrived', async () => {
    // A logger flushing ten minutes after an outage: twelve batches, all in the same second.
    const records = simulate('normal', 600, END, END - 700);
    for (const b of batches('MOTOR_001', records, 0)) await receive(owner, b, NOW);
    await motors.processPending(NOW);
    const [span] = await owner.query(
      `SELECT extract(epoch FROM max(reading_at) - min(reading_at))::int AS s, count(DISTINCT date_trunc('minute', reading_at))::int AS minutes
         FROM motor_sensor_records`);
    expect(span.s).toBe(599);
    expect(span.minutes).toBeGreaterThanOrEqual(10);
  });

  it('a reboot restarts the device clock: each boot is anchored on its own', async () => {
    const before = batches('MOTOR_001', simulate('normal', 50, END - 600, END - 700), 0)[0];
    const after = batches('MOTOR_001', simulate('normal', 50, END, END - 60), 0)[0];
    await receive(owner, { ...before, boot: 3 }, NOW);
    await receive(owner, { ...after, boot: 4 }, NOW);
    await motors.processPending(NOW);
    // Boot 4's clock reads far below boot 3's; anchored together, boot 3 would land in the future.
    const [late] = await owner.query(`SELECT max(reading_at) AS at FROM motor_sensor_records`);
    expect(new Date(late.at).getTime()).toBeLessThanOrEqual(NOW.getTime());
  });

  it('an assigned logger\'s readings become one-minute telemetry in its account; an unassigned one\'s do not', async () => {
    await sendAndStore('normal', 120);
    await motors.processPending(NOW);
    expect(await count(`SELECT count(*)::int AS n FROM telemetry_reading`)).toBe(0);

    await owner.query(`TRUNCATE "motor_sensor_records", "motor_upload_log"`);
    await assign();
    await sendAndStore('normal', 120);
    await motors.processPending(NOW);
    const signals = (await owner.query(`SELECT DISTINCT signal, tenant_id FROM telemetry_reading ORDER BY signal`));
    expect(signals.map((r: { signal: string }) => r.signal)).toEqual(expect.arrayContaining(
      ['input_power', 'motor_current', 'motor_current_max', 'supply_voltage', 'supply_voltage_min', 'supply_voltage_max']));
    expect(signals.every((r: { tenant_id: string }) => r.tenant_id === 'motors')).toBe(true);
    expect((await series('motor_current')).length).toBeLessThanOrEqual(3); // two minutes, not 120 rows
  });

  it('a pass is idempotent, and two at once both settle with the work done once', async () => {
    await assign();
    await sendAndStore('normal', 200);
    const results = await Promise.allSettled([motors.processExclusively(NOW), motors.processExclusively(NOW)]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    expect(await count(`SELECT count(*)::int AS n FROM motor_sensor_records WHERE reading_at IS NULL`)).toBe(0);
    const before = await series('motor_current');
    expect(await motors.processPending(NOW)).toMatchObject({ readings: 0, uploads: 0 });
    expect(await series('motor_current')).toEqual(before);
  });

  it('a minute split across two passes is recomputed whole, not left as its first half', async () => {
    await assign();
    await sendAndStore('overload', 30, END - 30);
    await motors.processPending(NOW);
    await sendAndStore('overload', 30, END);
    await motors.processPending(NOW);
    const [check] = await owner.query(
      `SELECT t.value::float8 AS v, (SELECT avg(current_a)::float8 FROM motor_sensor_records r
          WHERE date_trunc('minute', r.reading_at) = t.source_timestamp) AS expected
         FROM telemetry_reading t WHERE t.signal = 'motor_current'
        ORDER BY (SELECT count(*) FROM motor_sensor_records r WHERE date_trunc('minute', r.reading_at) = t.source_timestamp) DESC LIMIT 1`);
    expect(check.v).toBeCloseTo(check.expected, 6);
  });

  it('counts starts per second before averaging, says when the motor ran and for what share (U6, U9, U2)', async () => {
    await fitted(true);
    await sendAndStore('cycling', 300);
    await motors.processPending(NOW);
    expect((await series('motor_starts')).reduce((a, b) => a + b, 0)).toBe(2);
    expect((await series('engine_running_status')).every((v) => v === 0 || v === 1)).toBe(true);
    const share = await series('motor_running_share');
    const avgShare = share.reduce((a, b) => a + b, 0) / share.length;
    expect(avgShare).toBeGreaterThan(0.65);
    expect(avgShare).toBeLessThan(0.85);
    const fluct = await series('current_fluctuation_pct');
    expect(fluct.length).toBeGreaterThan(0);
    expect(fluct.every((f) => f > 0 && f < 5)).toBe(true);
  });

  it('with no ratings for the machine, running is unknown: nothing written, no floor guessed', async () => {
    await fitted(false);
    await sendAndStore('cycling', 300);
    await motors.processPending(NOW);
    expect(await series('engine_running_status')).toEqual([]);
    expect(await series('motor_starts')).toEqual([]);
    expect((await series('motor_current')).length).toBeGreaterThan(0);
  });

  it('logger health: the growth of lost and dropped records since the previous upload, a retry adding nothing (U10)', async () => {
    await assign();
    const [first, second] = batches('MOTOR_001', simulate('normal', 100, END, END - 200), 0);
    await receive(owner, { ...first, lost_total: 3 }, new Date(NOW.getTime() - 120_000));
    await receive(owner, { ...second, lost_total: 8 }, new Date(NOW.getTime() - 60_000));
    await receive(owner, { ...second, lost_total: 8 }, NOW);
    await motors.processPending(NOW);
    expect((await series('logger_records_lost')).reduce((a, b) => a + b, 0)).toBe(5);
    expect(await count(`SELECT count(*)::int AS n FROM motor_upload_log WHERE processed_at IS NULL`)).toBe(0);
  });

  it('a simulated overload, stored by the receiver, reaches telemetry above 1.2 × rated current', async () => {
    await assign();
    await sendAndStore('overload', 600);
    await motors.processPending(NOW);
    const peak = Math.max(...await series('motor_current_max'));
    expect(peak).toBeGreaterThan(1.2 * MINI_1HP.ratedCurrent);
  });

  it('undoes its own migration, and the chain re-applies', async () => {
    await undoMigrationNamed(owner, MIGRATION);
    expect(await owner.query(`SELECT 1 FROM information_schema.tables WHERE table_name LIKE 'motor_%'`)).toHaveLength(0);
    await owner.runMigrations({ transaction: 'all' });
    expect(await owner.query(`SELECT 1 FROM information_schema.tables WHERE table_name LIKE 'motor_%'`)).toHaveLength(2);
  });
});

describeDb('motor logger: GET /api/motor/recent', () => {
  let app: INestApplication;
  let owner: DataSource;

  const client = async (tenant: string) => `Bearer ${await app.get(JwtService).signAsync(
    { sub: '00000000-0000-4000-8000-0000000000e1', client_id: tenant, roles: ['super admin'] }, { secret: SECRET, issuer: ISSUER },
  )}`;

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

  it('an account sees its own loggers only; another account sees none of them; anonymous is refused', async () => {
    await owner.query(`INSERT INTO "device_inventory" ("imei", "tenant_id", "state") VALUES ('MOTOR_001', 'motors', 'assigned')`);
    const [b] = batches('MOTOR_001', simulate('normal', 3, 1_794_200_000, 1_794_199_000), 0);
    await receive(owner, b, new Date());
    const mine = await request(app.getHttpServer()).get('/api/motor/recent?device_id=MOTOR_001&limit=2').set('Authorization', await client('motors'));
    expect(mine.status).toBe(200);
    expect(mine.body.records).toHaveLength(2);
    expect(mine.body.devices).toEqual([expect.objectContaining({ device_id: 'MOTOR_001', total_records: 3 })]);
    const theirs = await request(app.getHttpServer()).get('/api/motor/recent').set('Authorization', await client('acme'));
    expect(theirs.body).toEqual({ records: [], devices: [], uploads: [] });
    expect((await request(app.getHttpServer()).get('/api/motor/recent?device_id=MOTOR_001').set('Authorization', await client('acme'))).status).toBe(404);
    expect((await request(app.getHttpServer()).get('/api/motor/recent')).status).toBe(401);
  });
});
