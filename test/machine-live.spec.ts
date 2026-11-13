import { DataSource } from 'typeorm';
import { LegacyTelemetryReader } from '../src/legacy/legacy-telemetry.reader';
import { readMachineLive } from '../src/page/live-machine';
import { withTenantId } from '../src/scope/tenant-session';
import { createAppDataSource, createTestDataSource, describeDb } from './db';

const SS = 'iot-platform-1';
const IMEI = '861000000000009';
const NOW = new Date('2026-11-13T12:00:00Z');
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);

jest.setTimeout(30_000);

/**
 * The Live view's data (13 Nov 2026): each signal's newest value and its age, whether the
 * machine is reporting, running, and where — from 2.0's own readings, and from 1.0 at the
 * moment it is asked when 1.0 has something newer. 1.0's measurement log stands in the
 * test database under its own column names, read through the owner connection; 2.0 runs
 * as the application role.
 */
describeDb('a machine as it is now (Live)', () => {
  let owner: DataSource;
  let ds: DataSource;
  let legacy: LegacyTelemetryReader;

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    await owner.query(`
      CREATE TABLE "device_sensor_measurement_logs" (
        "id" bigserial PRIMARY KEY, "device_sensor_measurement_id" bigint NOT NULL,
        "timestamp" timestamptz NOT NULL, "value" text)`);
    ds = await createAppDataSource();
    legacy = new LegacyTelemetryReader(ds, owner);
  }, 60_000);

  afterAll(async () => { await ds?.destroy(); await owner?.destroy(); });

  beforeEach(async () => {
    await owner.query(`TRUNCATE "telemetry_reading", "device_projection", "sensor_map_projection",
      "device_sensor_measurement_logs" RESTART IDENTITY CASCADE`);
    await owner.query(
      `INSERT INTO "device_projection" (source_system, external_id, tenant_id, checksum, imei, equipment_external_id)
       VALUES ($1, 'dev-EX-09', 'acme', 'x', $2, 'EX-09')`, [SS, IMEI],
    );
  });

  const reading = (signal: string, value: number, at: Date, unit: string | null = null) => owner.query(
    `INSERT INTO "telemetry_reading" (tenant_id, imei, signal, value, unit, source_timestamp, received_at, source)
     VALUES ('acme', $1, $2, $3, $4, $5, $5, 'test')`, [IMEI, signal, value, unit, at],
  );
  const live = (tenantId = 'acme', reader?: LegacyTelemetryReader) =>
    withTenantId(ds, tenantId, (m) => readMachineLive(m, reader, tenantId, { sourceSystem: SS, externalId: 'EX-09' }, NOW));

  it('a machine with no device says so, rather than "offline"', async () => {
    await owner.query(`TRUNCATE "device_projection"`);
    expect(await live()).toMatchObject({ connection: 'no-device', signals: [], location: null, running: null });
  });

  it('newest value per signal with its age; position and running read out; an old signal greyed', async () => {
    await reading('coolant_temp', 81, ago(10), 'degC');
    await reading('coolant_temp', 84, ago(2), 'degC');
    await reading('engine_running', 1, ago(2));
    await reading('fuel_level', 40, ago(20), '%');
    await reading('latitude', 12.97, ago(3));
    await reading('longitude', 77.59, ago(3));

    const result = await live();
    expect(result).toMatchObject({ connection: 'online', running: true, lastReadingAt: ago(2).toISOString() });
    expect(result.location).toEqual({ lat: 12.97, lng: 77.59, at: ago(3).toISOString(), ageSeconds: 180 });
    expect(result.signals.map((s) => [s.signal, s.value, s.ageSeconds, s.stale])).toEqual([
      ['coolant_temp', 84, 120, false],
      ['engine_running', 1, 120, false],
      ['fuel_level', 40, 1200, true],
    ]);
  });

  it('connection is the newest reading\'s age: delayed after 5 minutes, offline after 30', async () => {
    await reading('coolant_temp', 84, ago(12));
    expect((await live()).connection).toBe('delayed');
    await owner.query(`TRUNCATE "telemetry_reading"`);
    await reading('coolant_temp', 84, ago(45));
    expect((await live()).connection).toBe('offline');
  });

  it('1.0 asked at the moment: its newer value wins over 2.0\'s older copy', async () => {
    await reading('coolant_temp', 80, ago(6), 'degC');
    // Measurement 501 is this device's coolant_temp in 1.0.
    await owner.query(
      `INSERT INTO "sensor_map_projection" (source_system, external_id, tenant_id, checksum, imei, signal, unit)
       VALUES ($1, '501', 'acme', 'x', $2, 'coolant_temp', 'degC')`, [SS, IMEI],
    );
    await owner.query(`INSERT INTO "device_sensor_measurement_logs" (device_sensor_measurement_id, "timestamp", value)
      VALUES (501, $1, '86.5'), (501, $2, '85')`, [ago(1), ago(4)]);

    const result = await live('acme', legacy);
    expect(result.legacyAsked).toBe(true);
    expect(result.connection).toBe('online');
    expect(result.signals).toEqual([expect.objectContaining({ signal: 'coolant_temp', value: 86.5, source: '1.0', ageSeconds: 60 })]);
  });

  it('another account sees no device and no value', async () => {
    await reading('coolant_temp', 84, ago(2));
    expect(await live('globex')).toMatchObject({ connection: 'no-device', signals: [] });
  });
});
