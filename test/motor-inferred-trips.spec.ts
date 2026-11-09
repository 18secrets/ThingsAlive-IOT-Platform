import { DataSource } from 'typeorm';
import { MotorIngestService } from '../src/motor-ingest/motor-ingest.service';
import { batches, simulate, SimRecord } from '../scripts/motor-logger-sim';
import { createAppDataSource, createTestDataSource, describeDb } from './db';

/**
 * Trips inferred from the readings around each stop (Crompton POC T7, "trip logged with
 * reason"; U6), until the logger reports its own. The reason comes from the seconds just
 * before the stop, by the relay's rules (F9) and the overload line (F8).
 */
describeDb('motor loggers: trips inferred from each stop', () => {
  let owner: DataSource;
  let ds: DataSource;
  let motors: MotorIngestService;
  const NOW = new Date('2026-11-09T12:00:00.000Z');
  const END = Math.floor(NOW.getTime() / 1000);

  /** Five minutes running as `scenario`, then `stop` applied to the last 60 seconds. */
  const runThenStop = (scenario: 'normal' | 'overload', stop: (r: SimRecord) => SimRecord, before: (r: SimRecord) => SimRecord = (r) => r) => {
    const records = simulate(scenario, 360, END, END - 400);
    return records.map((r, i) => (i >= 300 ? stop(r) : i >= 290 ? before(r) : r));
  };
  const store = async (records: SimRecord[]) => {
    for (const b of batches('MOTOR_001', records, 0)) {
      for (const r of b.records) {
        await owner.query(
          `INSERT INTO motor_sensor_records (device_id, seq, device_ts, voltage_v, current_a, power_factor, temperature_c, rpm, batch_id, received_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [b.device_id, r.seq, r.timestamp, r.voltage, r.current, r.power_factor, r.temperature, r.rpm, b.batch_id, new Date((b.last_seq + 1) * 1000)]);
      }
      await owner.query(
        `INSERT INTO motor_upload_log (device_id, batch_id, first_seq, last_seq, record_count, stored_count, boot, lost_total, dropped_total, received_at)
         VALUES ($1, $2, $3, $4, $5, $5, 1, 0, 0, $6)`, [b.device_id, b.batch_id, b.first_seq, b.last_seq, b.count, new Date((b.last_seq + 1) * 1000)]);
    }
  };
  const trips = async () => {
    const rows: { signal: string; n: number }[] = await owner.query(
      `SELECT signal, sum(value)::int AS n FROM telemetry_reading WHERE signal LIKE 'trip_%' GROUP BY 1 ORDER BY 1`);
    return Object.fromEntries(rows.map((r) => [r.signal, r.n]));
  };

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    await owner.query(`SELECT ensure_telemetry_partition('2026-11-01'::date)`);
    ds = await createAppDataSource();
    motors = new MotorIngestService(ds);
  }, 30_000);

  afterAll(async () => { await ds?.destroy(); await owner?.destroy(); });

  beforeEach(async () => {
    await owner.query(`TRUNCATE "motor_sensor_records", "motor_upload_log", "telemetry_reading", "device_inventory", "tenant_parameter" CASCADE`);
    await owner.query(`DELETE FROM "equipment_profile"`);
    const [{ id }] = await owner.query(
      `INSERT INTO "equipment_profile" ("tenant_id", "source_system", "external_id", "tier", "readiness")
       VALUES ('motors', 'ta-2.0', 'PUMP-1', 'basic', '{}') RETURNING "id"`);
    await owner.query(`INSERT INTO device_inventory (imei, tenant_id, state, equipment_external_id) VALUES ('MOTOR_001', 'motors', 'assigned', 'PUMP-1')`);
    for (const [name, value, unit] of [['rated_current', 5.5, 'A'], ['rated_voltage', 220, 'V'], ['insulation_temp_limit', 155, 'degC']] as const) {
      await owner.query(
        `INSERT INTO tenant_parameter (tenant_id, scope, scope_ref, name, value, unit, effective_from, created_by)
         VALUES ('motors', 'equipment', $1, $2, $3::jsonb, $4, '2026-01-01', 'test')`, [id, name, JSON.stringify(value), unit]);
    }
  });

  const off = (r: SimRecord): SimRecord => ({ ...r, current: 0, power_factor: 0, rpm: 0 });

  it('a stop right after current above 1.2 x rated is an overload trip', async () => {
    await store(runThenStop('normal', off, (r) => ({ ...r, current: 7.2 })));
    await motors.processPending(NOW);
    expect(await trips()).toEqual({ trip_overload: 1, trip_overtemp: 0, trip_supply: 0 });
  });

  it('a stop with the supply gone is supply loss, whatever the current did', async () => {
    await store(runThenStop('normal', (r) => ({ ...off(r), voltage: 0 }), (r) => ({ ...r, current: 7.2 })));
    await motors.processPending(NOW);
    expect(await trips()).toEqual({ trip_overload: 0, trip_overtemp: 0, trip_supply: 1 });
  });

  it('a stop within 25 C of the insulation limit is the relay\'s over-temperature trip', async () => {
    await store(runThenStop('normal', off, (r) => ({ ...r, temperature: 132 })));
    await motors.processPending(NOW);
    expect(await trips()).toEqual({ trip_overload: 0, trip_overtemp: 1, trip_supply: 0 });
  });

  it('an ordinary stop is no trip, and a motor that never stopped writes zeros, not nothing', async () => {
    await store(runThenStop('normal', off));
    await motors.processPending(NOW);
    expect(await trips()).toEqual({ trip_overload: 0, trip_overtemp: 0, trip_supply: 0 });
  });
});
