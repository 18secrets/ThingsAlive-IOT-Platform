import { DataSource } from 'typeorm';
import { MotorIngestService } from '../src/motor-ingest/motor-ingest.service';
import { batches, MAX_BODY_BYTES, simulate } from '../scripts/motor-logger-sim';
import { createAppDataSource, createTestDataSource, describeDb, undoMigrationNamed } from './db';

const MIGRATION = 'MotorLoggerSensors1764200000000';

/** The receiver's added statements, verbatim from motor_logger_http_server.py. */
const RECEIVER_ALTER = `
  ALTER TABLE motor_sensor_records
      ADD COLUMN IF NOT EXISTS ambient_c       NUMERIC(6,1),
      ADD COLUMN IF NOT EXISTS vibration_mm_s  NUMERIC(7,2),
      ADD COLUMN IF NOT EXISTS load_pct        NUMERIC(6,1),
      ADD COLUMN IF NOT EXISTS water_air_gap   NUMERIC(10,2);`;
const RECEIVER_INSERT = `
  INSERT INTO motor_sensor_records
      (device_id, seq, device_ts, voltage_v, current_a,
       power_factor, temperature_c, rpm, batch_id, received_at,
       ambient_c, vibration_mm_s, load_pct, water_air_gap)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
  ON CONFLICT (device_id, seq) DO NOTHING`;

/**
 * The logger's added sensors (ambient, vibration, load, water/air gap): carried from the
 * payload to one-minute signals, and absent — not zero — on a logger without them.
 */
describe('motor logger sensors: the simulator', () => {
  const END = 1_794_200_000;

  it('sends the sensors when asked, and still keeps every batch inside the receiver\'s 8 KiB', () => {
    const records = simulate('normal', 600, END, END - 700, undefined, true);
    expect(records[0]).toEqual(expect.objectContaining({ ambient_c: expect.any(Number), vibration_mm_s: expect.any(Number), load_pct: expect.any(Number) }));
    const list = batches('MOTOR_001', records, 0);
    expect(list.every((b) => JSON.stringify(b).length <= MAX_BODY_BYTES)).toBe(true);
    expect(list.reduce((n, b) => n + b.count, 0)).toBe(600);
    // ~190 bytes a record: fewer than the 50 a sensorless batch carries.
    expect(Math.max(...list.map((b) => b.count))).toBeLessThan(50);
  });

  it('a dry-running pump rattles past ISO zone C (2.8 mm/s); a healthy one stays near 1.1', () => {
    const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const vib = (s: 'normal' | 'dry-run') => simulate(s, 600, END, END - 700, undefined, true).slice(-100).map((r) => r.vibration_mm_s!);
    expect(avg(vib('normal'))).toBeCloseTo(1.1, 0);
    expect(avg(vib('dry-run'))).toBeGreaterThan(2.8);
  });

  it('without the flag, records are exactly what the firmware sends today', () => {
    const [r] = simulate('normal', 1, END, END - 10);
    expect(Object.keys(r).sort()).toEqual(['current', 'power_factor', 'rpm', 'seq', 'temperature', 'timestamp', 'voltage']);
  });
});

describeDb('motor logger sensors: from the receiver to telemetry', () => {
  let owner: DataSource;
  let ds: DataSource;
  let motors: MotorIngestService;
  const NOW = new Date('2026-11-09T12:00:00.000Z');
  const END = Math.floor(NOW.getTime() / 1000);

  const store = async (records: ReturnType<typeof simulate>) => {
    for (const b of batches('MOTOR_001', records, 0)) {
      for (const r of b.records) {
        await owner.query(RECEIVER_INSERT, [b.device_id, r.seq, r.timestamp, r.voltage, r.current, r.power_factor, r.temperature, r.rpm,
          b.batch_id, new Date((b.records[b.records.length - 1].seq + 1) * 1000),
          r.ambient_c ?? null, r.vibration_mm_s ?? null, r.load_pct ?? null, null]);
      }
      await owner.query(
        `INSERT INTO motor_upload_log (device_id, batch_id, first_seq, last_seq, record_count, stored_count, boot, lost_total, dropped_total, received_at)
         VALUES ($1, $2, $3, $4, $5, $5, 1, 0, 0, $6)`,
        [b.device_id, b.batch_id, b.first_seq, b.last_seq, b.count, new Date((b.last_seq + 1) * 1000)]);
    }
  };
  const signals = () => owner.query(
    `SELECT signal, count(*)::int AS n, avg(value)::float8 AS v FROM telemetry_reading WHERE imei = 'MOTOR_001' GROUP BY 1 ORDER BY 1`,
  ).then((rows: { signal: string; n: number; v: number }[]) => new Map(rows.map((r) => [r.signal, r])));

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

  it('ambient, vibration (mean and peak) and load become one-minute signals', async () => {
    await store(simulate('normal', 180, END, END - 300, undefined, true));
    await motors.processPending(NOW);
    const s = await signals();
    // Three minutes of seconds touch three or four clock minutes, by where they start.
    expect(s.get('ambient_temperature')?.n).toBeGreaterThanOrEqual(3);
    expect(s.get('ambient_temperature')!.n).toBe(s.get('supply_voltage')!.n);
    expect(s.get('vibration_velocity')?.v).toBeCloseTo(1.1, 0);
    expect(s.get('vibration_velocity_max')!.v).toBeGreaterThanOrEqual(s.get('vibration_velocity')!.v);
    expect(s.get('device_load_pct')?.v).toBeCloseTo(85, -1);
    const [{ unit }] = await owner.query(`SELECT unit FROM telemetry_reading WHERE signal = 'vibration_velocity' LIMIT 1`);
    expect(unit).toBe('mm/s');
  });

  it('a logger without the sensors writes none of their signals — no zero standing in for a reading', async () => {
    await store(simulate('normal', 120, END, END - 300));
    await motors.processPending(NOW);
    const s = await signals();
    expect(s.has('supply_voltage')).toBe(true);
    for (const name of ['ambient_temperature', 'vibration_velocity', 'vibration_velocity_max', 'device_load_pct', 'water_air_gap']) {
      expect(s.has(name)).toBe(false);
    }
  });

  it('undoes its own migration, and the chain re-applies', async () => {
    const has = async () => (await owner.query(
      `SELECT 1 FROM information_schema.columns WHERE table_name = 'motor_sensor_records' AND column_name = 'vibration_mm_s'`)).length;
    await undoMigrationNamed(owner, MIGRATION);
    expect(await has()).toBe(0);
    await owner.runMigrations({ transaction: 'all' });
    expect(await has()).toBe(1);
  });
});
