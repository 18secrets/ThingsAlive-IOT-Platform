import { INestApplication } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { RequestScope } from '../src/auth/types/request-scope';
import { compileFormula } from '../src/catalog/formula/formula-compiler';
import { ClientEquipmentClassLayout } from '../src/client-catalog/entities/client-equipment-class-layout.entity';
import { ClientEquipmentClass } from '../src/client-catalog/entities/client-equipment-class.entity';
import { ClientFormula } from '../src/client-catalog/entities/client-formula.entity';
import { EquipmentProfile } from '../src/equipment/equipment-profile.entity';
import { INVENTORY_TRANSITIONS } from '../src/inventory/services/inventory-state-machine';
import { KpiEvaluatorService } from '../src/kpi/services/kpi-evaluator.service';
import { LegacyTelemetryReader } from '../src/legacy/legacy-telemetry.reader';
import { createApp } from '../src/main';
import { PageService } from '../src/page/page.service';
import { ReadinessRow, SignalChartData } from '../src/page/page-widgets';
import { DeviceProjection } from '../src/projection/entities/device-projection.entity';
import { SensorMapProjection } from '../src/projection/entities/sensor-map-projection.entity';
import { runTenantSpanning } from '../src/scope/tenant-session';
import { SignalBindingVersion } from '../src/signal-binding/entities/signal-binding-version.entity';
import { SignalBindingService } from '../src/signal-binding/services/signal-binding.service';
import { TelemetryReading } from '../src/telemetry/telemetry-reading.entity';
import { createTestDataSource, describeDb, undoMigrationNamed } from './db';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const NOW = new Date('2026-10-05T12:00:00.000Z');
const SS = 'iot-platform-1';
const SIGNAL = 'coolant_temp_c';
const UNIT = 'degC';
const CLASS = 'dg';
const acme: RequestScope = { tenantId: 'acme', userId: 'u-acme', roles: ['admin'], isPlatformRole: false };

/**
 * The binding is the authority for "which device produced this signal on this
 * machine, and when" (task QFIX-DEVICES).
 *
 * Before this, the KPI evaluator read telemetry by `device_projection`'s IMEIs and
 * coverage by `device_inventory`'s — two independent writers — so one page could show
 * a KPI ready beside its own signal reporting no readings. Every fixture here puts the
 * three sources deliberately out of step: the projection names one device, the
 * inventory another, the binding a third. Whatever a producer reports must be the
 * binding's device's, or the test fails.
 */
describeDb('the binding is the device authority', () => {
  let owner: DataSource;
  let app: INestApplication;
  let pages: PageService;
  let evaluator: KpiEvaluatorService;
  let bindings: SignalBindingService;

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    process.env.AUTH_JWT_SECRET = 'test-secret-device-authority';
    process.env.AUTH_JWT_ISSUER = 'things-alive-device-authority-test';
    process.env.AUTH_TENANT_CLAIM = 'client_id';
    process.env.CORS_ORIGINS = 'http://localhost:3000';
    app = await createApp({ database: true });
    await app.init();
    pages = app.get(PageService);
    evaluator = app.get(KpiEvaluatorService);
    bindings = app.get(SignalBindingService);
  }, 60_000);

  afterAll(async () => { await app?.close(); await owner?.destroy(); });

  beforeEach(async () => {
    await owner.query(`
      TRUNCATE TABLE "telemetry_reading", "signal_binding_version", "device_projection", "device_inventory",
        "sensor_map_projection", "client_equipment_class_layout", "client_formula", "client_equipment_class",
        "equipment_profile", "equipment_class_sensor_requirement", "equipment_class_profile"
      RESTART IDENTITY CASCADE`);
    await seedClass();
  });

  // ============================================================== fixtures
  const fixture = (fn: (m: EntityManager) => Promise<unknown>) => runTenantSpanning(owner, 'test fixture', fn);

  const seedClass = async () => {
    const signals = [{ signal: SIGNAL, unit: UNIT, required: true }];
    await owner.query(
      `INSERT INTO equipment_class_profile (slug, version, status, name, expected_signals)
         VALUES ($1, 1, 'published', $1, $2::jsonb)`, [CLASS, JSON.stringify(signals)],
    );
    await owner.query(
      `INSERT INTO equipment_class_sensor_requirement (class_slug, class_version, measurement_role, canonical_unit)
         VALUES ($1, 1, $2, $3)`, [CLASS, SIGNAL, UNIT],
    );
    await fixture(async (m) => {
      await m.getRepository(ClientEquipmentClass).save({
        tenantId: 'acme', slug: CLASS, name: CLASS, description: null, category: null, expectedSignals: signals,
        failureModes: [], defaultThresholds: {}, templateSlug: CLASS, templateVersion: 1, templateChecksum: 'c',
        copiedAt: NOW, status: 'active', updatedBy: 'u-master',
      });
      const expression = `avg(${SIGNAL})`;
      const c = compileFormula({ formulaKey: 'avg_coolant', expression, classSlug: CLASS, expectedSignals: signals });
      await m.getRepository(ClientFormula).save({
        tenantId: 'acme', clientEquipmentClassSlug: CLASS, formulaKey: 'avg_coolant', kind: 'empirical', expression,
        compiledPlan: c.plan as never, compiledAt: NOW, compilerVersion: c.compilerVersion, resultUnit: c.resultUnit,
        requiredSignals: c.requiredSignals, requiredParameters: [], bindings: [], resultKind: c.resultKind,
        displayUnit: null, displayFormat: 'number:1', targetValue: null, targetMin: null, targetMax: null,
        targetDirection: 'none', comparisonBasis: 'none', aggregationWindow: '24h', chartType: 'none',
        templateVersion: 1, copiedAt: NOW, status: 'active', updatedBy: 'u-master',
      });
      await m.getRepository(ClientEquipmentClassLayout).save([
        { key: 'coolant', type: 'kpi_number', boundTo: 'avg_coolant' },
        { key: 'readiness', type: 'readiness_list', boundTo: null },
        { key: 'chart', type: 'signal_chart', boundTo: SIGNAL },
      ].map((w, i) => ({
        tenantId: 'acme', clientEquipmentClassSlug: CLASS, widgetType: w.type as never, widgetKey: w.key,
        boundTo: w.boundTo, title: null, position: i + 1, size: 'medium' as const, hidden: false,
        positionCustom: false, templateVersion: 1, copiedAt: NOW,
      })));
    });
  };

  const seedMachine = (externalId: string) => fixture((m) => m.getRepository(EquipmentProfile).save({
    tenantId: 'acme', sourceSystem: SS, externalId, equipmentClassSlug: CLASS, classVersion: 1,
    tier: 'standard', commissionedAt: null, serviceIntervalHours: null, readiness: {}, updatedBy: 'u',
    plantId: null, name: `Machine ${externalId}`,
  }));

  /** Where 1.0 thinks the device is. */
  const seedProjection = (imei: string, externalId: string) => fixture((m) => m.getRepository(DeviceProjection).save({
    sourceSystem: SS, externalId: `dev-${imei}`, tenantId: 'acme', payload: {}, sourceUpdatedAt: null,
    syncedAt: NOW, checksum: 'c', status: 'live', imei, equipmentExternalId: externalId, name: null,
  }));

  /** Where the customer claimed it. */
  const seedInventory = (imei: string, externalId: string) => owner.query(
    `INSERT INTO device_inventory (imei, tenant_id, state, equipment_external_id, claimed_at) VALUES ($1, 'acme', 'assigned', $2, $3)`,
    [imei, externalId, NOW],
  );

  const seedBinding = (externalId: string, imei: string, validFrom: Date, validTo: Date | null = null) =>
    fixture((m) => m.getRepository(SignalBindingVersion).save({
      tenantId: 'acme', sourceSystem: SS, externalId, signalKey: SIGNAL, measurementRole: SIGNAL,
      componentId: '', origin: 'physical', imei, channel: SIGNAL, sensorInstanceId: null,
      canonicalUnit: UNIT, sourceUnit: null, validFrom, validTo,
      // Twelve hours, so two readings cover a 24h window: coverage is not what these
      // tests are about, and the default 5-minute period would make every KPI
      // `insufficient_coverage` before the device question is ever asked.
      expectedPeriodSeconds: 12 * 3600, isPrimary: true, status: 'active',
      discoveredFrom: null, discoveredBy: 'manual', approvedBy: 'u', approvedAt: NOW,
    }));

  const seedReadings = (imei: string, value: number, ats: Date[]) => fixture((m) => m.getRepository(TelemetryReading).save(
    ats.map((sourceTimestamp) => ({
      tenantId: 'acme', imei, signal: SIGNAL, value, unit: UNIT, sourceTimestamp, receivedAt: sourceTimestamp, source: 'live' as const,
    })),
  ));

  const ago = (ms: number, from = NOW) => new Date(from.getTime() - ms);
  const ref = (externalId: string) => ({ sourceSystem: SS, externalId });

  const page = async (externalId: string, at = NOW) => {
    const widgets = (await pages.machinePage(acme, ref(externalId), at)).widgets;
    const byKey = (k: string) => widgets.find((w) => w.widgetKey === k)!;
    return {
      kpi: byKey('coolant'),
      readiness: (byKey('readiness').data as ReadinessRow[]).find((r) => r.signal === SIGNAL)!,
      chart: byKey('chart'),
    };
  };

  // ============================================================ the reads
  it('1. the KPI reads telemetry from the binding\'s device, not the projection\'s', async () => {
    await seedMachine('M-1');
    await seedProjection('IMEI-PROJ', 'M-1');
    await seedBinding('M-1', 'IMEI-BOUND', new Date('2026-01-01'));
    // The projection's device reports a different number, and more recently — if the
    // evaluator read it, the average would move.
    await seedReadings('IMEI-PROJ', 10, [ago(5 * MINUTE), ago(2 * MINUTE)]);
    await seedReadings('IMEI-BOUND', 50, [ago(10 * MINUTE), ago(8 * MINUTE)]);

    const envelope = await evaluator.evaluateOne(acme, ref('M-1'), 'avg_coolant', NOW);
    expect(envelope).toMatchObject({ readiness: 'ready', value: 50 });
  });

  it('2. coverage reads freshness from the binding\'s device, not the inventory\'s', async () => {
    await seedMachine('M-1');
    await seedInventory('IMEI-INV', 'M-1');
    await seedBinding('M-1', 'IMEI-BOUND', new Date('2026-01-01'));
    await seedReadings('IMEI-INV', 10, [ago(1 * MINUTE)]);
    await seedReadings('IMEI-BOUND', 50, [ago(7 * MINUTE)]);

    const coverage = await bindings.coverage(acme, ref('M-1'), NOW);
    expect(coverage.missing).toEqual([]);
    expect(coverage.covered).toEqual([expect.objectContaining({
      measurementRole: SIGNAL, lastReadingAt: ago(7 * MINUTE).toISOString(),
    })]);
  });

  it('3. the page no longer contradicts itself: kpi_number and readiness_list agree on a machine in one device table only', async () => {
    // The defect itself. M-PROJ is known to 1.0 only (QONBOARD1 has not run): the old
    // evaluator found its device, the old coverage did not, and the page showed the KPI
    // ready beside its own signal reporting `no_readings`. M-INV is the mirror case.
    await seedMachine('M-PROJ');
    await seedProjection('IMEI-P', 'M-PROJ');
    await seedBinding('M-PROJ', 'IMEI-P', new Date('2026-01-01'));
    await seedReadings('IMEI-P', 70, [ago(6 * MINUTE), ago(3 * MINUTE)]);

    await seedMachine('M-INV');
    await seedInventory('IMEI-I', 'M-INV');
    await seedBinding('M-INV', 'IMEI-I', new Date('2026-01-01'));
    await seedReadings('IMEI-I', 90, [ago(6 * MINUTE), ago(3 * MINUTE)]);

    for (const [machine, value] of [['M-PROJ', 70], ['M-INV', 90]] as const) {
      const { kpi, readiness, chart } = await page(machine);
      expect({ machine, kpi: kpi.readiness, signal: readiness.readiness, chart: chart.readiness })
        .toEqual({ machine, kpi: 'ready', signal: 'ready', chart: 'ready' });
      expect(kpi.data).toMatchObject({ value });
      expect(readiness.lastReadingAt).toBe(ago(3 * MINUTE).toISOString());
    }
  });

  it('4. a device moved between machines: each part of the window goes to the machine that held it', async () => {
    // One device, on A until T, then on B. Both device tables now say B — they only
    // ever hold the current link — so neither can say A had it this morning.
    const T = ago(1 * HOUR);
    const at = new Date(T.getTime() + 10 * MINUTE);
    await seedMachine('M-A');
    await seedMachine('M-B');
    await seedProjection('IMEI-D', 'M-B');
    await seedInventory('IMEI-D', 'M-B');
    await seedBinding('M-A', 'IMEI-D', new Date('2026-01-01'), T);
    await seedBinding('M-B', 'IMEI-D', T);
    await seedReadings('IMEI-D', 10, [ago(20 * MINUTE, T), ago(5 * MINUTE, T)]);
    await seedReadings('IMEI-D', 30, [new Date(T.getTime() + 2 * MINUTE), new Date(T.getTime() + 6 * MINUTE)]);

    // The 24h window spans T for both machines.
    const a = await evaluator.evaluateOne(acme, ref('M-A'), 'avg_coolant', at);
    const b = await evaluator.evaluateOne(acme, ref('M-B'), 'avg_coolant', at);
    // A device-table read would give B all four readings (20) and A none.
    expect(a).toMatchObject({ readiness: 'ready', value: 10 });
    expect(b).toMatchObject({ readiness: 'ready', value: 30 });

    // The chart draws the same split: A's points stop at T, B's start there.
    const pointsOf = async (machine: string) => ((await page(machine, at)).chart.data as SignalChartData).points
      .filter((p) => p.v !== null).map((p) => ({ t: new Date(p.t).getTime(), v: p.v }));
    const aPoints = await pointsOf('M-A');
    const bPoints = await pointsOf('M-B');
    expect(aPoints.length).toBeGreaterThan(0);
    expect(bPoints.length).toBeGreaterThan(0);
    expect(aPoints.every((p) => p.v === 10 && p.t < T.getTime())).toBe(true);
    expect(bPoints.every((p) => p.v === 30)).toBe(true);
  });

  // ======================================================== unbound, unchanged
  it('5. no binding at all: not_configured / unbound, on every widget', async () => {
    await seedMachine('M-1');
    // Both device tables say a device is here and it is reporting. Without a binding
    // that is still nothing this machine can claim.
    await seedProjection('IMEI-1', 'M-1');
    await seedInventory('IMEI-1', 'M-1');
    await seedReadings('IMEI-1', 80, [ago(2 * MINUTE)]);

    expect(await evaluator.evaluateOne(acme, ref('M-1'), 'avg_coolant', NOW))
      .toMatchObject({ readiness: 'not_configured', reason: 'unbound', value: null });
    const { readiness, chart } = await page('M-1');
    expect(readiness).toMatchObject({ readiness: 'not_configured', reason: 'unbound' });
    expect(chart).toMatchObject({ readiness: 'not_configured', reason: 'unbound', data: null });
  });

  it('6. a binding closed before the window, with no replacement: unbound, not a read from the departed device', async () => {
    // "Bound for a window" means a binding was in force at some point in it (that is
    // what case 4 needs). This binding closed 30h ago — before the 24h window opened —
    // so nothing in the window was produced on this machine.
    await seedMachine('M-1');
    await seedProjection('IMEI-OLD', 'M-1');
    await seedInventory('IMEI-OLD', 'M-1');
    await seedBinding('M-1', 'IMEI-OLD', new Date('2026-01-01'), ago(30 * HOUR));
    await seedReadings('IMEI-OLD', 80, [ago(31 * HOUR), ago(2 * MINUTE)]);

    expect(await evaluator.evaluateOne(acme, ref('M-1'), 'avg_coolant', NOW))
      .toMatchObject({ readiness: 'not_configured', reason: 'unbound', value: null });
    const coverage = await bindings.coverage(acme, ref('M-1'), NOW);
    expect(coverage.missing).toEqual([expect.objectContaining({ measurementRole: SIGNAL, reason: 'unbound' })]);
    const { readiness, chart } = await page('M-1');
    expect(readiness).toMatchObject({ readiness: 'not_configured', reason: 'unbound' });
    expect(chart).toMatchObject({ readiness: 'not_configured', reason: 'unbound', data: null });
  });

  // ==================================================== the legacy pull stays
  it('8. the legacy telemetry pull still finds sensors by projection IMEI', async () => {
    // It asks 1.0 a question about 1.0, so 1.0's own idea of where a device is stays
    // the right input — this task must not have moved it onto the binding.
    await seedMachine('M-1');
    await seedProjection('IMEI-PROJ', 'M-1');
    await seedInventory('IMEI-INV', 'M-1');
    await seedBinding('M-1', 'IMEI-BOUND', new Date('2026-01-01'));
    await fixture((m) => m.getRepository(SensorMapProjection).save(['IMEI-PROJ', 'IMEI-INV', 'IMEI-BOUND'].map((imei) => ({
      sourceSystem: SS, externalId: `sensor-${imei}`, tenantId: 'acme', payload: {}, sourceUpdatedAt: null,
      syncedAt: NOW, checksum: 'c', status: 'live', imei, signal: SIGNAL, sensorName: null, unit: UNIT,
    }))));

    const reader = new LegacyTelemetryReader(owner, null);
    const request = { tenantId: 'acme', sourceSystem: SS, externalId: 'M-1' };
    const map: Map<string, { imei: string }> = await (reader as any).sensorMapFor(request);
    expect([...map.values()].map((s) => s.imei)).toEqual(['IMEI-PROJ']);
    expect(await (reader as any).hasDevices(request)).toBe(true);
  });

  // ============================================== the CHECK on inventory state
  describe('device_inventory.state', () => {
    const MIGRATION = 'InventoryStateCheck1758650000000';
    // Read from the transition table, not retyped: every state a transition starts
    // from or moves to is the vocabulary the CHECK must accept.
    const VOCABULARY = [...new Set(Object.values(INVENTORY_TRANSITIONS).flatMap((t) =>
      [...t.from, ...(t.to === 'same' ? [] : [t.to])]))].sort();

    const insert = (imei: string, state: string) =>
      owner.query(`INSERT INTO device_inventory (imei, tenant_id, state) VALUES ($1, NULL, $2)`, [imei, state]);

    it('7. a state outside the vocabulary is refused by the CHECK; every state in it is accepted', async () => {
      expect(VOCABULARY).toEqual(['assigned', 'in-stock', 'retired']);
      for (const state of VOCABULARY) await insert(`IMEI-${state}`, state);
      await expect(insert('IMEI-claimed', 'claimed')).rejects.toThrow(/ck_device_inventory_state/);
      await expect(owner.query(`UPDATE device_inventory SET state = 'lost' WHERE imei = 'IMEI-in-stock'`))
        .rejects.toThrow(/ck_device_inventory_state/);
    });

    it('seeded before it runs: valid rows pass, a stray value stops the migration and is named', async () => {
      await undoMigrationNamed(owner, MIGRATION);
      try {
        for (const state of VOCABULARY) await insert(`IMEI-${state}`, state);
        await insert('IMEI-stray', 'claimed');
        await expect(owner.runMigrations({ transaction: 'all' })).rejects.toThrow(/"claimed" \(1\)/);

        await owner.query(`DELETE FROM device_inventory WHERE imei = 'IMEI-stray'`);
        await owner.runMigrations({ transaction: 'all' });
        expect(await owner.query(`SELECT count(*)::int AS n FROM device_inventory`)).toEqual([{ n: VOCABULARY.length }]);
        await expect(insert('IMEI-claimed', 'claimed')).rejects.toThrow(/ck_device_inventory_state/);
      } finally {
        await owner.runMigrations({ transaction: 'all' });
      }
    });

    it(`down path (${MIGRATION}): the CHECK is gone and the rows are untouched`, async () => {
      await insert('IMEI-kept', 'assigned');
      await undoMigrationNamed(owner, MIGRATION);
      try {
        await insert('IMEI-claimed', 'claimed');
        expect(await owner.query(`SELECT imei, state FROM device_inventory ORDER BY imei`))
          .toEqual([{ imei: 'IMEI-claimed', state: 'claimed' }, { imei: 'IMEI-kept', state: 'assigned' }]);
        await owner.query(`DELETE FROM device_inventory WHERE imei = 'IMEI-claimed'`);
      } finally {
        await owner.runMigrations({ transaction: 'all' });
      }
    });
  });
});
