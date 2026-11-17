import { INestApplication } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { RequestScope } from '../src/auth/types/request-scope';
import { compileFormula } from '../src/catalog/formula/formula-compiler';
import { ClientEquipmentClassLayout } from '../src/client-catalog/entities/client-equipment-class-layout.entity';
import { ClientEquipmentClass } from '../src/client-catalog/entities/client-equipment-class.entity';
import { ClientFormula } from '../src/client-catalog/entities/client-formula.entity';
import { DeviceHealthService } from '../src/device-health/services/device-health.service';
import { EquipmentProfile } from '../src/equipment/equipment-profile.entity';
import { createApp } from '../src/main';
import { mappedImeisFor, onboardedMachines } from '../src/onboarding/mapped-devices';
import { readMachineLive } from '../src/page/live-machine';
import { PageService } from '../src/page/page.service';
import { DeviceProjection } from '../src/projection/entities/device-projection.entity';
import { runTenantSpanning, withTenantId } from '../src/scope/tenant-session';
import { createTestDataSource, describeDb } from './db';

const SS = 'iot-platform-1';
const CLASS = 'dg';
const SIGNAL = 'coolant_temp_c';
const UNIT = 'degC';
const NOW = new Date('2026-11-17T12:00:00Z');
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);
const acme: RequestScope = { tenantId: 'acme', userId: 'u-acme', roles: ['admin'], isPlatformRole: false };

jest.setTimeout(30_000);

/**
 * Status only after mapping (17 Nov 2026). The onboarding order is: a device, a machine,
 * then the device mapped to the machine. Until the mapping, neither has an Online/Offline
 * state or data to show; once mapped — in 2.0, or in 1.0 — both do. Each case puts a
 * logger that reports into the database and checks the reader refuses to show it until
 * it is mapped, because a reader that only ever saw mapped loggers proves nothing.
 */
describeDb('status and data only after a device is mapped to its machine', () => {
  let owner: DataSource;
  let app: INestApplication;
  let pages: PageService;
  let health: DeviceHealthService;
  let ds: DataSource;

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    process.env.AUTH_JWT_SECRET = 'test-secret-mapped-status';
    process.env.AUTH_JWT_ISSUER = 'things-alive-mapped-status-test';
    process.env.AUTH_TENANT_CLAIM = 'client_id';
    process.env.CORS_ORIGINS = 'http://localhost:3000';
    app = await createApp({ database: true });
    await app.init();
    pages = app.get(PageService);
    ds = app.get(DataSource);
    health = new DeviceHealthService(ds);
  }, 60_000);

  afterAll(async () => { await app?.close(); await owner?.destroy(); });

  beforeEach(async () => {
    await owner.query(`
      TRUNCATE TABLE "telemetry_reading", "device_link_health", "device_projection", "device_inventory",
        "client_equipment_class_layout", "client_formula", "client_equipment_class", "equipment_profile",
        "equipment_class_sensor_requirement", "equipment_class_profile"
      RESTART IDENTITY CASCADE`);
  });

  const fixture = (fn: (m: EntityManager) => Promise<unknown>) => runTenantSpanning(owner, 'test fixture', fn);

  const machine = (externalId: string) => fixture((m) => m.getRepository(EquipmentProfile).save({
    tenantId: 'acme', sourceSystem: SS, externalId, equipmentClassSlug: CLASS, classVersion: 1,
    tier: 'standard', commissionedAt: null, serviceIntervalHours: null, readiness: {}, updatedBy: 'u',
    plantId: null, name: `Machine ${externalId}`,
  }));
  /** In this account, on no machine: created, not mapped. */
  const unmappedDevice = (imei: string) => owner.query(
    `INSERT INTO device_inventory (imei, tenant_id, state) VALUES ($1, 'acme', 'assigned')`, [imei]);
  /** Mapped in 2.0. */
  const claim = (imei: string, externalId: string) => owner.query(
    `INSERT INTO device_inventory (imei, tenant_id, state, equipment_external_id, claimed_at)
       VALUES ($1, 'acme', 'assigned', $2, $3)`, [imei, externalId, NOW]);
  /** Mapped in 1.0, as the fleet sync mirrors it. */
  const fitted1x = (imei: string, externalId: string, status: 'live' | 'missing' = 'live') =>
    fixture((m) => m.getRepository(DeviceProjection).save({
      sourceSystem: SS, externalId: `dev-${imei}`, tenantId: 'acme', payload: {}, sourceUpdatedAt: null,
      syncedAt: NOW, checksum: 'c', status, imei, equipmentExternalId: externalId, name: null,
    }));
  const reading = (imei: string, at: Date) => owner.query(
    `INSERT INTO telemetry_reading (tenant_id, imei, signal, value, unit, source_timestamp, received_at, source)
       VALUES ('acme', $1, $2, 80, $3, $4, $4, 'test')`, [imei, SIGNAL, UNIT, at]);
  const linkVerdict = (imei: string, externalId: string) => owner.query(
    `INSERT INTO device_link_health
       (tenant_id, imei, source_system, external_id, local_date, window_start, window_end, state, detail)
     VALUES ('acme', $1, $2, $3, '2026-11-17', $4, $5, 'healthy', 'd')`, [imei, SS, externalId, ago(60), NOW]);
  const live = (externalId: string) =>
    withTenantId(ds, 'acme', (m) => readMachineLive(m, undefined, 'acme', { sourceSystem: SS, externalId }, NOW));
  const mapped = (externalId: string) => withTenantId(ds, 'acme', (m) => mappedImeisFor(m, 'acme', externalId));

  describe('what counts as mapped', () => {
    it('a 2.0 claim and a live 1.0 fitment both do; a device on no machine does not', async () => {
      await claim('IMEI-2X', 'DG-1');
      await fitted1x('IMEI-1X', 'DG-1');
      await unmappedDevice('IMEI-LOOSE');

      expect(await mapped('DG-1')).toEqual(['IMEI-1X', 'IMEI-2X']);
      expect(await withTenantId(ds, 'acme', (m) => onboardedMachines(m, 'acme', ['DG-1', 'DG-2'])))
        .toEqual(new Set(['DG-1']));
    });

    it('a fitment 1.0 has deleted does not', async () => {
      await fitted1x('IMEI-1X', 'DG-1', 'missing');
      expect(await mapped('DG-1')).toEqual([]);
    });

    it('where 2.0 has the device on another machine, 2.0 wins', async () => {
      await fitted1x('IMEI-MOVED', 'DG-1');
      await claim('IMEI-MOVED', 'DG-2');

      expect(await mapped('DG-1')).toEqual([]);
      expect(await mapped('DG-2')).toEqual(['IMEI-MOVED']);
    });
  });

  describe('the Live view', () => {
    it('a reporting device on no machine leaves the machine "no-device", with no values', async () => {
      await machine('DG-1');
      await unmappedDevice('IMEI-LOOSE');
      await reading('IMEI-LOOSE', ago(1));

      expect(await live('DG-1')).toMatchObject({ connection: 'no-device', signals: [], lastReadingAt: null });
    });

    it('once mapped, the same device makes it online with its value', async () => {
      await machine('DG-1');
      await claim('IMEI-2X', 'DG-1');
      await reading('IMEI-2X', ago(1));

      const result = await live('DG-1');
      expect(result.connection).toBe('online');
      expect(result.signals.map((s) => s.signal)).toEqual([SIGNAL]);
    });

    it('a device moved to another machine in 2.0 no longer reports for the one 1.0 names', async () => {
      await machine('DG-1');
      await fitted1x('IMEI-MOVED', 'DG-1');
      await claim('IMEI-MOVED', 'DG-2');
      await reading('IMEI-MOVED', ago(1));

      expect((await live('DG-1')).connection).toBe('no-device');
      expect((await live('DG-2')).connection).toBe('online');
    });
  });

  describe('the logger health list (devices online, the assistant\'s link tool)', () => {
    it('lists a mapped logger and leaves out one on no machine, though both have a verdict', async () => {
      await claim('IMEI-2X', 'DG-1');
      await unmappedDevice('IMEI-LOOSE');
      await linkVerdict('IMEI-2X', 'DG-1');
      await linkVerdict('IMEI-LOOSE', 'DG-9');

      const rows = await health.fleet(acme, {}, NOW);
      expect(rows.map((r) => r.imei)).toEqual(['IMEI-2X']);
    });

    it('a logger mapped only in 1.0 is listed', async () => {
      await fitted1x('IMEI-1X', 'DG-1');
      await linkVerdict('IMEI-1X', 'DG-1');
      expect((await health.fleet(acme, {}, NOW)).map((r) => r.imei)).toEqual(['IMEI-1X']);
    });
  });

  describe('the machine page', () => {
    beforeEach(async () => {
      const signals = [{ signal: SIGNAL, unit: UNIT, required: true }];
      await owner.query(
        `INSERT INTO equipment_class_profile (slug, version, status, name, expected_signals)
           VALUES ($1, 1, 'published', $1, $2::jsonb)`, [CLASS, JSON.stringify(signals)]);
      await owner.query(
        `INSERT INTO equipment_class_sensor_requirement (class_slug, class_version, measurement_role, canonical_unit)
           VALUES ($1, 1, $2, $3)`, [CLASS, SIGNAL, UNIT]);
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
      await machine('DG-1');
    });

    const page = () => pages.machinePage(acme, { sourceSystem: SS, externalId: 'DG-1' }, NOW);
    const byKey = async () => Object.fromEntries((await page()).widgets.map((w) => [w.widgetKey, w]));

    it('with no device mapped: not onboarded, and its data widgets draw no value', async () => {
      await unmappedDevice('IMEI-LOOSE');
      await reading('IMEI-LOOSE', ago(1));
      const result = await page();
      const w = await byKey();

      expect(result.equipment.onboarded).toBe(false);
      // No value, and not ready. The reason stays the configuration gap where there is one
      // (nothing is bound without a device): that is what somebody has to fix first.
      for (const key of ['coolant', 'chart']) {
        expect(w[key]).toMatchObject({ data: null, readiness: 'not_configured' });
      }
    });

    it('once a device is mapped the same widgets are no longer held back', async () => {
      await claim('IMEI-2X', 'DG-1');
      const result = await page();
      const w = await byKey();

      expect(result.equipment.onboarded).toBe(true);
      for (const key of ['coolant', 'chart']) expect(w[key].reason).not.toBe('not_onboarded');
    });
  });
});
