import { DataSource } from 'typeorm';
import { RequestScope } from '../src/auth/types/request-scope';
import { CLIENT_SOURCE_SYSTEM } from '../src/equipment/equipment-profile.entity';
import { EquipmentService } from '../src/equipment/services/equipment.service';
import { PlantService } from '../src/equipment/services/plant.service';
import { createLegacyDataSource } from '../src/legacy/legacy-source';
import { LegacyTelemetryReader } from '../src/legacy/legacy-telemetry.reader';
import { PredictionService } from '../src/prediction/services/prediction.service';
import { BaselineService } from '../src/prediction/services/baseline.service';
import { DeviceProjection } from '../src/projection/entities/device-projection.entity';
import { SensorMapProjection } from '../src/projection/entities/sensor-map-projection.entity';
import { ClientScenario } from '../src/client-catalog/entities/client-scenario.entity';
import { EquipmentScenario } from '../src/activation/entities/equipment-scenario.entity';
import { Severity } from '../src/common/severity';
import { runTenantSpanning } from '../src/scope/tenant-session';
import { ShiftRunner } from '../src/shift/services/shift-runner.service';
import { ShiftService } from '../src/shift/services/shift.service';
import { TelemetryService } from '../src/telemetry/telemetry.service';
import { TelemetryReading } from '../src/telemetry/telemetry-reading.entity';
import { PredictionWorkRaiser } from '../src/work/services/prediction-work-raiser.service';
import { WorkOrder } from '../src/work/entities/work-order.entity';
import { createAppDataSource, createTestDataSource, describeDb, TEST_DB } from './db';

const IST = 'Asia/Kolkata';
const IMEI = '860123456789012';
const ASSET = 'DG-7';

/**
 * The shift runner, end to end (tasks P1-110, P1-111).
 *
 * The existing platform's table is stood up here rather than mocked. A mock would
 * prove the code calls something; this proves the SQL is the SQL, that the mapping
 * from their measurement id to our canonical signal works, and — the part that would
 * be worthless mocked — that the connection physically cannot write.
 */
describeDb('the shift runner', () => {
  let ds: DataSource;
  let owner: DataSource;
  let legacy: DataSource;
  let runner: ShiftRunner;
  let shifts: ShiftService;
  let reader: LegacyTelemetryReader;
  let plants: PlantService;
  let equipment: EquipmentService;
  let baselines: BaselineService;

  const NOW = new Date('2026-09-14T09:00:00.000Z');
  const boss: RequestScope = {
    tenantId: 'acme', userId: 'u-boss', roles: ['ceo-manager'], isPlatformRole: false,
    capabilities: ['equipment.write', 'catalog.read', 'prediction.run'],
  };

  // 06:00–14:00 Kolkata is 00:30–08:30 UTC, so the window closed before NOW.
  const morning = {
    name: 'A', startMinute: 6 * 60, endMinute: 14 * 60,
    days: [0, 1, 2, 3, 4, 5, 6] as any, timeZone: IST,
  };
  const ref = { sourceSystem: CLIENT_SOURCE_SYSTEM, externalId: ASSET };

  /** Their measurement id, which our sensor map mirrors as its external id. */
  const MEASUREMENT_ID = '90210';

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });

    // Their table, as their entity declares it. Standing it up here is what lets the
    // query be the real query rather than a promise about one.
    await owner.query(`
      CREATE TABLE "device_sensor_measurement_logs" (
        "id" bigserial PRIMARY KEY,
        "device_sensor_measurement_id" bigint NOT NULL,
        "timestamp" timestamptz NOT NULL,
        "value" double precision NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now()
      )`);
    await owner.query(`GRANT SELECT, INSERT ON "device_sensor_measurement_logs" TO "ta_app"`);

    ds = await createAppDataSource();
    legacy = createLegacyDataSource({
      host: TEST_DB.DB_HOST, port: Number(TEST_DB.DB_PORT),
      username: TEST_DB.DB_USERNAME, password: TEST_DB.DB_PASSWORD,
      database: TEST_DB.DB_DATABASE, schema: 'public',
    });
    await legacy.initialize();

    reader = new LegacyTelemetryReader(ds, legacy);
    shifts = new ShiftService(ds);
    plants = new PlantService(ds);
    equipment = new EquipmentService(ds);
    baselines = new BaselineService(ds);
    runner = new ShiftRunner(
      shifts, reader, new TelemetryService(ds),
      new PredictionService(ds, new PredictionWorkRaiser()),
    );
  }, 40_000);

  afterAll(async () => {
    await legacy?.destroy(); await ds?.destroy();
    await owner?.query(`DROP TABLE IF EXISTS "device_sensor_measurement_logs"`);
    await owner?.destroy();
  });

  /** Readings inside the window: a flat history, then one that is far out. */
  const seedLegacyReadings = async (spike?: number) => {
    const rows: unknown[][] = [];
    for (let i = 0; i < 40; i += 1) {
      rows.push([MEASUREMENT_ID,
        new Date(NOW.getTime() - (i + 1) * 12 * 3_600_000).toISOString(),
        i % 2 === 0 ? 78 : 82]);
    }
    if (spike !== undefined) {
      // Inside 00:30–08:30 UTC on the 14th.
      rows.push([MEASUREMENT_ID, '2026-09-14T07:00:00.000Z', spike]);
    }
    for (const r of rows) {
      await owner.query(
        `INSERT INTO "device_sensor_measurement_logs"
           ("device_sensor_measurement_id","timestamp","value") VALUES ($1,$2,$3)`, r);
    }
  };

  beforeEach(async () => {
    for (const t of ['work_order_event', 'work_order', 'work_order_counter',
      'prediction', 'prediction_baseline', 'telemetry_reading', 'equipment_shift',
      'equipment_scenario', 'client_scenario', 'sensor_map_projection',
      'device_projection', 'equipment_placement_event', 'equipment_profile', 'plant']) {
      await owner.query(`DELETE FROM "${t}"`);
    }
    await owner.query(`DELETE FROM "device_sensor_measurement_logs"`);

    const north = (await plants.create(boss, { code: 'NORTH', name: 'Northern yard' })).id;
    await equipment.create(boss, { code: ASSET, name: 'Generator 7', plantId: north });

    await runTenantSpanning(owner, 'test fixture', async (m) => {
      await m.getRepository(DeviceProjection).save({
        tenantId: 'acme', sourceSystem: CLIENT_SOURCE_SYSTEM, externalId: 'dev-1', checksum: 'c',
        imei: IMEI, equipmentExternalId: ASSET, name: null, payload: {},
        sourceUpdatedAt: NOW, syncedAt: NOW, status: 'live' as const,
      });
      await m.getRepository(SensorMapProjection).save({
        tenantId: 'acme', sourceSystem: CLIENT_SOURCE_SYSTEM, externalId: MEASUREMENT_ID,
        checksum: 'c', imei: IMEI, signal: 'coolant_temp', sensorName: 'Coolant',
        unit: 'degC', payload: {}, sourceUpdatedAt: NOW, syncedAt: NOW, status: 'live' as const,
      });
      await m.getRepository(ClientScenario).save({
        tenantId: 'acme', slug: 'dg-coolant-overheat', clientEquipmentClassSlug: 'diesel-generator',
        name: 'Coolant overheat', description: null, severity: Severity.High, tier: 1 as any,
        requiredSignals: ['coolant_temp'], minimumHistoryDays: 0, parameters: [] as any,
        enabled: true, templateSlug: 'dg-coolant-overheat', templateVersion: 1,
        templateChecksum: 'c', copiedAt: NOW, status: 'active' as const, updatedBy: 'u-master',
      });
      await m.getRepository(EquipmentScenario).save({
        tenantId: 'acme', sourceSystem: CLIENT_SOURCE_SYSTEM, externalId: ASSET,
        clientScenarioSlug: 'dg-coolant-overheat', state: 'active' as any,
        parameterOverrides: {}, blockersAtActivation: [], activatedBy: 'u-boss',
        activatedAt: NOW, stateChangedBy: 'u-boss', stateChangedAt: NOW,
        stateReason: null, lastEvaluatedAt: null,
      });
    });
  });

  it('cannot write to the existing platform, whatever the code tries', async () => {
    // The standing rule is that 2.0 only ever reads from the existing platform. This
    // is that rule as a property of the connection rather than of anybody's care:
    // the session is opened read-only, so a write is refused by Postgres.
    await expect(legacy.query(
      `INSERT INTO "device_sensor_measurement_logs"
         ("device_sensor_measurement_id","timestamp","value") VALUES (1, now(), 1)`,
    )).rejects.toThrow(/read-only transaction/);

    // And the same connection reads perfectly well, so this is a guarantee rather
    // than a broken connection that happens to look like one.
    await expect(legacy.query(`SELECT count(*) FROM "device_sensor_measurement_logs"`))
      .resolves.toBeTruthy();
  });

  it('pulls a window, scores it, and moves the watermark', async () => {
    await seedLegacyReadings(95);
    const shift = await shifts.create(boss, ref, morning);

    const summary = await runner.run(NOW);

    expect(summary).toMatchObject({ considered: 1, scored: 1, failed: 0 });
    const [outcome] = summary.outcomes;
    expect(outcome.status).toBe('scored');
    // One reading falls inside 00:30–08:30 UTC on the 14th; the forty-reading history
    // is older and belongs to previous windows.
    expect(outcome.readings).toBe(1);
    expect(outcome.predictions).toBe(1);

    const after = await owner.getRepository('equipment_shift').findOne({ where: { id: shift.id } }) as any;
    expect(new Date(after.scored_through ?? after.scoredThrough).toISOString())
      .toBe('2026-09-14T08:30:00.000Z');
    expect(await runner.run(NOW)).toMatchObject({ considered: 0 });
  });

  it('raises a job when the shift scores critical, with nobody assigned', async () => {
    // History already in 2.0 from previous windows, so a baseline exists. The cold
    // start — a machine whose first scored shift has nothing to compare against — is
    // a real gap and is tracked separately; it is not what this is about.
    await runTenantSpanning(owner, 'test fixture', (m) =>
      m.getRepository(TelemetryReading).save(
        Array.from({ length: 40 }, (_, i) => ({
          tenantId: 'acme', imei: IMEI, signal: 'coolant_temp',
          value: i % 2 === 0 ? 78 : 82, unit: 'degC',
          sourceTimestamp: new Date(NOW.getTime() - (i + 1) * 12 * 3_600_000),
          receivedAt: NOW, source: 'live' as const,
        }))));
    await baselines.refresh(boss, { sourceSystem: CLIENT_SOURCE_SYSTEM, externalId: ASSET }, 30, NOW);

    // One reading inside 00:30-08:30 UTC on the 14th, far outside the baseline.
    await owner.query(
      `INSERT INTO "device_sensor_measurement_logs"
         ("device_sensor_measurement_id","timestamp","value") VALUES ($1,'2026-09-14T07:00:00Z',140)`,
      [MEASUREMENT_ID]);
    await shifts.create(boss, ref, morning);

    const summary = await runner.run(NOW);
    expect(summary.outcomes[0]).toMatchObject({ status: 'scored', readings: 1, raised: 1 });

    const [job] = await owner.getRepository(WorkOrder).find();
    // The whole chain in one assertion: a shift ended, telemetry was pulled from
    // their database, a prediction was made, and somebody has a job waiting to be
    // handed out.
    expect(job).toMatchObject({ origin: 'prediction', status: 'created', assignedToUserId: null });
  });

  it('moves past a shift the machine did not run, rather than retrying it forever', async () => {
    // No readings at all in the window: the machine was off. That is a fact about the
    // shift, not a failure — coming back to the same empty window on every pass would
    // stall every window behind it.
    await shifts.create(boss, ref, morning);
    const summary = await runner.run(NOW);

    expect(summary).toMatchObject({ scored: 0, skipped: 1, failed: 0 });
    expect(summary.outcomes[0]).toMatchObject({ status: 'nothing-to-score', detail: 'no-readings' });
    // The watermark moved even though nothing was scored, so the pass does not come
    // back to it.
    expect(await runner.run(NOW)).toMatchObject({ considered: 0 });
  });

  it('tells a commissioning gap apart from a synchronisation one', async () => {
    await owner.query(`DELETE FROM "sensor_map_projection"`);
    await shifts.create(boss, ref, morning);
    // No sensor mapped is not the same as no device fitted, and collapsing them into
    // "no data" is how a fleet sits unscored with nobody able to say which it is.
    expect((await runner.run(NOW)).outcomes[0].detail).toBe('no-sensors');

    await owner.query(`DELETE FROM "device_projection"`);
    await owner.query(`UPDATE "equipment_shift" SET "scored_through" = NULL`);
    expect((await runner.run(NOW)).outcomes[0].detail).toBe('no-devices');
  });

  it('leaves every window owed when there is no connection at all', async () => {
    const offline = new ShiftRunner(
      shifts, new LegacyTelemetryReader(ds, null), new TelemetryService(ds),
      new PredictionService(ds),
    );
    await shifts.create(boss, ref, morning);

    const summary = await offline.run(NOW);
    // Nothing scored and nothing lost: the honest state until a route and a read-only
    // user exist, and the backlog is taken the moment one appears.
    expect(summary).toMatchObject({ considered: 1, scored: 0, skipped: 1 });
    expect(await shifts.owed(NOW)).toHaveLength(1);
  });

  it('keeps a failing machine from holding up everybody else, and still owes it', async () => {
    await seedLegacyReadings(95);
    await shifts.create(boss, ref, morning);

    const broken = new ShiftRunner(
      shifts, reader,
      { ingest: () => { throw new Error('ingest exploded'); } } as any,
      new PredictionService(ds),
    );
    const summary = await broken.run(NOW);

    expect(summary).toMatchObject({ failed: 1, scored: 0 });
    // The watermark did not move, so the window comes round again. A watermark
    // advanced on failure turns a bad afternoon into a permanent hole.
    expect(await shifts.owed(NOW)).toHaveLength(1);
  });
});
