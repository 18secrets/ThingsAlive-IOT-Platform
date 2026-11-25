import { DataSource } from 'typeorm';
import { MotorIngestService } from '../src/motor-ingest/motor-ingest.service';
import { createAppDataSource, createTestDataSource, describeDb, undoMigrationNamed } from './db';

const MIGRATION = 'MotorDeviceFaults1766400000000';
const DEVICE = '862360079349887';

/** The receiver's ALTER, verbatim from motor_logger_http_server.py after this change. */
const RECEIVER_ALTER = `
  ALTER TABLE motor_sensor_records
      ADD COLUMN IF NOT EXISTS ambient_c       NUMERIC(6,1),
      ADD COLUMN IF NOT EXISTS vibration_mm_s  NUMERIC(7,2),
      ADD COLUMN IF NOT EXISTS load_pct        NUMERIC(6,1),
      ADD COLUMN IF NOT EXISTS water_air_gap   NUMERIC(10,2),
      ADD COLUMN IF NOT EXISTS load_loss       NUMERIC(10,2),
      ADD COLUMN IF NOT EXISTS vibration_score NUMERIC(6,1),
      ADD COLUMN IF NOT EXISTS air_gap_score   NUMERIC(6,1),
      ADD COLUMN IF NOT EXISTS device_faults   TEXT[];`;

/** The receiver's INSERT, verbatim, with psycopg2's %s as $n. */
const RECEIVER_INSERT = `
  INSERT INTO motor_sensor_records
      (device_id, seq, device_ts, voltage_v, current_a,
       power_factor, temperature_c, rpm, batch_id, received_at,
       ambient_c, vibration_mm_s, load_pct, water_air_gap, load_loss,
       vibration_score, air_gap_score, device_faults)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
  ON CONFLICT (device_id, seq) DO NOTHING`;

/**
 * The logger now reports the fault codes it saw, per record (Motor Logger server payload
 * spec, 25 Nov 2026). These tests prove the column the receiver writes exists wherever 2.0
 * has migrated, that "no field" and "no fault" stay distinguishable, and that the readings
 * beside a fault list still become telemetry.
 */
describeDb('motor device faults: the firmware\'s own codes, per record', () => {
  let owner: DataSource;
  let ds: DataSource;
  let motors: MotorIngestService;
  const RECEIVED = new Date('2026-11-25T11:59:59.000Z');
  const NOW = new Date('2026-11-25T12:00:00.000Z');

  /** Sixty running seconds, as the receiver stores them; `faults(i)` is that second's list. */
  const store = async (faults: (i: number) => string[] | null) => {
    for (let i = 0; i < 60; i += 1) {
      await owner.query(RECEIVER_INSERT, [
        DEVICE, 5000 + i, 5000 + i, 176.4, 3.42, 0.86, 66.8, 2805, `${DEVICE}-5000-5059`, RECEIVED,
        null, null, null, null, 3, 0, 1, faults(i),
      ]);
    }
    await owner.query(
      `INSERT INTO motor_upload_log (device_id, batch_id, first_seq, last_seq, record_count, stored_count, boot, lost_total, dropped_total, received_at)
       VALUES ($1, $2, 5000, 5059, 60, 60, 7, 0, 0, $3)`, [DEVICE, `${DEVICE}-5000-5059`, RECEIVED]);
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
    await owner.query(`TRUNCATE "motor_sensor_records", "motor_upload_log", "telemetry_reading", "device_inventory" CASCADE`);
    await owner.query(`INSERT INTO "device_inventory" ("imei", "tenant_id", "state") VALUES ($1, 'motors', 'assigned')`, [DEVICE]);
  });

  it('the receiver\'s own ALTER finds the migration\'s column: nothing changes, nothing refused', async () => {
    const cols = () => owner.query(
      `SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'motor_sensor_records' ORDER BY 1`);
    const before = await cols();
    expect(before).toContainEqual({ column_name: 'device_faults', data_type: 'ARRAY' });
    await owner.query(RECEIVER_ALTER);
    expect(await cols()).toEqual(before);
  });

  it('keeps a second\'s codes as sent, and tells "no fault" from "firmware never said"', async () => {
    await store((i) => (i === 0 ? ['P101', 'P702'] : i === 1 ? [] : null));
    const rows = await owner.query(
      `SELECT seq::int AS seq, device_faults FROM motor_sensor_records WHERE seq < 5003 ORDER BY seq`);
    expect(rows).toEqual([
      { seq: 5000, device_faults: ['P101', 'P702'] },
      { seq: 5001, device_faults: [] },
      { seq: 5002, device_faults: null },
    ]);
  });

  it('a fault\'s start and end read straight off consecutive records', async () => {
    // The spec: a code appears after its condition holds 3 s and clears on the first second without it.
    await store((i) => (i >= 10 && i < 20 ? ['P101'] : []));
    const [span] = await owner.query(
      `SELECT min(seq)::int AS first, max(seq)::int AS last FROM motor_sensor_records WHERE 'P101' = ANY(device_faults)`);
    expect(span).toEqual({ first: 5010, last: 5019 });
  });

  it('readings carrying a fault list still become telemetry', async () => {
    await store(() => ['P101']);
    await motors.processPending(NOW);
    const [{ n }] = await owner.query(
      `SELECT count(*)::int AS n FROM telemetry_reading WHERE imei = $1 AND signal = 'supply_voltage'`, [DEVICE]);
    expect(n).toBe(1);
  });

  it('undoes its own migration, and the chain re-applies', async () => {
    const has = async () => (await owner.query(
      `SELECT 1 FROM information_schema.columns WHERE table_name = 'motor_sensor_records' AND column_name = 'device_faults'`)).length;
    await undoMigrationNamed(owner, MIGRATION);
    expect(await has()).toBe(0);
    await owner.runMigrations({ transaction: 'all' });
    expect(await has()).toBe(1);
  });
});
