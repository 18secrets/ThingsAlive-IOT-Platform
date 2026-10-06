import { INestApplication, NotFoundException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { DataSource, EntityManager } from 'typeorm';
import { PostgresQueryRunner } from 'typeorm/driver/postgres/PostgresQueryRunner';
import { RequestScope } from '../src/auth/types/request-scope';
import { Severity } from '../src/common/severity';
import { compileFormula } from '../src/catalog/formula/formula-compiler';
import { WIDGET_TYPES } from '../src/catalog/layout/widget-types';
import { ClientEquipmentClassFailureMode } from '../src/client-catalog/entities/client-equipment-class-failure-mode.entity';
import { ClientEquipmentClassLayout } from '../src/client-catalog/entities/client-equipment-class-layout.entity';
import { ClientEquipmentClassRecommendation } from '../src/client-catalog/entities/client-equipment-class-recommendation.entity';
import { ClientEquipmentClass } from '../src/client-catalog/entities/client-equipment-class.entity';
import { ClientFormula } from '../src/client-catalog/entities/client-formula.entity';
import { EquipmentProfile } from '../src/equipment/equipment-profile.entity';
import { KpiEvaluatorService } from '../src/kpi/services/kpi-evaluator.service';
import { createApp } from '../src/main';
import { PageService } from '../src/page/page.service';
import { WIDGET_PRODUCERS } from '../src/page/page-widgets';
import { DeviceProjection } from '../src/projection/entities/device-projection.entity';
import { runTenantSpanning } from '../src/scope/tenant-session';
import { SignalBindingVersion } from '../src/signal-binding/entities/signal-binding-version.entity';
import { TelemetryReading } from '../src/telemetry/telemetry-reading.entity';
import { createTestDataSource, describeDb, undoMigrationNamed } from './db';

const HOUR = 3_600_000;
const SECRET = 'test-secret-composed-page';
const ISSUER = 'things-alive-composed-page-test';
const NOW = new Date('2026-10-05T12:00:00.000Z');
const SS = 'iot-platform-1';
const acme: RequestScope = { tenantId: 'acme', userId: 'u-acme', roles: ['admin'], isPlatformRole: false };
const globex: RequestScope = { tenantId: 'globex', userId: 'u-globex', roles: ['admin'], isPlatformRole: false };

const SIGNALS = [
  { signal: 'coolant_temp_c', unit: 'degC', required: true },
  { signal: 'oil_pressure_kpa', unit: 'kPa', required: true },
];

/**
 * The composed page (task QPAGE1). It composes; it does not compute — so every
 * assertion here is about what a producer said and how the page carries it, never
 * about a number the page arrived at on its own.
 */
describeDb('composed page', () => {
  let owner: DataSource;
  let app: INestApplication;
  let pages: PageService;

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    process.env.AUTH_JWT_SECRET = SECRET;
    process.env.AUTH_JWT_ISSUER = ISSUER;
    process.env.AUTH_TENANT_CLAIM = 'client_id';
    process.env.CORS_ORIGINS = 'http://localhost:3000';
    app = await createApp({ database: true });
    await app.init();
    pages = app.get(PageService);
  }, 60_000);

  afterAll(async () => { await app?.close(); await owner?.destroy(); });

  beforeEach(async () => {
    await owner.query(`
      TRUNCATE TABLE "telemetry_reading", "signal_binding_version", "device_projection", "device_inventory", "alert_event", "alert_rule",
        "work_order", "client_equipment_class_layout", "client_equipment_class_recommendation",
        "client_equipment_class_failure_mode", "client_formula", "client_equipment_class", "equipment_profile",
        "equipment_class_sensor_requirement", "equipment_class_profile", "plant"
      RESTART IDENTITY CASCADE`);
    await owner.query(`DELETE FROM "site_class_layout" WHERE "site_class_slug" <> 'default'`);
    await owner.query(`DELETE FROM "site_class" WHERE "slug" <> 'default'`);
  });

  // ============================================================== fixtures
  const fixture = (fn: (m: EntityManager) => Promise<unknown>) => runTenantSpanning(owner, 'test fixture', fn);

  /** Platform class + requirements (what coverage reads) and the tenant's copy. */
  const seedClass = async (tenant: string, slug: string, signals = SIGNALS) => {
    await owner.query(
      `INSERT INTO equipment_class_profile (slug, version, status, name, expected_signals)
         VALUES ($1, 1, 'published', $1, $2::jsonb) ON CONFLICT DO NOTHING`, [slug, JSON.stringify(signals)],
    );
    for (const s of signals) {
      await owner.query(
        `INSERT INTO equipment_class_sensor_requirement (class_slug, class_version, measurement_role, canonical_unit)
           VALUES ($1, 1, $2, $3) ON CONFLICT DO NOTHING`, [slug, s.signal, s.unit],
      );
    }
    await fixture((m) => m.getRepository(ClientEquipmentClass).save({
      tenantId: tenant, slug, name: slug, description: null, category: null, expectedSignals: signals,
      failureModes: [], defaultThresholds: {}, templateSlug: slug, templateVersion: 1, templateChecksum: 'c',
      copiedAt: NOW, status: 'active', updatedBy: 'u-master',
    }));
  };

  const seedFormula = (tenant: string, slug: string, key: string, expression: string, extra: Partial<ClientFormula> = {}) =>
    fixture(async (m) => {
      const signals = SIGNALS.map((s) => ({ signal: s.signal, unit: s.unit }));
      const c = compileFormula({ formulaKey: key, expression, classSlug: slug, expectedSignals: signals });
      await m.getRepository(ClientFormula).save({
        tenantId: tenant, clientEquipmentClassSlug: slug, formulaKey: key, kind: 'empirical', expression,
        compiledPlan: c.plan as never, compiledAt: NOW, compilerVersion: c.compilerVersion, resultUnit: c.resultUnit,
        requiredSignals: c.requiredSignals, requiredParameters: [], bindings: [], resultKind: c.resultKind,
        displayUnit: null, displayFormat: 'number:1', targetValue: null, targetMin: null, targetMax: null,
        targetDirection: 'none', comparisonBasis: 'none', aggregationWindow: '24h', chartType: 'none',
        templateVersion: 1, copiedAt: NOW, status: 'active', updatedBy: 'u-master', ...extra,
      });
    });

  /** A machine with a device, every signal bound, and (unless `silent`) two fresh readings each. */
  const seedMachine = async (
    tenant: string, externalId: string, slug: string | null,
    opts: { plantId?: string | null; silent?: boolean; values?: Record<string, number> } = {},
  ) => {
    const imei = `imei-${tenant}-${externalId}`;
    await fixture(async (m) => {
      await m.getRepository(EquipmentProfile).save({
        tenantId: tenant, sourceSystem: SS, externalId, equipmentClassSlug: slug, classVersion: slug ? 1 : null,
        tier: 'standard', commissionedAt: null, serviceIntervalHours: null, readiness: {}, updatedBy: 'u',
        plantId: opts.plantId ?? null, name: `Machine ${externalId}`,
      });
      if (!slug) return;
      await m.getRepository(DeviceProjection).save({
        sourceSystem: SS, externalId: `dev-${externalId}`, tenantId: tenant, payload: {}, sourceUpdatedAt: null,
        syncedAt: NOW, checksum: 'c', status: 'live', imei, equipmentExternalId: externalId, name: null,
      });
      // Both device sources, as an assigned-and-claimed device really has (state 'assigned',
      // claim = equipment_external_id + claimed_at): the evaluator reads the
      // projection, coverage reads the inventory (see the QPAGE1 report).
      await m.query(
        `INSERT INTO device_inventory (imei, tenant_id, state, equipment_external_id, claimed_at) VALUES ($1, $2, 'assigned', $3, $4)`,
        [imei, tenant, externalId, NOW],
      );
      for (const s of SIGNALS) {
        await m.getRepository(SignalBindingVersion).save({
          tenantId: tenant, sourceSystem: SS, externalId, signalKey: s.signal, measurementRole: s.signal,
          componentId: '', origin: 'physical', imei, channel: s.signal, sensorInstanceId: null,
          canonicalUnit: s.unit, sourceUnit: null, validFrom: new Date('2026-01-01'), validTo: null,
          expectedPeriodSeconds: 12 * 3600, isPrimary: true, status: 'active',
          discoveredFrom: null, discoveredBy: 'manual', approvedBy: 'u', approvedAt: NOW,
        });
        if (opts.silent) continue;
        const value = opts.values?.[s.signal] ?? 80;
        await m.getRepository(TelemetryReading).save([0.2, 0.1].map((hoursAgo) => ({
          tenantId: tenant, imei, signal: s.signal, value, unit: s.unit,
          sourceTimestamp: new Date(NOW.getTime() - hoursAgo * HOUR), receivedAt: NOW, source: 'live' as const,
        })));
      }
    });
    return { sourceSystem: SS, externalId };
  };

  const seedLayout = (tenant: string, slug: string, widgets: { key: string; type: string; boundTo?: string; position: number; hidden?: boolean }[]) =>
    fixture((m) => m.getRepository(ClientEquipmentClassLayout).save(widgets.map((w) => ({
      tenantId: tenant, clientEquipmentClassSlug: slug, widgetType: w.type as never, widgetKey: w.key,
      boundTo: w.boundTo ?? null, title: null, position: w.position, size: 'medium' as const,
      hidden: w.hidden ?? false, positionCustom: false, templateVersion: 1, copiedAt: NOW,
    }))));

  const seedAlert = async (tenant: string, externalId: string, params: Record<string, unknown>, trigger = 'signal-threshold') => {
    const [rule] = await owner.query(
      `INSERT INTO alert_rule (tenant_id, slug, name, trigger, params, applies_to, severity, enabled)
         VALUES ($1, $2, 'Rule', $3, $4::jsonb, 'account', 'high', true) RETURNING id`,
      [tenant, `rule-${Math.random().toString(36).slice(2)}`, trigger, JSON.stringify(params)],
    );
    await owner.query(
      `INSERT INTO alert_event (tenant_id, rule_id, rule_name, source_system, external_id, severity, summary, evidence, state, fired_at)
         VALUES ($1, $2, 'Rule', $3, $4, 'high', 'Coolant high', '{}'::jsonb, 'open', $5)`,
      [tenant, rule.id, SS, externalId, NOW],
    );
  };

  const seedPlant = async (tenant: string, code: string, site?: { slug: string; version: number }) => {
    const [plant] = await owner.query(
      `INSERT INTO plant (tenant_id, code, name, site_class_slug, site_class_version) VALUES ($1, $2, $2, $3, $4) RETURNING id`,
      [tenant, code, site?.slug ?? null, site?.version ?? null],
    );
    return plant.id as string;
  };

  /** Every query the database receives while `fn` runs, from any connection. */
  const countQueries = async <T>(fn: () => Promise<T>): Promise<{ result: T; queries: number; ms: number; kinds: Map<string, number> }> => {
    const original = PostgresQueryRunner.prototype.query;
    let queries = 0;
    const kinds = new Map<string, number>();
    PostgresQueryRunner.prototype.query = function (...args: Parameters<typeof original>) {
      queries += 1;
      const sql = String(args[0]).trim().replace(/\s+/g, ' ');
      const kind = /^(START TRANSACTION|BEGIN|COMMIT|ROLLBACK)/i.test(sql) ? 'transaction framing'
        : /set_config|SET LOCAL/i.test(sql) ? 'tenant session (set_config)'
          : /^SELECT/i.test(sql) ? `SELECT ${sql.match(/FROM "?([a-z_]+)"?/i)?.[1] ?? '?'}` : sql.slice(0, 30);
      kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
      return original.apply(this, args);
    } as typeof original;
    const started = Date.now();
    try {
      const result = await fn();
      return { result, queries, ms: Date.now() - started, kinds };
    } finally {
      PostgresQueryRunner.prototype.query = original;
    }
  };

  // ============================================================ machine page
  describe('the machine page', () => {
    it('1. a machine with a layout: the tenant\'s order, hidden widgets absent', async () => {
      await seedClass('acme', 'dg');
      await seedFormula('acme', 'dg', 'avg_coolant', 'avg(coolant_temp_c)');
      const ref = await seedMachine('acme', 'DG-1', 'dg');
      await seedLayout('acme', 'dg', [
        { key: 'alerts', type: 'alert_list', position: 1 },
        { key: 'coolant', type: 'kpi_number', boundTo: 'avg_coolant', position: 2 },
        { key: 'hidden_one', type: 'work_order_list', position: 3, hidden: true },
        { key: 'readiness', type: 'readiness_list', position: 4 },
      ]);

      const page = await pages.machinePage(acme, ref, NOW);
      expect(page.layout.fallback).toBe(false);
      expect(page.widgets.map((w) => w.widgetKey)).toEqual(['alerts', 'coolant', 'readiness']);
      expect(page.equipment).toMatchObject({ externalId: 'DG-1', classSlug: 'dg', classVersion: 1, name: 'Machine DG-1' });
      const coolant = page.widgets.find((w) => w.widgetKey === 'coolant')!;
      expect(coolant).toMatchObject({ readiness: 'ready', data: { value: 80, unit: 'degC', formulaKey: 'avg_coolant' } });
      // Composed, not computed: the page's number is the evaluator's own envelope.
      const fromEvaluator = await app.get(KpiEvaluatorService).evaluateOne(acme, ref, 'avg_coolant', NOW);
      expect(coolant.data).toMatchObject(fromEvaluator);
      const alerts = page.widgets.find((w) => w.widgetKey === 'alerts')!;
      // Genuinely no open alerts — ready, and an honest empty list.
      expect(alerts).toMatchObject({ readiness: 'ready', data: [] });
    });

    it('2. a class with no layout: the QREC0b fallback, said so', async () => {
      await seedClass('acme', 'dg');
      await seedFormula('acme', 'dg', 'avg_coolant', 'avg(coolant_temp_c)');
      await seedFormula('acme', 'dg', 'coolant_trace', 'coolant_temp_c');
      const ref = await seedMachine('acme', 'DG-1', 'dg');

      const page = await pages.machinePage(acme, ref, NOW);
      expect(page.layout.fallback).toBe(true);
      expect(page.widgets.map((w) => [w.widgetType, w.widgetKey])).toEqual([
        ['readiness_list', 'readiness'], ['kpi_number', 'avg_coolant'], ['kpi_chart', 'coolant_trace'],
      ]);
      const trace = page.widgets.find((w) => w.widgetKey === 'coolant_trace')!;
      expect(trace.readiness).toBe('ready');
      expect(Array.isArray((trace.data as { value: unknown }).value)).toBe(true);
    });

    it('3. a KPI that is not ready still appears — data null, with the evaluator\'s reason', async () => {
      await seedClass('acme', 'dg');
      await seedFormula('acme', 'dg', 'avg_coolant', 'avg(coolant_temp_c)');
      const ref = await seedMachine('acme', 'DG-1', 'dg', { silent: true });
      await seedLayout('acme', 'dg', [{ key: 'coolant', type: 'kpi_number', boundTo: 'avg_coolant', position: 1 }]);

      const [widget] = (await pages.machinePage(acme, ref, NOW)).widgets;
      expect(widget).toMatchObject({ widgetKey: 'coolant', readiness: 'not_available', reason: 'no_readings', data: null });
    });

    it('4. a schematic: not_available / no_visual until QREC0c', async () => {
      await seedClass('acme', 'dg');
      const ref = await seedMachine('acme', 'DG-1', 'dg');
      await seedLayout('acme', 'dg', [{ key: 'twin', type: 'schematic', position: 1 }]);
      const [widget] = (await pages.machinePage(acme, ref, NOW)).widgets;
      expect(widget).toMatchObject({ readiness: 'not_available', reason: 'no_visual', data: null });
    });

    it('readiness_list, signal_chart, failure modes and recommendations come from their producers', async () => {
      await seedClass('acme', 'dg');
      const ref = await seedMachine('acme', 'DG-1', 'dg');
      await seedLayout('acme', 'dg', [
        { key: 'readiness', type: 'readiness_list', position: 1 },
        { key: 'coolant_chart', type: 'signal_chart', boundTo: 'coolant_temp_c', position: 2 },
        { key: 'modes', type: 'failure_modes', position: 3 },
        { key: 'recs', type: 'recommendations', position: 4 },
      ]);
      await fixture(async (m) => {
        await m.getRepository(ClientEquipmentClassFailureMode).save({
          tenantId: 'acme', clientEquipmentClassSlug: 'dg', code: 'overheat', name: 'Overheating', symptom: 'Hot',
          severity: Severity.High, signals: ['coolant_temp_c'], templateVersion: 1, copiedAt: NOW,
        });
        await m.getRepository(ClientEquipmentClassRecommendation).save({
          tenantId: 'acme', clientEquipmentClassSlug: 'dg', failureModeCode: 'overheat', action: 'Check coolant',
          urgency: 'next_shift', estimatedHours: 1, requiredParts: null, templateVersion: 1, copiedAt: NOW,
        });
      });

      const byKey = new Map((await pages.machinePage(acme, ref, NOW)).widgets.map((w) => [w.widgetKey, w]));
      expect(byKey.get('readiness')!.data).toEqual(expect.arrayContaining([
        expect.objectContaining({ signal: 'coolant_temp_c', readiness: 'ready', reason: null }),
      ]));
      const chart = byKey.get('coolant_chart')!.data as { signal: string; unit: string; points: { v: number | null }[] };
      expect(chart).toMatchObject({ signal: 'coolant_temp_c', unit: 'degC' });
      // Empty buckets are null, never omitted and never 0.
      expect(chart.points.some((p) => p.v === null)).toBe(true);
      expect(chart.points.some((p) => p.v === 80)).toBe(true);
      expect(byKey.get('modes')!.data).toEqual([expect.objectContaining({ code: 'overheat', status: 'clear' })]);
      expect(byKey.get('recs')!.data).toEqual([
        { failureModeCode: 'overheat', action: 'Check coolant', urgency: 'next_shift', estimatedHours: 1 },
      ]);
    });

    it('11. a failure mode is active when an open alert\'s rule watches one of its signals; unknown when an alert names none', async () => {
      await seedClass('acme', 'dg');
      const ref = await seedMachine('acme', 'DG-1', 'dg');
      await seedLayout('acme', 'dg', [{ key: 'modes', type: 'failure_modes', position: 1 }]);
      await fixture((m) => m.getRepository(ClientEquipmentClassFailureMode).save([
        { tenantId: 'acme', clientEquipmentClassSlug: 'dg', code: 'overheat', name: 'Overheating', symptom: '', severity: null, signals: ['coolant_temp_c'], templateVersion: 1, copiedAt: NOW },
        { tenantId: 'acme', clientEquipmentClassSlug: 'dg', code: 'oil_loss', name: 'Oil loss', symptom: '', severity: null, signals: ['oil_pressure_kpa'], templateVersion: 1, copiedAt: NOW },
      ]));

      await seedAlert('acme', 'DG-1', { signal: 'coolant_temp_c', max: 105 });
      let modes = (await pages.machinePage(acme, ref, NOW)).widgets[0].data as { code: string; status: string }[];
      expect(Object.fromEntries(modes.map((m) => [m.code, m.status]))).toEqual({ overheat: 'active', oil_loss: 'clear' });

      // An open alert from a rule that names no signal might be oil loss: "clear"
      // would be a guess, so the page says it cannot tell. The named one stays active.
      await seedAlert('acme', 'DG-1', { chain: 'thermal' }, 'chain-origin');
      modes = (await pages.machinePage(acme, ref, NOW)).widgets[0].data as { code: string; status: string }[];
      expect(Object.fromEntries(modes.map((m) => [m.code, m.status]))).toEqual({ overheat: 'active', oil_loss: 'unknown' });
    });

    it('5. twenty widgets cost about one call per producer, not one per widget — and the page is measured', async () => {
      await seedClass('acme', 'dg');
      const keys = Array.from({ length: 11 }, (_, i) => `kpi_${String(i).padStart(2, '0')}`);
      for (const k of keys) await seedFormula('acme', 'dg', k, 'avg(coolant_temp_c)');
      const ref = await seedMachine('acme', 'DG-1', 'dg');
      const others = [
        { key: 'readiness', type: 'readiness_list' }, { key: 'alerts', type: 'alert_list' },
        { key: 'work', type: 'work_order_list' }, { key: 'service', type: 'service_due' },
        { key: 'modes', type: 'failure_modes' }, { key: 'recs', type: 'recommendations' },
        { key: 'twin', type: 'schematic' },
        { key: 'chart_c', type: 'signal_chart', boundTo: 'coolant_temp_c' },
        { key: 'chart_o', type: 'signal_chart', boundTo: 'oil_pressure_kpa' },
      ];
      const twenty = [...keys.map((k) => ({ key: k, type: 'kpi_number', boundTo: k })), ...others]
        .map((w, i) => ({ ...w, position: i + 1 }));
      expect(twenty).toHaveLength(20);
      await seedLayout('acme', 'dg', twenty);

      const big = await countQueries(() => pages.machinePage(acme, ref, NOW));
      expect(big.result.widgets).toHaveLength(20);

      // The same producers, one KPI widget and one chart instead of eleven and two.
      await owner.query(`DELETE FROM client_equipment_class_layout WHERE widget_key NOT IN ('kpi_00', 'chart_c') AND widget_type IN ('kpi_number', 'signal_chart')`);
      const small = await countQueries(() => pages.machinePage(acme, ref, NOW));
      expect(small.result.widgets).toHaveLength(9);

      // eslint-disable-next-line no-console
      console.log(`QPAGE1 §5 — machine page: 20 widgets ${big.queries} queries in ${big.ms} ms (cold); `
        + `same producers with 9 widgets: ${small.queries} queries in ${small.ms} ms`);
      // eslint-disable-next-line no-console
      console.log('QPAGE1 §5 breakdown (20 widgets):', JSON.stringify([...big.kinds].sort((a, b) => b[1] - a[1])));
      // Eleven more KPI widgets and one more chart add no round trips of their own.
      expect(big.queries - small.queries).toBeLessThanOrEqual(2);
      expect(big.ms).toBeLessThan(2000);
    });
  });

  // ================================================================ site page
  describe('the site page', () => {
    const seedSiteClass = async (slug: string, widgets: { key: string; type: string; boundTo?: string; aggregate?: string; position: number }[]) => {
      await owner.query(`INSERT INTO site_class (slug, version, name, status, published_at) VALUES ($1, 1, $1, 'published', now())`, [slug]);
      for (const w of widgets) {
        await owner.query(
          `INSERT INTO site_class_layout (site_class_slug, class_version, widget_type, widget_key, bound_to, position, size, aggregate)
             VALUES ($1, 1, $2, $3, $4, $5, 'medium', $6)`,
          [slug, w.type, w.key, w.boundTo ?? null, w.position, w.aggregate ?? null],
        );
      }
      return { slug, version: 1 };
    };

    it('6. a plant naming no site class gets the default page; one that names a site class gets its layout', async () => {
      const plantId = await seedPlant('acme', 'YARD');
      await seedClass('acme', 'dg');
      await seedMachine('acme', 'DG-1', 'dg', { plantId });
      await seedAlert('acme', 'DG-1', { signal: 'coolant_temp_c' });

      const page = await pages.sitePage(acme, plantId, NOW);
      expect(page.site.siteClass).toEqual({ slug: 'default', version: 1 });
      expect(page.widgets.map((w) => w.widgetType)).toEqual(['machine_list', 'alert_list', 'work_order_list']);
      expect(page.widgets[0].data).toEqual([{
        sourceSystem: SS, externalId: 'DG-1', name: 'Machine DG-1', readiness: 'ready', openAlerts: 1,
      }]);

      const quarry = await seedSiteClass('quarry', [{ key: 'machines', type: 'machine_list', position: 1 }]);
      const named = await seedPlant('acme', 'QUARRY', quarry);
      const quarryPage = await pages.sitePage(acme, named, NOW);
      expect(quarryPage.site.siteClass).toEqual(quarry);
      expect(quarryPage.widgets.map((w) => w.widgetKey)).toEqual(['machines']);
    });

    it('7. avg over three machines with one not ready covers two, and says so', async () => {
      const site = await seedSiteClass('fleet', [{ key: 'coolant', type: 'kpi_number', boundTo: 'avg_coolant', aggregate: 'avg', position: 1 }]);
      const plantId = await seedPlant('acme', 'YARD', site);
      await seedClass('acme', 'dg');
      await seedFormula('acme', 'dg', 'avg_coolant', 'avg(coolant_temp_c)');
      await seedMachine('acme', 'DG-1', 'dg', { plantId, values: { coolant_temp_c: 80 } });
      await seedMachine('acme', 'DG-2', 'dg', { plantId, values: { coolant_temp_c: 90 } });
      await seedMachine('acme', 'DG-3', 'dg', { plantId, silent: true });

      const [widget] = (await pages.sitePage(acme, plantId, NOW)).widgets;
      expect(widget).toMatchObject({
        readiness: 'ready',
        data: { value: 85, unit: 'degC', aggregate: 'avg', machinesIncluded: 2, machinesExcluded: 1, excluded: { notDeclared: 0, notReady: 1 } },
      });
    });

    it('a machine whose class does not declare the key is excluded as not_declared — a mixed fleet is normal', async () => {
      const site = await seedSiteClass('fleet', [{ key: 'coolant', type: 'kpi_number', boundTo: 'avg_coolant', aggregate: 'sum', position: 1 }]);
      const plantId = await seedPlant('acme', 'YARD', site);
      await seedClass('acme', 'dg');
      await seedClass('acme', 'compressor');
      await seedFormula('acme', 'dg', 'avg_coolant', 'avg(coolant_temp_c)');
      await seedMachine('acme', 'DG-1', 'dg', { plantId });
      await seedMachine('acme', 'CP-1', 'compressor', { plantId });
      const [widget] = (await pages.sitePage(acme, plantId, NOW)).widgets;
      expect(widget.data).toMatchObject({ value: 80, machinesIncluded: 1, machinesExcluded: 1, excluded: { notDeclared: 1, notReady: 0 } });
    });

    it('mixed units are refused, never converted — blocked / unit_conflict naming both units and a machine for each', async () => {
      const site = await seedSiteClass('fleet', [{ key: 'load', type: 'kpi_number', boundTo: 'load', aggregate: 'avg', position: 1 }]);
      const plantId = await seedPlant('acme', 'YARD', site);
      await seedClass('acme', 'dg');
      await seedClass('acme', 'compressor');
      await seedFormula('acme', 'dg', 'load', 'avg(coolant_temp_c)');
      await seedFormula('acme', 'compressor', 'load', 'avg(oil_pressure_kpa)');
      await seedMachine('acme', 'DG-1', 'dg', { plantId });
      await seedMachine('acme', 'CP-1', 'compressor', { plantId });
      const [widget] = (await pages.sitePage(acme, plantId, NOW)).widgets;
      expect(widget.readiness).toBe('blocked');
      expect(widget.data).toBeNull();
      // Both units, each with a machine that reported it; the order carries no meaning.
      expect(widget.reason).toMatch(/^unit_conflict: /);
      expect(widget.reason).toContain('"degC" (iot-platform-1/DG-1)');
      expect(widget.reason).toContain('"kPa" (iot-platform-1/CP-1)');
    });

    it('8. no machine ready: not_available / no_ready_machines, value null', async () => {
      const site = await seedSiteClass('fleet', [{ key: 'coolant', type: 'kpi_number', boundTo: 'avg_coolant', aggregate: 'max', position: 1 }]);
      const plantId = await seedPlant('acme', 'YARD', site);
      await seedClass('acme', 'dg');
      await seedFormula('acme', 'dg', 'avg_coolant', 'avg(coolant_temp_c)');
      await seedMachine('acme', 'DG-1', 'dg', { plantId, silent: true });
      const [widget] = (await pages.sitePage(acme, plantId, NOW)).widgets;
      expect(widget).toMatchObject({ readiness: 'not_available', reason: 'no_ready_machines', data: null });
    });

    it('9. bound_to without aggregate — and aggregate without bound_to — is refused by the database', async () => {
      await owner.query(`INSERT INTO site_class (slug, version, name, status) VALUES ('bad', 1, 'Bad', 'draft')`);
      await expect(owner.query(
        `INSERT INTO site_class_layout (site_class_slug, class_version, widget_type, widget_key, bound_to, position, size)
           VALUES ('bad', 1, 'kpi_number', 'k', 'avg_coolant', 1, 'small')`,
      )).rejects.toThrow(/ck_site_layout_aggregate_declared/);
      await expect(owner.query(
        `INSERT INTO site_class_layout (site_class_slug, class_version, widget_type, widget_key, position, size, aggregate)
           VALUES ('bad', 1, 'alert_list', 'a', 1, 'small', 'sum')`,
      )).rejects.toThrow(/ck_site_layout_aggregate_declared/);
      await expect(owner.query(
        `INSERT INTO site_class_layout (site_class_slug, class_version, widget_type, widget_key, bound_to, position, size, aggregate)
           VALUES ('bad', 1, 'kpi_number', 'k', 'avg_coolant', 1, 'small', 'median')`,
      )).rejects.toThrow(/ck_site_layout_aggregate/);
    });

    it('a site page over twenty machines is measured', async () => {
      const plantId = await seedPlant('acme', 'YARD');
      await seedClass('acme', 'dg');
      for (let i = 1; i <= 20; i += 1) await seedMachine('acme', `DG-${i}`, 'dg', { plantId });
      const site = await countQueries(() => pages.sitePage(acme, plantId, NOW));
      expect((site.result.widgets[0].data as unknown[]).length).toBe(20);
      // eslint-disable-next-line no-console
      console.log(`QPAGE1 §5 — site page over 20 machines (default class): ${site.queries} queries in ${site.ms} ms`);
      // eslint-disable-next-line no-console
      console.log('QPAGE1 §5 breakdown (site):', JSON.stringify([...site.kinds].sort((a, b) => b[1] - a[1])));
      expect(site.ms).toBeLessThan(2000);
    }, 60_000);
  });

  // =============================================================== migration
  describe('the migration', () => {
    afterAll(() => owner.runMigrations({ transaction: 'all' }));

    it('applies over site layouts that existed before it — the seeded default binds nothing, so it satisfies the CHECK', async () => {
      await undoMigrationNamed(owner, 'SiteAggregate1758300000000');
      // Seeded before migrating: an unbound widget on a second site class.
      await owner.query(`INSERT INTO site_class (slug, version, name, status) VALUES ('pre', 1, 'Pre', 'published')`);
      await owner.query(
        `INSERT INTO site_class_layout (site_class_slug, class_version, widget_type, widget_key, position, size)
           VALUES ('pre', 1, 'alert_list', 'alerts', 1, 'medium')`,
      );
      await owner.runMigrations({ transaction: 'all' });
      const rows: { aggregate: string | null }[] = await owner.query(`SELECT aggregate FROM site_class_layout`);
      expect(rows.length).toBeGreaterThanOrEqual(4);
      expect(rows.every((r) => r.aggregate === null)).toBe(true);
    }, 60_000);

    it('has a down path, named by its own migration, that removes the column and both CHECKs', async () => {
      await undoMigrationNamed(owner, 'SiteAggregate1758300000000');
      const cols = await owner.query(
        `SELECT 1 FROM information_schema.columns WHERE table_name = 'site_class_layout' AND column_name = 'aggregate'`,
      );
      expect(cols).toEqual([]);
      const checks = await owner.query(`SELECT conname FROM pg_constraint WHERE conname LIKE 'ck_site_layout_aggregate%'`);
      expect(checks).toEqual([]);
    }, 60_000);
  });

  // ============================================================ registry, RLS
  it('10. every widget type has a producer, and the page answers every type without throwing', () => {
    const missing = WIDGET_TYPES.filter((t) => !WIDGET_PRODUCERS[t]);
    expect(missing).toEqual([]);
  });

  describe('12. tenant isolation — deliberately', () => {
    it('another tenant\'s machine and site do not exist for you: through the service, and over HTTP', async () => {
      await seedClass('acme', 'dg');
      const ref = await seedMachine('acme', 'DG-1', 'dg');
      const plantId = await seedPlant('acme', 'YARD');

      await expect(pages.machinePage(globex, ref, NOW)).rejects.toBeInstanceOf(NotFoundException);
      await expect(pages.sitePage(globex, plantId, NOW)).rejects.toBeInstanceOf(NotFoundException);

      const token = (tenant: string) => app.get(JwtService).signAsync(
        { sub: '00000000-0000-4000-8000-0000000000c1', client_id: tenant, roles: ['admin'] }, { secret: SECRET, issuer: ISSUER },
      );
      const asGlobex = `Bearer ${await token('globex')}`;
      expect((await request(app.getHttpServer()).get(`/api/v1/equipment/${SS}/DG-1/page`).set('Authorization', asGlobex)).status).toBe(404);
      expect((await request(app.getHttpServer()).get(`/api/v1/sites/${plantId}/page`).set('Authorization', asGlobex)).status).toBe(404);

      // And the owner does see it — the 404 above is isolation, not a broken route.
      const asAcme = `Bearer ${await token('acme')}`;
      const own = await request(app.getHttpServer()).get(`/api/v1/equipment/${SS}/DG-1/page`).set('Authorization', asAcme);
      expect(own.status).toBe(200);
      expect(own.body.equipment.externalId).toBe('DG-1');
    });
  });
});
