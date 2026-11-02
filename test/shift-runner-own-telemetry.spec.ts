import { DataSource } from 'typeorm';
import { EquipmentScenario } from '../src/activation/entities/equipment-scenario.entity';
import { AlertService } from '../src/alert/services/alert.service';
import { RequestScope } from '../src/auth/types/request-scope';
import { ClientScenario } from '../src/client-catalog/entities/client-scenario.entity';
import { Severity } from '../src/common/severity';
import { DeviceHealthService } from '../src/device-health/services/device-health.service';
import { CLIENT_SOURCE_SYSTEM } from '../src/equipment/equipment-profile.entity';
import { EquipmentService } from '../src/equipment/services/equipment.service';
import { PlantService } from '../src/equipment/services/plant.service';
import { ChainService } from '../src/intelligence/services/chain.service';
import { LegacyTelemetryReader } from '../src/legacy/legacy-telemetry.reader';
import { BaselineService } from '../src/prediction/services/baseline.service';
import { PredictionService } from '../src/prediction/services/prediction.service';
import { runTenantSpanning } from '../src/scope/tenant-session';
import { ShiftRunner } from '../src/shift/services/shift-runner.service';
import { ShiftService } from '../src/shift/services/shift.service';
import { TelemetryService } from '../src/telemetry/telemetry.service';
import { UtilizationService } from '../src/utilization/services/utilization.service';
import { WorkOrder } from '../src/work/entities/work-order.entity';
import { PredictionWorkRaiser } from '../src/work/services/prediction-work-raiser.service';
import { bindProjectedDevice } from './bind-projected-devices';
import { createAppDataSource, createTestDataSource, describeDb } from './db';

const IST = 'Asia/Kolkata';
const NOW = new Date('2026-09-14T09:00:00.000Z');
const HOUR = 3_600_000;

/**
 * The shift runner with no connection to the existing platform (dev today): readings
 * that reached 2.0 directly — the demo's stream every 30 seconds, an uploaded history —
 * are scored from where they are. A window 2.0 holds nothing for stays owed, as before,
 * because its readings may be waiting upstream.
 */
describeDb('the shift runner, scoring what 2.0 already holds', () => {
  let ds: DataSource;
  let owner: DataSource;
  let runner: ShiftRunner;
  let shifts: ShiftService;
  let plants: PlantService;
  let equipment: EquipmentService;
  let baselines: BaselineService;

  const boss: RequestScope = {
    tenantId: 'acme', userId: 'u-boss', roles: ['ceo-manager'], isPlatformRole: false,
    capabilities: ['equipment.write', 'catalog.read', 'prediction.run'],
  };
  // 06:00–14:00 Kolkata is 00:30–08:30 UTC, so the 14th's window closed before NOW.
  const morning = { name: 'A', startMinute: 6 * 60, endMinute: 14 * 60, days: [0, 1, 2, 3, 4, 5, 6] as any, timeZone: IST };
  const ref = (externalId: string) => ({ sourceSystem: CLIENT_SOURCE_SYSTEM, externalId });

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    ds = await createAppDataSource();
    shifts = new ShiftService(ds);
    plants = new PlantService(ds);
    equipment = new EquipmentService(ds);
    baselines = new BaselineService(ds);
    // No legacy connection, as on dev.
    runner = new ShiftRunner(
      ds, shifts, new LegacyTelemetryReader(ds, null), new TelemetryService(ds),
      new PredictionService(ds, new PredictionWorkRaiser()), new AlertService(ds),
      new UtilizationService(ds), new DeviceHealthService(ds), new ChainService(ds),
    );
  }, 40_000);

  afterAll(async () => { await ds?.destroy(); await owner?.destroy(); });

  beforeEach(async () => {
    for (const t of ['causal_chain', 'device_link_health', 'utilization_shift', 'shift_run', 'alert_event', 'alert_rule',
      'work_order_event', 'work_order', 'work_order_counter', 'prediction', 'prediction_baseline', 'telemetry_reading',
      'equipment_shift', 'equipment_scenario', 'client_scenario', 'signal_binding_version', 'equipment_placement_event',
      'equipment_profile', 'plant']) {
      await owner.query(`DELETE FROM "${t}"`);
    }
    const north = (await plants.create(boss, { code: 'NORTH', name: 'Northern yard' })).id;
    await runTenantSpanning(owner, 'fixture', (m) => m.save(ClientScenario, m.create(ClientScenario, {
      tenantId: 'acme', slug: 'dg-coolant-overheat', clientEquipmentClassSlug: 'diesel-generator',
      name: 'Coolant overheat', description: null, severity: Severity.High, tier: 1 as any,
      requiredSignals: ['coolant_temp'], minimumHistoryDays: 0, parameters: [] as any,
      enabled: true, templateSlug: 'dg-coolant-overheat', templateVersion: 1,
      templateChecksum: 'c', copiedAt: NOW, status: 'active' as const, updatedBy: 'u-master',
    })));
    for (const [code, imei] of [['DG-7', 'imei-7'], ['DG-8', 'imei-8']]) {
      await equipment.create(boss, { code, name: code, plantId: north });
      await runTenantSpanning(owner, 'fixture', async (m) => {
        await bindProjectedDevice(m, { tenantId: 'acme', sourceSystem: CLIENT_SOURCE_SYSTEM, externalId: code, imei });
        await m.save(EquipmentScenario, m.create(EquipmentScenario, {
          tenantId: 'acme', sourceSystem: CLIENT_SOURCE_SYSTEM, externalId: code,
          clientScenarioSlug: 'dg-coolant-overheat', state: 'active' as any,
          parameterOverrides: {}, blockersAtActivation: [], activatedBy: 'u-boss',
          activatedAt: NOW, stateChangedBy: 'u-boss', stateChangedAt: NOW, stateReason: null, lastEvaluatedAt: null,
        }));
      });
    }
  });

  /** Forty readings either side of 80 over the twenty days before the window: a baseline. */
  const history = (imei: string) => owner.query(
    `INSERT INTO telemetry_reading (tenant_id, imei, signal, value, unit, source_timestamp, received_at, source)
     SELECT 'acme', $1, 'coolant_temp', CASE WHEN i % 2 = 0 THEN 78 ELSE 82 END, 'degC',
            $2::timestamptz - (i + 30) * interval '12 hours', now(), 'live'
       FROM generate_series(0, 39) i`, [imei, NOW]);

  /** Readings pushed into the 14th's window, every 30 seconds from 06:00 to 06:30 IST. */
  const streamed = (imei: string, value: number, source: 'live' | 'replayed' = 'live', signal = 'coolant_temp') => owner.query(
    `INSERT INTO telemetry_reading (tenant_id, imei, signal, value, unit, source_timestamp, received_at, source)
     SELECT 'acme', $1, $4, $2, 'degC', ts, ts, $3
       FROM generate_series('2026-09-14T00:30:30Z'::timestamptz, '2026-09-14T01:00:00Z'::timestamptz, interval '30 seconds') ts`,
    [imei, value, source, signal]);

  const telemetryCount = async () => (await owner.query(`SELECT count(*)::int AS n FROM telemetry_reading`))[0].n;
  const scoredThrough = async (code: string) => {
    const [row] = await owner.query(`SELECT scored_through FROM equipment_shift WHERE external_id = $1`, [code]);
    return row.scored_through ? new Date(row.scored_through).toISOString() : null;
  };

  it('1. a window with streamed readings is scored from them, without ingesting them twice, and the watermark moves', async () => {
    await history('imei-7');
    await streamed('imei-7', 80);
    await baselines.refresh(boss, ref('DG-7'), 30, NOW);
    await shifts.create(boss, ref('DG-7'), morning);
    const before = await telemetryCount();

    const summary = await runner.run(NOW);
    expect(summary).toMatchObject({ considered: 1, scored: 1, failed: 0 });
    expect(summary.outcomes[0]).toMatchObject({ status: 'scored', readings: 60, predictions: 1 });
    expect(await telemetryCount()).toBe(before);
    expect(await scoredThrough('DG-7')).toBe('2026-09-14T08:30:00.000Z');
    expect(await runner.run(NOW)).toMatchObject({ considered: 0 });
  });

  it('2. a critical shift raises a job, the whole chain as with the existing platform', async () => {
    await history('imei-7');
    // The baseline from before the shift; refreshed after, it would have learned the spike.
    await baselines.refresh(boss, ref('DG-7'), 30, NOW);
    await streamed('imei-7', 140);
    await shifts.create(boss, ref('DG-7'), morning);

    expect((await runner.run(NOW)).outcomes[0]).toMatchObject({ status: 'scored', raised: 1 });
    const [job] = await owner.getRepository(WorkOrder).find();
    expect(job).toMatchObject({ origin: 'prediction', status: 'created', externalId: 'DG-7' });
  });

  it('3. a window 2.0 holds nothing for stays owed, while another machine\'s in the same pass is scored', async () => {
    await history('imei-7');
    await streamed('imei-7', 80);
    await shifts.create(boss, ref('DG-7'), morning);
    await shifts.create(boss, ref('DG-8'), morning);

    const summary = await runner.run(NOW);
    expect(summary).toMatchObject({ considered: 2, scored: 1, skipped: 1 });
    expect(summary.outcomes.find((o) => o.externalId === 'DG-8')).toMatchObject({ status: 'nothing-to-score', detail: 'no connection' });
    expect(await scoredThrough('DG-8')).toBeNull();
    expect(await shifts.owed(NOW)).toHaveLength(1);
  });

  it('4. an engine that reported all shift and never ran is not scored, and the watermark still moves', async () => {
    await history('imei-7');
    await streamed('imei-7', 0, 'live', 'engine_running_status');
    await shifts.create(boss, ref('DG-7'), morning);

    const summary = await runner.run(NOW);
    expect(summary.outcomes[0]).toMatchObject({ status: 'not-running', detail: 'engine-never-ran' });
    expect(await scoredThrough('DG-7')).toBe('2026-09-14T08:30:00.000Z');
  });

  it('5. scored only from uploaded history, the prediction says replayed, not live', async () => {
    await history('imei-7');
    await owner.query(`DELETE FROM telemetry_reading WHERE source_timestamp > '2026-09-13T00:00:00Z'`);
    await streamed('imei-7', 80, 'replayed');
    await shifts.create(boss, ref('DG-7'), morning);
    await owner.query(`UPDATE telemetry_reading SET source = 'replayed'`);
    await baselines.refresh(boss, ref('DG-7'), 30, NOW);

    expect((await runner.run(NOW)).outcomes[0]).toMatchObject({ status: 'scored', predictions: 1 });
    const [p] = await owner.query(`SELECT source FROM prediction WHERE external_id = 'DG-7'`);
    expect(p.source).toBe('replayed');
  });

  it('6. a device\'s readings from before it was bound to this machine are not this machine\'s', async () => {
    await history('imei-7');
    await streamed('imei-7', 80);
    await owner.query(`UPDATE signal_binding_version SET valid_from = '2026-09-14T02:00:00Z' WHERE imei = 'imei-7'`);
    await shifts.create(boss, ref('DG-7'), morning);

    const summary = await runner.run(NOW);
    expect(summary.outcomes[0]).toMatchObject({ status: 'nothing-to-score', detail: 'no connection' });
  });
});
