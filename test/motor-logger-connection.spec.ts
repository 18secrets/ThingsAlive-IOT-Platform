import { DataSource } from 'typeorm';
import { readMachineLive } from '../src/page/live-machine';
import { withTenantId } from '../src/scope/tenant-session';
import { createAppDataSource, createTestDataSource, describeDb } from './db';

const SS = 'iot-platform-1';
const NOW = new Date('2026-11-24T12:00:00Z');
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);

jest.setTimeout(30_000);

/**
 * A motor logger's connection on the Live view (Motor Monitor integration spec, 24 Nov
 * 2026): it uploads five minutes of readings in one burst, so it is judged by its last
 * upload — online within ten minutes, offline after — not by its newest reading, which
 * on a logger working perfectly is routinely older than the five minutes that make a
 * once-a-minute device "delayed".
 */
describeDb('a motor logger\'s connection is its last upload', () => {
  let owner: DataSource;
  let ds: DataSource;

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    ds = await createAppDataSource();
  }, 60_000);

  afterAll(async () => { await ds?.destroy(); await owner?.destroy(); });

  beforeEach(async () => {
    await owner.query(`TRUNCATE "telemetry_reading", "device_projection", "motor_upload_log" RESTART IDENTITY CASCADE`);
    await owner.query(
      `INSERT INTO "device_projection" (source_system, external_id, tenant_id, checksum, imei, equipment_external_id)
       VALUES ($1, 'dev-MOTOR_001', 'acme', 'x', 'MOTOR_001', 'PUMP-01')`, [SS]);
  });

  const reading = (imei: string, signal: string, at: Date) => owner.query(
    `INSERT INTO "telemetry_reading" (tenant_id, imei, signal, value, unit, source_timestamp, received_at, source)
     VALUES ('acme', $1, $2, 1, null, $3, $3, 'test')`, [imei, signal, at]);
  const upload = (at: Date, deviceId = 'MOTOR_001') => owner.query(
    `INSERT INTO "motor_upload_log" (device_id, batch_id, first_seq, last_seq, record_count, stored_count, received_at)
     VALUES ($1, 'b', 1, 50, 50, 50, $2)`, [deviceId, at]);
  const live = (tenantId = 'acme') =>
    withTenantId(ds, tenantId, (m) => readMachineLive(m, undefined, tenantId, { sourceSystem: SS, externalId: 'PUMP-01' }, NOW));

  it('uploaded seven minutes ago, its newest minute twelve minutes old: online, not "delayed"', async () => {
    await upload(ago(7));
    await reading('MOTOR_001', 'supply_voltage', ago(12));
    expect(await live()).toMatchObject({
      connection: 'online', lastUploadAt: ago(7).toISOString(), lastReadingAt: ago(12).toISOString(),
    });
  });

  it('no upload for eleven minutes: offline, with nothing in between', async () => {
    await upload(ago(11));
    await reading('MOTOR_001', 'supply_voltage', ago(14));
    expect((await live()).connection).toBe('offline');
  });

  it('ten minutes exactly is still online: two missed bursts, not one, is offline', async () => {
    await upload(ago(10));
    expect((await live()).connection).toBe('online');
  });

  it('the newest of several uploads is the one judged', async () => {
    await upload(ago(40));
    await upload(ago(3));
    expect(await live()).toMatchObject({ connection: 'online', lastUploadAt: ago(3).toISOString() });
  });

  it('a machine with a silent logger and a live tracker is online by the tracker', async () => {
    await owner.query(
      `INSERT INTO "device_projection" (source_system, external_id, tenant_id, checksum, imei, equipment_external_id)
       VALUES ($1, 'dev-TRK', 'acme', 'x', '861000000000077', 'PUMP-01')`, [SS]);
    await upload(ago(45));
    await reading('861000000000077', 'latitude', ago(2));
    await reading('861000000000077', 'longitude', ago(2));
    expect((await live()).connection).toBe('online');
  });

  it('a device that never uploaded is judged by its readings as before', async () => {
    await reading('MOTOR_001', 'supply_voltage', ago(12));
    expect(await live()).toMatchObject({ connection: 'delayed', lastUploadAt: null });
  });

  it('another account\'s logger of the same name lends this machine nothing', async () => {
    await owner.query(`DELETE FROM "device_projection"`);
    await upload(ago(1));
    expect(await live()).toMatchObject({ connection: 'no-device', lastUploadAt: null });
  });
});
