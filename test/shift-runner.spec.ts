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
import { ShiftRunService } from '../src/shift/services/shift-run.service';
import { ShiftScheduler } from '../src/shift/services/shift-scheduler.service';
import { tryTakePassLock } from '../src/shift/services/pass-lock';
import { TelemetryService } from '../src/telemetry/telemetry.service';
import { TelemetryReading } from '../src/telemetry/telemetry-reading.entity';
import { PredictionWorkRaiser } from '../src/work/services/prediction-work-raiser.service';
import { WorkOrder } from '../src/work/entities/work-order.entity';
import { AlertService } from '../src/alert/services/alert.service';
import { UtilizationService } from '../src/utilization/services/utilization.service';
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
  let alerts: AlertService;

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
    alerts = new AlertService(ds);
    runner = new ShiftRunner(
      ds, shifts, reader, new TelemetryService(ds),
      new PredictionService(ds, new PredictionWorkRaiser()), alerts,
      new UtilizationService(ds),
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
           ("device_sensor_measurement_id","timestamp","value","created_at")
         VALUES ($1,$2,$3,$2)`, r);
    }
  };

  beforeEach(async () => {
    for (const t of ['utilization_shift', 'shift_run', 'alert_event', 'alert_rule', 'work_order_event', 'work_order', 'work_order_counter',
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
         ("device_sensor_measurement_id","timestamp","value","created_at")
       VALUES ($1,'2026-09-14T07:00:00Z',140,'2026-09-14T07:00:00Z')`,
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

  describe('running on its own', () => {
    it('writes down what it did, including what it could not do', async () => {
      await shifts.create(boss, ref, morning);
      await runner.run(NOW);

      const runs = await new ShiftRunService(ds)
        .forEquipment(boss, { sourceSystem: CLIENT_SOURCE_SYSTEM, externalId: ASSET });
      // Every outcome, not only the failures. If only failures were kept, the absence
      // of a row would mean either "it worked" or "nothing happened", and those are
      // the two answers that most need telling apart.
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({
        status: 'nothing-to-score', detail: 'no-readings',
        localDate: '2026-09-14', shiftName: 'A',
      });
      expect(runs[0].durationMs).not.toBeNull();
    });

    it('records a scored window with what came of it', async () => {
      await seedLegacyReadings(95);
      await shifts.create(boss, ref, morning);
      await runner.run(NOW);

      const [run] = await new ShiftRunService(ds)
        .forEquipment(boss, { sourceSystem: CLIENT_SOURCE_SYSTEM, externalId: ASSET });
      expect(run).toMatchObject({ status: 'scored', readings: 1, predictions: 1 });
    });

    it('will not let two passes run at once', async () => {
      await seedLegacyReadings(95);
      await shifts.create(boss, ref, morning);

      // Somebody else is mid-pass. Two instances would both read the same watermark
      // and score the same shift: not corrupting, because a prediction upserts, but
      // twice the work and half the sense the logs make.
      const held = await tryTakePassLock(ds);
      expect(held).not.toBeNull();
      expect(await runner.runExclusively(NOW)).toBeNull();

      await held!.release();
      // And the moment it is free, the pass happens. Nothing was lost by skipping.
      expect(await runner.runExclusively(NOW)).toMatchObject({ scored: 1 });
    });

    it('does not schedule itself unless somebody switched it on', async () => {
      const calls: Date[] = [];
      const scheduler = new ShiftScheduler({
        runExclusively: async (at: Date) => { calls.push(at); return null; },
      } as any);

      delete process.env.SHIFT_RUNNER_ENABLED;
      scheduler.onModuleInit();
      // A scheduled job that starts itself everywhere is one that runs during
      // somebody's migration, in a test, and on a laptop pointed at production.
      expect((scheduler as any).timer).toBeNull();
      scheduler.onModuleDestroy();

      // The tick itself still works when called, which is what the timer would do.
      await scheduler.tick(NOW);
      expect(calls).toHaveLength(1);
    });

    it('drops a tick that arrives while the last one is still going', async () => {
      let release: () => void = () => {};
      const inFlight = new Promise<void>((resolve) => { release = resolve; });
      const scheduler = new ShiftScheduler({
        runExclusively: async () => { await inFlight; return null; },
      } as any);

      const first = scheduler.tick(NOW);
      // Not queued behind it: the work this tick would do is the work already in
      // progress, and the next tick finds whatever is left.
      await scheduler.tick(NOW);
      release();
      await first;
    });
  });

  describe('when a logger has been off the network', () => {
    /**
     * The case Things Alive described: the hardware buffers up to two days and pushes
     * when the network comes back. Those readings carry the logger's clock, so they
     * land inside windows that have already been scored — and a watermark on event
     * time alone would never look at them again.
     */
    it('re-scores a window when its readings turn up afterwards', async () => {
      // A thin shift: one reading was online at the time, so the window scores.
      await owner.query(
        `INSERT INTO "device_sensor_measurement_logs"
           ("device_sensor_measurement_id","timestamp","value","created_at")
         VALUES ($1,'2026-09-14T01:00:00Z',80,'2026-09-14T01:00:00Z')`,
        [MEASUREMENT_ID]);
      await shifts.create(boss, ref, morning);

      const first = await runner.run(NOW);
      expect(first).toMatchObject({ scored: 1, rewound: 0 });
      expect(first.outcomes[0].readings).toBe(1);

      // The logger comes back and pushes the rest of that morning. Same window,
      // arriving now.
      for (const at of ['2026-09-14T02:00:00Z', '2026-09-14T03:00:00Z', '2026-09-14T04:00:00Z']) {
        await owner.query(
          `INSERT INTO "device_sensor_measurement_logs"
             ("device_sensor_measurement_id","timestamp","value","created_at")
           VALUES ($1,$2,81,$2)`,
          [MEASUREMENT_ID, at]);
      }

      const second = await runner.run(NOW);
      // Without the arrival watermark this is considered: 0 — the window is not owed,
      // so nothing pulls it, and a prediction built from a quarter of the shift stands
      // for ever as the answer for all of it.
      expect(second).toMatchObject({ rewound: 1, scored: 1 });
      expect(second.outcomes[0].readings).toBe(3);
      expect(second.outcomes[0].localDate).toBe('2026-09-14');

      const predictions = await owner.query(
        `SELECT "occurred_at" FROM "prediction" WHERE "external_id" = $1
          ORDER BY "occurred_at" ASC`, [ASSET]);
      // Two rows, and this is worth being precise about rather than glossing. A
      // prediction is keyed by the moment of the newest reading behind it, so the
      // thin answer (built at 01:00) and the fuller one (04:00) are different rows
      // rather than an upsert. That is the existing rule — predictions are a history,
      // not a current value — and both rows are true: at 01:00 that genuinely was the
      // best available answer.
      //
      // What it does mean is that one shift can carry more than one answer, and the
      // newest is the one that counts. Tying a prediction to its shift window instead
      // is tracked separately; it is a change to a key twelve slices depend on.
      expect(predictions.map((p: any) => new Date(p.occurred_at).toISOString()))
        .toEqual(['2026-09-14T01:00:00.000Z', '2026-09-14T04:00:00.000Z']);
    });

    it('settles, rather than sweeping itself for ever', async () => {
      await owner.query(
        `INSERT INTO "device_sensor_measurement_logs"
           ("device_sensor_measurement_id","timestamp","value","created_at")
         VALUES ($1,'2026-09-14T01:00:00Z',80,'2026-09-14T01:00:00Z')`,
        [MEASUREMENT_ID]);
      await shifts.create(boss, ref, morning);

      await runner.run(NOW);
      // Nothing new has arrived, so nothing rewinds. The arrival watermark has to step
      // past what it saw, or every pass rediscovers the same rows.
      expect(await runner.run(NOW)).toMatchObject({ rewound: 0, considered: 0 });
      expect(await runner.run(NOW)).toMatchObject({ rewound: 0, considered: 0 });
    });

    it('does not rewind a window that was never scored', async () => {
      // A machine being onboarded has two days of buffered readings and no scoring
      // history. Rewinding from a watermark that does not exist yet would drag the
      // first run back through all of it.
      for (let i = 0; i < 5; i += 1) {
        await owner.query(
          `INSERT INTO "device_sensor_measurement_logs"
             ("device_sensor_measurement_id","timestamp","value","created_at")
           VALUES ($1,$2,80,$2)`,
          [MEASUREMENT_ID, new Date(NOW.getTime() - i * 6 * 3_600_000).toISOString()]);
      }
      await shifts.create(boss, ref, morning);

      const summary = await runner.run(NOW);
      expect(summary).toMatchObject({ rewound: 0, considered: 1 });
    });
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

  it('does not score a shift the machine never ran', async () => {
    // engine_running_status is an ordinary sensor measurement arriving through the
    // same pipe as everything else — which is why "equipment status comes from the
    // backend" needs no second integration.
    await runTenantSpanning(owner, 'test fixture', (m) =>
      m.getRepository(SensorMapProjection).save({
        tenantId: 'acme', sourceSystem: CLIENT_SOURCE_SYSTEM, externalId: '90211',
        checksum: 'c', imei: IMEI, signal: 'engine_running_status', sensorName: 'Running',
        unit: null, payload: {}, sourceUpdatedAt: NOW, syncedAt: NOW, status: 'live' as const,
      }));
    for (const [id, value] of [[MEASUREMENT_ID, 80], ['90211', 0]] as [string, number][]) {
      await owner.query(
        `INSERT INTO "device_sensor_measurement_logs"
           ("device_sensor_measurement_id","timestamp","value","created_at")
         VALUES ($1,'2026-09-14T04:00:00Z',$2,'2026-09-14T04:00:00Z')`,
        [id, value]);
    }
    await shifts.create(boss, ref, morning);

    const summary = await runner.run(NOW);
    // A shift where the logger reported all day and the engine never turned over is
    // readings that look like telemetry and describe nothing. Scoring them against a
    // baseline built from a working machine is a confident answer about a machine
    // that was not there.
    expect(summary).toMatchObject({ idle: 1, scored: 0, failed: 0 });
    expect(summary.outcomes[0]).toMatchObject({ status: 'not-running', detail: 'engine-never-ran' });
    expect(await owner.getRepository('prediction').count()).toBe(0);
    // Still ingested: the readings are true and belong to the history.
    expect(summary.outcomes[0].readings).toBe(2);
  });

  it('scores a shift the machine ran for part of', async () => {
    await runTenantSpanning(owner, 'test fixture', (m) =>
      m.getRepository(SensorMapProjection).save({
        tenantId: 'acme', sourceSystem: CLIENT_SOURCE_SYSTEM, externalId: '90211',
        checksum: 'c', imei: IMEI, signal: 'engine_running_status', sensorName: 'Running',
        unit: null, payload: {}, sourceUpdatedAt: NOW, syncedAt: NOW, status: 'live' as const,
      }));
    for (const [id, value, at] of [
      [MEASUREMENT_ID, 80, '2026-09-14T04:00:00Z'],
      ['90211', 0, '2026-09-14T02:00:00Z'],
      ['90211', 1, '2026-09-14T04:00:00Z'],
    ] as [string, number, string][]) {
      await owner.query(
        `INSERT INTO "device_sensor_measurement_logs"
           ("device_sensor_measurement_id","timestamp","value","created_at")
         VALUES ($1,$3,$2,$3)`,
        [id, value, at]);
    }
    await shifts.create(boss, ref, morning);

    // Twenty minutes of an eight-hour shift is still running, and those readings are
    // worth scoring. Demanding a majority would quietly discard every short job.
    expect(await runner.run(NOW)).toMatchObject({ scored: 1, idle: 0 });
  });

  describe('duty cycle', () => {
    /**
     * Utilization is measured on every path out of a window (task P4-05).
     *
     * That is the whole point of these three tests. The shifts that produce no
     * prediction are the idle ones, the offline ones and the ones nobody was
     * watching — so a duty-cycle report assembled only from the shifts that scored
     * would be a report about the machines that were working, which is the one
     * question it is meant to answer.
     */
    const dutyRows = () => owner.query(
      `SELECT * FROM "utilization_shift" ORDER BY "window_start"`,
    );

    it('measures a scored window', async () => {
      await runTenantSpanning(owner, 'test fixture', (m) =>
        m.getRepository(SensorMapProjection).save({
          tenantId: 'acme', sourceSystem: CLIENT_SOURCE_SYSTEM, externalId: '90211',
          checksum: 'c', imei: IMEI, signal: 'engine_running_status', sensorName: 'Running',
          unit: null, payload: {}, sourceUpdatedAt: NOW, syncedAt: NOW, status: 'live' as const,
        }));
      await seedLegacyReadings(95);
      for (const at of ['2026-09-14T04:00:00Z', '2026-09-14T04:02:00Z']) {
        await owner.query(
          `INSERT INTO "device_sensor_measurement_logs"
             ("device_sensor_measurement_id","timestamp","value","created_at")
           VALUES ('90211',$1,1,$1)`,
          [at]);
      }
      await shifts.create(boss, ref, morning);

      expect(await runner.run(NOW)).toMatchObject({ scored: 1 });
      const [row] = await dutyRows();
      expect(row.external_id).toBe(ASSET);
      expect(Number(row.engine_on_seconds)).toBeGreaterThan(0);
      // Two samples two minutes apart cannot describe an eight-hour shift, and the
      // row says so rather than crediting the machine with the other seven hours.
      expect(Number(row.unknown_seconds)).toBeGreaterThan(7 * 3600);
      expect(Number(row.coverage)).toBeLessThan(0.05);
    });

    it('measures the shift the machine slept through', async () => {
      await runTenantSpanning(owner, 'test fixture', (m) =>
        m.getRepository(SensorMapProjection).save({
          tenantId: 'acme', sourceSystem: CLIENT_SOURCE_SYSTEM, externalId: '90211',
          checksum: 'c', imei: IMEI, signal: 'engine_running_status', sensorName: 'Running',
          unit: null, payload: {}, sourceUpdatedAt: NOW, syncedAt: NOW, status: 'live' as const,
        }));
      for (const at of ['2026-09-14T02:00:00Z', '2026-09-14T02:01:00Z']) {
        await owner.query(
          `INSERT INTO "device_sensor_measurement_logs"
             ("device_sensor_measurement_id","timestamp","value","created_at")
           VALUES ('90211',$1,0,$1)`,
          [at]);
      }
      await shifts.create(boss, ref, morning);

      expect(await runner.run(NOW)).toMatchObject({ idle: 1, scored: 0 });
      // No prediction, and a row anyway: an idle machine is exactly what the
      // customer is paying this report to show them.
      const [row] = await dutyRows();
      expect(Number(row.off_seconds)).toBeGreaterThan(0);
      expect(Number(row.engine_on_seconds)).toBe(0);
    });

    it('measures the shift nobody could see, as unknown rather than as off', async () => {
      await shifts.create(boss, ref, morning);

      expect(await runner.run(NOW)).toMatchObject({ skipped: 1 });
      const [row] = await dutyRows();
      // The distinction the whole table exists for. Recording this as eight hours
      // off would turn a connectivity problem into an accusation about an operator.
      expect(Number(row.unknown_seconds)).toBe(8 * 3600);
      expect(Number(row.off_seconds)).toBe(0);
      expect(Number(row.coverage)).toBe(0);
      expect(row.utilization_rate).toBeNull();
    });

    it('replaces the measurement when late readings rewind the window', async () => {
      await runTenantSpanning(owner, 'test fixture', (m) =>
        m.getRepository(SensorMapProjection).save({
          tenantId: 'acme', sourceSystem: CLIENT_SOURCE_SYSTEM, externalId: '90211',
          checksum: 'c', imei: IMEI, signal: 'engine_running_status', sensorName: 'Running',
          unit: null, payload: {}, sourceUpdatedAt: NOW, syncedAt: NOW, status: 'live' as const,
        }));
      // The thin first pass: two minutes of the shift reported.
      for (const at of ['2026-09-14T01:00:00Z', '2026-09-14T01:01:00Z']) {
        await owner.query(
          `INSERT INTO "device_sensor_measurement_logs"
             ("device_sensor_measurement_id","timestamp","value","created_at")
           VALUES ('90211',$1,1,$1)`,
          [at]);
      }
      await shifts.create(boss, ref, morning);
      await runner.run(NOW);
      const [thin] = await dutyRows();
      expect(Number(thin.coverage)).toBeLessThan(0.02);

      // Then the logger reconnects and pushes the rest of its buffer.
      for (let i = 0; i < 400; i += 1) {
        const at = new Date(Date.parse('2026-09-14T01:02:00Z') + i * 60_000).toISOString();
        await owner.query(
          `INSERT INTO "device_sensor_measurement_logs"
             ("device_sensor_measurement_id","timestamp","value","created_at")
           VALUES ('90211',$1,1,$1)`,
          [at]);
      }
      await runner.run(new Date(NOW.getTime() + 60_000));

      const rows = await dutyRows();
      // One row, replaced. Two would put two contradictory accounts of the same
      // morning into the same report and leave the reader to pick.
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(thin.id);
      expect(Number(rows[0].coverage)).toBeGreaterThan(Number(thin.coverage));
    });
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
      ds, shifts, new LegacyTelemetryReader(ds, null), new TelemetryService(ds),
      new PredictionService(ds), alerts, new UtilizationService(ds),
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
      ds, shifts, reader,
      { ingest: () => { throw new Error('ingest exploded'); } } as any,
      new PredictionService(ds), alerts, new UtilizationService(ds),
    );
    const summary = await broken.run(NOW);

    expect(summary).toMatchObject({ failed: 1, scored: 0 });
    // The watermark did not move, so the window comes round again. A watermark
    // advanced on failure turns a bad afternoon into a permanent hole.
    expect(await shifts.owed(NOW)).toHaveLength(1);
  });
});
