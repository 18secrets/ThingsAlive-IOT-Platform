import { DataSource } from 'typeorm';
import { RequestScope } from '../src/auth/types/request-scope';
import { BaselineService } from '../src/prediction/services/baseline.service';
import { AvailabilityService } from '../src/utilization/services/availability.service';
import { createAppDataSource, createTestDataSource, describeDb } from './db';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/**
 * The binding is the device authority for every reader (task QFIX-DEVICES-2).
 *
 * QFIX-DEVICES moved the evaluator and the page; prediction, its baseline, chains,
 * recommendations, the service forecast and Availability still asked
 * `device_projection` — where 1.0 thinks a device is. Each test here puts the
 * projection and the binding in disagreement on purpose and asserts the reader follows
 * the binding, which is the only way to tell the two sources apart.
 */
describeDb('device authority: the remaining readers follow the binding', () => {
  let owner: DataSource;
  let ds: DataSource;
  let availability: AvailabilityService;
  let baselines: BaselineService;

  const acme: RequestScope = { tenantId: 'acme', userId: 'u', roles: ['admin'], isPlatformRole: false };
  const SRC = 'iot-platform-1';
  const NOW = new Date('2026-10-14T12:00:00.000Z');
  const IMEI = 'imei-x';

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    ds = await createAppDataSource();
    availability = new AvailabilityService(ds);
    baselines = new BaselineService(ds);
  }, 60_000);

  afterAll(async () => { await ds?.destroy(); await owner?.destroy(); });

  beforeEach(async () => {
    await owner.query(
      `TRUNCATE TABLE "prediction_baseline", "telemetry_reading", "signal_binding_version", "equipment_shift",
        "device_projection", "equipment_profile" CASCADE`,
    );
    for (const id of ['A', 'B']) {
      await owner.query(
        `INSERT INTO equipment_profile (tenant_id, source_system, external_id, tier, readiness, updated_by)
           VALUES ('acme', $1, $2, 'standard', '{}'::jsonb, 'u')`, [SRC, id],
      );
      await owner.query(
        `INSERT INTO equipment_shift (tenant_id, source_system, external_id, name, start_minute, end_minute, days, time_zone, status)
           VALUES ('acme', $1, $2, 'All day', 0, 1440, '{0,1,2,3,4,5,6}', 'UTC', 'active')`, [SRC, id],
      );
    }
    // 1.0 still thinks the device is on A.
    await owner.query(
      `INSERT INTO device_projection (tenant_id, source_system, external_id, checksum, imei, equipment_external_id, payload, synced_at, status)
         VALUES ('acme', $1, 'dev-x', 'c', $2, 'A', '{}'::jsonb, now(), 'live')`, [SRC, IMEI],
    );
    // Every ten minutes for the last two days: engine on, coolant at 80.
    await owner.query(
      `INSERT INTO telemetry_reading (tenant_id, imei, signal, value, source_timestamp, received_at, source)
       SELECT 'acme', $1, s.signal, s.value, t, t, 'live'
         FROM generate_series($2::timestamptz, $3::timestamptz, interval '10 minutes') t,
              (VALUES ('engine_running_status', 1), ('coolant_temp', 80)) s(signal, value)`,
      [IMEI, new Date(NOW.getTime() - 2 * DAY), new Date(NOW.getTime() - 10 * 60_000)],
    );
  });

  const bind = (externalId: string, from: Date, to: Date | null = null) => owner.query(
    `INSERT INTO signal_binding_version (tenant_id, source_system, external_id, signal_key, measurement_role, component_id,
       origin, imei, channel, canonical_unit, valid_from, valid_to, is_primary, status, discovered_by, approved_by, approved_at)
     VALUES ('acme', $1, $2, 'coolant_temp', 'coolant_temp', '', 'physical', $3, 'ch1', 'degC', $4, $5, true, 'active',
       'manual', 'u', $4)`,
    [SRC, externalId, IMEI, from, to],
  );
  const lastDay = { from: new Date(NOW.getTime() - DAY), to: NOW };
  const coolantSamples = async (externalId: string) =>
    (await baselines.refresh(acme, { sourceSystem: SRC, externalId }, 7, NOW))
      .find((b) => b.signal === 'coolant_temp')?.sampleCount ?? 0;

  it('Availability reads the bound machine, not the projected one', async () => {
    await bind('B', new Date('2026-01-01'));
    expect((await availability.forEquipment(acme, { sourceSystem: SRC, externalId: 'B' }, lastDay)).readiness).toBe('ready');
    expect(await availability.forEquipment(acme, { sourceSystem: SRC, externalId: 'A' }, lastDay))
      .toMatchObject({ readiness: 'not_available', reason: 'no_readings' });
  });

  it('the prediction baseline reads the bound machine, not the projected one', async () => {
    await bind('B', new Date('2026-01-01'));
    expect(await coolantSamples('B')).toBe(288);
    expect(await coolantSamples('A')).toBe(0);
  });

  it('a device moved mid-window: each machine\'s baseline gets only the readings from its own time', async () => {
    const moved = new Date(NOW.getTime() - DAY);
    await bind('A', new Date('2026-01-01'), moved);
    await bind('B', moved);
    const [a, b] = [await coolantSamples('A'), await coolantSamples('B')];
    expect(a + b).toBe(288);
    expect(a).toBe(144);
    expect(b).toBe(144);
  });

  it('an unbound machine has no devices, whatever the projection says', async () => {
    expect(await coolantSamples('A')).toBe(0);
  });
});
