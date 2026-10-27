import { DataSource } from 'typeorm';
import { AlertService } from '../src/alert/services/alert.service';
import { RequestScope } from '../src/auth/types/request-scope';
import { DeviceHealthService } from '../src/device-health/services/device-health.service';
import { CLIENT_SOURCE_SYSTEM } from '../src/equipment/equipment-profile.entity';
import { EquipmentService } from '../src/equipment/services/equipment.service';
import { PlantService } from '../src/equipment/services/plant.service';
import { ChainService } from '../src/intelligence/services/chain.service';
import { LegacyTelemetryReader } from '../src/legacy/legacy-telemetry.reader';
import { PredictionService } from '../src/prediction/services/prediction.service';
import { ShiftRunner } from '../src/shift/services/shift-runner.service';
import { ShiftService } from '../src/shift/services/shift.service';
import { TelemetryService } from '../src/telemetry/telemetry.service';
import { UtilizationService } from '../src/utilization/services/utilization.service';
import { PredictionWorkRaiser } from '../src/work/services/prediction-work-raiser.service';
import { createAppDataSource, createTestDataSource, describeDb } from './db';

const IST = 'Asia/Kolkata';
const NOW = new Date('2026-09-14T09:00:00.000Z');

/**
 * Link health for loggers commissioned in 2.0 (no existing-platform connection, as on dev).
 *
 * The link check took its list of loggers from the existing platform's sensor map, which
 * knows nothing about a logger registered here. Every machine onboarded in 2.0 therefore
 * had no verdict at all — "no link data" on every card — while its logger reported every
 * ten minutes. Its bindings are what say which logger it has and what that logger should
 * carry, so they are the list now.
 */
describeDb('link health for loggers commissioned in 2.0', () => {
  let ds: DataSource;
  let owner: DataSource;
  let runner: ShiftRunner;
  let shifts: ShiftService;
  let plants: PlantService;
  let equipment: EquipmentService;

  const boss: RequestScope = {
    tenantId: 'acme', userId: 'u-boss', roles: ['ceo-manager'], isPlatformRole: false,
    capabilities: ['equipment.write', 'catalog.read', 'prediction.run'],
  };
  // 06:00–14:00 Kolkata is 00:30–08:30 UTC, so the 14th's window closed before NOW.
  const morning = { name: 'A', startMinute: 6 * 60, endMinute: 14 * 60, days: [0, 1, 2, 3, 4, 5, 6] as any, timeZone: IST };
  const ref = { sourceSystem: CLIENT_SOURCE_SYSTEM, externalId: 'DG-7' };

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    ds = await createAppDataSource();
    shifts = new ShiftService(ds);
    plants = new PlantService(ds);
    equipment = new EquipmentService(ds);
    runner = new ShiftRunner(
      ds, shifts, new LegacyTelemetryReader(ds, null), new TelemetryService(ds),
      new PredictionService(ds, new PredictionWorkRaiser()), new AlertService(ds),
      new UtilizationService(ds), new DeviceHealthService(ds), new ChainService(ds),
    );
  }, 40_000);

  afterAll(async () => { await ds?.destroy(); await owner?.destroy(); });

  beforeEach(async () => {
    for (const t of ['causal_chain', 'device_link_health', 'utilization_shift', 'shift_run', 'prediction',
      'telemetry_reading', 'equipment_shift', 'signal_binding_version', 'equipment_placement_event',
      'equipment_profile', 'plant']) {
      await owner.query(`DELETE FROM "${t}"`);
    }
    const north = (await plants.create(boss, { code: 'NORTH', name: 'Northern yard' })).id;
    await equipment.create(boss, { code: 'DG-7', name: 'DG-7', plantId: north });
    await shifts.create(boss, ref, morning);
  });

  /** A primary, active binding of one signal to a logger on DG-7, the way onboarding makes one. */
  const bind = (imei: string, signal: string, validFrom = '2026-01-01T00:00:00Z', validTo: string | null = null) => owner.query(
    `INSERT INTO signal_binding_version
       (tenant_id, source_system, external_id, signal_key, measurement_role, component_id, origin,
        imei, channel, canonical_unit, valid_from, valid_to, is_primary, status, discovered_by, approved_by, approved_at)
     VALUES ('acme', $1, 'DG-7', $2, $2, '', 'physical', $3, $2, 'none', $4, $5, true, 'active', 'manual', 'fixture', $4)`,
    [CLIENT_SOURCE_SYSTEM, signal, imei, validFrom, validTo]);

  /** Every ten minutes across the whole 14th's window: a logger with nothing wrong. */
  const reported = (imei: string, signal: string) => owner.query(
    `INSERT INTO telemetry_reading (tenant_id, imei, signal, value, unit, source_timestamp, received_at, source)
     SELECT 'acme', $1, $2, 80, 'degC', ts, ts, 'live'
       FROM generate_series('2026-09-14T00:30:00Z'::timestamptz, '2026-09-14T08:30:00Z'::timestamptz, interval '10 minutes') ts`,
    [imei, signal]);

  const verdicts = async () => owner.query(
    `SELECT imei, external_id, state, missing_signals FROM device_link_health ORDER BY imei`);

  it('1. a logger reporting everything it is bound to is healthy, where before it had no verdict', async () => {
    await bind('imei-7', 'coolant_temp');
    await bind('imei-7', 'oil_pressure');
    await reported('imei-7', 'coolant_temp');
    await reported('imei-7', 'oil_pressure');

    expect((await runner.run(NOW)).outcomes[0]).toMatchObject({ status: 'scored' });
    expect(await verdicts()).toEqual([
      { imei: 'imei-7', external_id: 'DG-7', state: 'healthy', missing_signals: [] },
    ]);
  });

  it('2. a logger reporting one of the two signals it is bound to is partial, and names the missing one', async () => {
    await bind('imei-7', 'coolant_temp');
    await bind('imei-7', 'oil_pressure');
    await reported('imei-7', 'coolant_temp');

    await runner.run(NOW);
    expect(await verdicts()).toEqual([
      { imei: 'imei-7', external_id: 'DG-7', state: 'partial', missing_signals: ['oil_pressure'] },
    ]);
  });

  it('3. a second logger on the machine that said nothing all shift is dark', async () => {
    await bind('imei-7', 'coolant_temp');
    await bind('imei-9', 'fuel_level');
    await reported('imei-7', 'coolant_temp');

    await runner.run(NOW);
    expect((await verdicts()).map((v: { imei: string; state: string }) => [v.imei, v.state])).toEqual([
      ['imei-7', 'healthy'], ['imei-9', 'dark'],
    ]);
  });

  it('4. a logger taken off the machine before the shift is not judged for it', async () => {
    // Swapped on the 1st: the old logger's binding ends where the new one's begins.
    await bind('imei-old', 'coolant_temp', '2026-01-01T00:00:00Z', '2026-09-01T00:00:00Z');
    await bind('imei-7', 'coolant_temp', '2026-09-01T00:00:00Z');
    await reported('imei-7', 'coolant_temp');

    await runner.run(NOW);
    expect((await verdicts()).map((v: { imei: string }) => v.imei)).toEqual(['imei-7']);
  });
});
