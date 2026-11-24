import { DataSource } from 'typeorm';
import { MotorIngestService } from '../src/motor-ingest/motor-ingest.service';
import { createAppDataSource, createTestDataSource, describeDb, undoMigrationNamed } from './db';

const MIGRATION = 'MotorFirmwareScores1766100000000';

/** The receiver's ALTER, verbatim from motor_logger_http_server.py after this change. */
const RECEIVER_ALTER = `
  ALTER TABLE motor_sensor_records
      ADD COLUMN IF NOT EXISTS ambient_c       NUMERIC(6,1),
      ADD COLUMN IF NOT EXISTS vibration_mm_s  NUMERIC(7,2),
      ADD COLUMN IF NOT EXISTS load_pct        NUMERIC(6,1),
      ADD COLUMN IF NOT EXISTS water_air_gap   NUMERIC(10,2),
      ADD COLUMN IF NOT EXISTS load_loss       NUMERIC(10,2),
      ADD COLUMN IF NOT EXISTS vibration_score NUMERIC(6,1),
      ADD COLUMN IF NOT EXISTS air_gap_score   NUMERIC(6,1);`;

/**
 * The firmware's vibration, air_gap and load_loss are 0-100 scores (Motor Monitor
 * integration spec, 24 Nov 2026). They used to land in the vibration-velocity column and
 * reach the library's mm/s zones; a score of 40 read as 40 mm/s is a pump the health
 * score writes off. They are score signals now, and a velocity is only ever a velocity.
 */
describeDb('motor firmware scores: from the receiver to telemetry', () => {
  let owner: DataSource;
  let ds: DataSource;
  let motors: MotorIngestService;
  const NOW = new Date('2026-11-24T12:00:00.000Z');
  // The newest reading is placed at its upload's arrival: 11:59:59, so the 120 seconds
  // below fill 11:58 and 11:59 exactly.
  const RECEIVED = new Date('2026-11-24T11:59:59.000Z');

  /**
   * Two minutes of one logger. 11:58 the pump is stopped throughout; 11:59 it is stopped
   * for thirty seconds and runs for thirty. The firmware holds every score at 0 while
   * stopped, as the spec says it does.
   */
  const store = async () => {
    for (let i = 0; i < 120; i += 1) {
      const running = i >= 90;
      await owner.query(
        `INSERT INTO motor_sensor_records (device_id, seq, device_ts, voltage_v, current_a, power_factor, temperature_c, rpm,
                                           batch_id, received_at, load_loss, vibration_score, air_gap_score)
         VALUES ('MOTOR_001', $1, $2, 240.0, $3, $4, 40.0, $5, 'MOTOR_001-1000-1119', $6, $7, $8, $9)`,
        [1000 + i, 1000 + i, running ? 0.11 : 0, running ? 0.22 : 0, running ? 2180 : 0, RECEIVED,
          running ? 20 : 0, running ? 40 : 0, running ? 32 : 0]);
    }
    await owner.query(
      `INSERT INTO motor_upload_log (device_id, batch_id, first_seq, last_seq, record_count, stored_count, boot, lost_total, dropped_total, received_at)
       VALUES ('MOTOR_001', 'MOTOR_001-1000-1119', 1000, 1119, 120, 120, 7, 0, 0, $1)`, [RECEIVED]);
  };
  const minuteOf = (signal: string) => owner.query(
    `SELECT to_char(source_timestamp AT TIME ZONE 'UTC', 'HH24:MI') AS minute, value::float8 AS value, unit
       FROM telemetry_reading WHERE imei = 'MOTOR_001' AND signal = $1 ORDER BY source_timestamp`, [signal]);

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
    await owner.query(`INSERT INTO "device_inventory" ("imei", "tenant_id", "state") VALUES ('MOTOR_001', 'motors', 'assigned')`);
  });

  it('the receiver\'s own ALTER finds the migration\'s columns: nothing changes, nothing refused', async () => {
    const cols = () => owner.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'motor_sensor_records' ORDER BY 1`);
    const before = await cols();
    await owner.query(RECEIVER_ALTER);
    expect(await cols()).toEqual(before);
  });

  it('each score is the mean of the running seconds, not of the minute: half a minute running is not half the score', async () => {
    await store();
    await motors.processPending(NOW);
    expect(await minuteOf('vibration_score')).toEqual([{ minute: '11:59', value: 40, unit: 'dimensionless' }]);
    expect(await minuteOf('vibration_score_max')).toEqual([{ minute: '11:59', value: 40, unit: 'dimensionless' }]);
    expect(await minuteOf('air_gap_score')).toEqual([{ minute: '11:59', value: 32, unit: 'dimensionless' }]);
    expect(await minuteOf('load_loss_score')).toEqual([{ minute: '11:59', value: 20, unit: 'dimensionless' }]);
  });

  it('a minute the pump never ran writes no score at all, though its other signals are there', async () => {
    await store();
    await motors.processPending(NOW);
    expect((await minuteOf('supply_voltage')).map((r: { minute: string }) => r.minute)).toEqual(['11:58', '11:59']);
    for (const signal of ['vibration_score', 'air_gap_score', 'load_loss_score']) {
      expect((await minuteOf(signal)).map((r: { minute: string }) => r.minute)).not.toContain('11:58');
    }
  });

  it('a score never becomes a vibration velocity or an air-gap reading', async () => {
    await store();
    await motors.processPending(NOW);
    for (const signal of ['vibration_velocity', 'vibration_velocity_max', 'water_air_gap']) {
      expect(await minuteOf(signal)).toEqual([]);
    }
  });

  it('undoes its own migration, and the chain re-applies', async () => {
    const has = async () => (await owner.query(
      `SELECT 1 FROM information_schema.columns WHERE table_name = 'motor_sensor_records' AND column_name = 'vibration_score'`)).length;
    await undoMigrationNamed(owner, MIGRATION);
    expect(await has()).toBe(0);
    await owner.runMigrations({ transaction: 'all' });
    expect(await has()).toBe(1);
  });
});
