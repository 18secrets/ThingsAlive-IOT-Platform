import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { RequestScope } from '../src/auth/types/request-scope';
import { WIDGET_SPECS, WIDGET_TYPES } from '../src/catalog/layout/widget-types';
import { ClientEquipmentClassLayout } from '../src/client-catalog/entities/client-equipment-class-layout.entity';
import { ClientEquipmentClass } from '../src/client-catalog/entities/client-equipment-class.entity';
import { EquipmentProfile } from '../src/equipment/equipment-profile.entity';
import { createApp } from '../src/main';
import { PageService } from '../src/page/page.service';
import { ParameterRow, WIDGET_PRODUCERS } from '../src/page/page-widgets';
import { runTenantSpanning } from '../src/scope/tenant-session';
import { createTestDataSource, describeDb, undoMigrationNamed } from './db';

const MIGRATION = 'ParameterAndForecastWidgets1760000000000';
const NOW = new Date('2026-10-14T12:00:00.000Z');
const SS = 'iot-platform-1';
const acme: RequestScope = { tenantId: 'acme', userId: 'u-acme', roles: ['admin'], isPlatformRole: false };

/**
 * `parameter_list` and `forecast_chart` (task QREC0b.1), the two widget types QREC0b
 * queued. The page composes; so these assert what a producer said and how the widget
 * carries it — and, for the forecast, which of two absences it is waiting on.
 */
describe('the vocabulary', () => {
  it('both types exist, with the scopes and bindings they need, and a named producer each', () => {
    expect(WIDGET_TYPES).toEqual(expect.arrayContaining(['parameter_list', 'forecast_chart']));
    expect(WIDGET_SPECS.parameter_list).toEqual({ binds: 'none', scopes: ['equipment', 'site'] });
    expect(WIDGET_SPECS.forecast_chart).toEqual({ binds: 'signal', scopes: ['equipment'] });
    expect(WIDGET_PRODUCERS.parameter_list).toMatch(/ParameterService\.effective/);
    expect(WIDGET_PRODUCERS.forecast_chart).toMatch(/QML1/);
  });
});

describeDb('parameter_list and forecast_chart on the page', () => {
  let owner: DataSource;
  let app: INestApplication;
  let pages: PageService;
  let profileId: string;
  let plantId: string;

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    process.env.AUTH_JWT_SECRET = 'test-secret-qrec0b1';
    process.env.AUTH_JWT_ISSUER = 'things-alive-qrec0b1-test';
    process.env.AUTH_TENANT_CLAIM = 'client_id';
    process.env.CORS_ORIGINS = 'http://localhost:3000';
    app = await createApp({ database: true });
    await app.init();
    pages = app.get(PageService);
  }, 60_000);

  afterAll(async () => { await app?.close(); await owner?.destroy(); });

  beforeEach(async () => {
    await owner.query(`
      TRUNCATE TABLE "client_equipment_class_layout", "client_equipment_class", "equipment_profile",
        "equipment_class_sensor_requirement", "equipment_class_profile", "tenant_parameter", "plant"
      RESTART IDENTITY CASCADE`);
    await owner.query(`DELETE FROM "site_class_layout" WHERE "site_class_slug" <> 'default'`);
    await owner.query(`DELETE FROM "site_class" WHERE "slug" <> 'default'`);
    await owner.query(
      `INSERT INTO equipment_class_profile (slug, version, status, name, expected_signals)
         VALUES ('genset', 1, 'published', 'Genset', '[{"signal":"coolant_temp_c","unit":"degC","required":true},{"signal":"fuel_level","unit":"%","required":true}]'::jsonb)`,
    );
    await owner.query(
      `INSERT INTO equipment_class_sensor_requirement (class_slug, class_version, measurement_role, canonical_unit, forecast_enabled)
         VALUES ('genset', 1, 'coolant_temp_c', 'degC', true), ('genset', 1, 'fuel_level', '%', false)`,
    );
    await owner.query(`INSERT INTO site_class (slug, version, name, status) VALUES ('yard', 1, 'Yard', 'published')`);
    await owner.query(
      `INSERT INTO site_class_layout (site_class_slug, class_version, widget_type, widget_key, position, size)
         VALUES ('yard', 1, 'parameter_list', 'costs', 1, 'medium')`,
    );
    [{ id: plantId }] = await owner.query(
      `INSERT INTO plant (tenant_id, code, name, site_class_slug, site_class_version) VALUES ('acme', 'north', 'North', 'yard', 1) RETURNING id`,
    );
    await runTenantSpanning(owner, 'test fixture', async (m) => {
      await m.getRepository(ClientEquipmentClass).save({
        tenantId: 'acme', slug: 'genset', name: 'Genset', description: null, category: null, expectedSignals: [],
        failureModes: [], defaultThresholds: {}, templateSlug: 'genset', templateVersion: 1, templateChecksum: 'c',
        copiedAt: NOW, status: 'active', updatedBy: 'u',
      });
      profileId = (await m.getRepository(EquipmentProfile).save({
        tenantId: 'acme', sourceSystem: SS, externalId: 'G-1', equipmentClassSlug: 'genset', classVersion: 1, plantId,
        tier: 'standard', commissionedAt: null, serviceIntervalHours: null, readiness: {}, updatedBy: 'u', name: 'G-1',
      })).id;
      await m.getRepository(ClientEquipmentClassLayout).save([
        ['params', 'parameter_list', null, 1], ['coolant_forecast', 'forecast_chart', 'coolant_temp_c', 2],
        ['fuel_forecast', 'forecast_chart', 'fuel_level', 3],
      ].map(([key, type, boundTo, position]) => ({
        tenantId: 'acme', clientEquipmentClassSlug: 'genset', widgetType: type as never, widgetKey: key as string,
        boundTo: boundTo as string | null, title: null, position: position as number, size: 'medium' as const,
        hidden: false, positionCustom: false, templateVersion: 1, copiedAt: NOW,
      })));
    });
  });

  const setParameter = (name: string, value: number, scope: string, ref: string | null, unit: string) => owner.query(
    `INSERT INTO tenant_parameter (tenant_id, scope, scope_ref, name, value, unit, effective_from, created_by)
       VALUES ('acme', $1, $2, $3, $4::jsonb, $5, '2026-01-01', 'u')`,
    [scope, ref, name, JSON.stringify(value), unit],
  );
  const widget = async (key: string) =>
    (await pages.machinePage(acme, { sourceSystem: SS, externalId: 'G-1' }, NOW)).widgets.find((w) => w.widgetKey === key)!;

  it('parameter_list on a machine: every parameter, each with the scope that set it, unset ones shown as unset', async () => {
    await setParameter('fuel_price', 92, 'client', null, 'currency/L');
    await setParameter('fuel_price', 95, 'equipment', profileId, 'currency/L');
    const w = await widget('params');
    expect(w.readiness).toBe('ready');
    const rows = w.data as ParameterRow[];
    expect(rows.find((r) => r.name === 'fuel_price')).toMatchObject({ value: 95, source: { scope: 'equipment' } });
    expect(rows.find((r) => r.name === 'labour_rate_per_hour')).toMatchObject({ value: null, source: null });
  });

  it('parameter_list on a site: the site\'s own values, not a machine\'s', async () => {
    await setParameter('fuel_price', 90, 'site', plantId, 'currency/L');
    await setParameter('fuel_price', 99, 'equipment', profileId, 'currency/L');
    const site = await pages.sitePage(acme, plantId, NOW);
    const rows = site.widgets.find((w) => w.widgetKey === 'costs')!.data as ParameterRow[];
    expect(rows.find((r) => r.name === 'fuel_price')).toMatchObject({ value: 90, source: { scope: 'site' } });
  });

  it('forecast_chart says which absence it is: no forecast declared, or declared with no model yet', async () => {
    expect(await widget('fuel_forecast')).toMatchObject({ readiness: 'not_configured', reason: 'forecast_not_declared', data: null });
    expect(await widget('coolant_forecast')).toMatchObject({ readiness: 'not_available', reason: 'no_forecast_model', data: null });
  });

  it('the database takes both types and still refuses one no renderer exists for', async () => {
    const insert = (type: string) => owner.query(
      `INSERT INTO site_class_layout (site_class_slug, class_version, widget_type, widget_key, position, size)
         VALUES ('yard', 1, $1, $2, $3, 'small')`, [type, `w-${type}`, type === 'forecast_chart' ? 5 : 6],
    );
    await insert('forecast_chart');
    await expect(insert('weather_radar')).rejects.toThrow(/ck_site_layout_widget_type/);
  });

  it(`down path (${MIGRATION}): the twelve are back, and the two are refused again`, async () => {
    await owner.query(`DELETE FROM site_class_layout WHERE widget_type IN ('parameter_list', 'forecast_chart')`);
    await owner.query(`TRUNCATE TABLE client_equipment_class_layout`);
    await undoMigrationNamed(owner, MIGRATION);
    try {
      await expect(owner.query(
        `INSERT INTO site_class_layout (site_class_slug, class_version, widget_type, widget_key, position, size)
           VALUES ('yard', 1, 'parameter_list', 'p', 9, 'small')`,
      )).rejects.toThrow(/ck_site_layout_widget_type/);
    } finally {
      await owner.runMigrations({ transaction: 'all' });
    }
  }, 60_000);
});
