import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Workbook } from 'exceljs';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { RequestScope } from '../src/auth/types/request-scope';
import { AlertRuleTemplate } from '../src/catalog/entities/alert-rule-template.entity';
import { EquipmentClassFormula } from '../src/catalog/entities/equipment-class-formula.entity';
import { EquipmentClassLayout } from '../src/catalog/entities/equipment-class-layout.entity';
import { EquipmentClassProfile } from '../src/catalog/entities/equipment-class-profile.entity';
import { NamedFormula } from '../src/catalog/entities/named-formula.entity';
import { ScenarioDefinition } from '../src/catalog/entities/scenario-definition.entity';
import { SignalAlias } from '../src/catalog/entities/signal-alias.entity';
import { fallbackLayout, LayoutWidget, mergeTenantLayout, TenantLayoutWidget } from '../src/catalog/layout/layout-rules';
import { WIDGET_TYPES } from '../src/catalog/layout/widget-types';
import { CatalogAuthoringService } from '../src/catalog/services/catalog-authoring.service';
import {
  formulaPresentations, resolveSiteClass, siteLayout, siteLayoutProblems,
} from '../src/catalog/services/class-layout';
import { CatalogImportRow } from '../src/catalog-import/entities/catalog-import-row.entity';
import { CatalogImportApplyService } from '../src/catalog-import/services/catalog-import-apply.service';
import { CatalogImportValidatorService } from '../src/catalog-import/services/catalog-import-validator.service';
import { CatalogTemplateService } from '../src/catalog-import/services/catalog-template.service';
import { WorkbookParserService } from '../src/catalog-import/services/workbook-parser.service';
import { ALL_SHEETS } from '../src/catalog-import/template-schema';
import { ClientEquipmentClassLayout } from '../src/client-catalog/entities/client-equipment-class-layout.entity';
import {
  auditClassContentTables, CLASS_CONTENT_INVENTORY, findClassReferencingTables,
} from '../src/client-catalog/services/class-content-inventory';
import { ClientCatalogService } from '../src/client-catalog/services/client-catalog.service';
import { CopyOnGrantService } from '../src/client-catalog/services/copy-on-grant.service';
import { SensorRoleCapability } from '../src/device-catalog/entities/sensor-role-capability.entity';
import { createApp } from '../src/main';
import { withTenantId } from '../src/scope/tenant-session';
import { createAppDataSource, createTestDataSource, describeDb, undoMigrationNamed } from './db';

const MIGRATION = 'PageLayout1758200000000';
const SECRET = 'test-secret-page-layout';
const ISSUER = 'things-alive-page-layout-test';
const CLASS = 'layout-test-class';
const platform: RequestScope = { tenantId: '', userId: 'deepak', roles: [], isPlatformRole: true };
const acme: RequestScope = { tenantId: 'acme', userId: 'u-acme-super', roles: ['super admin'], isPlatformRole: false };

/**
 * Page layout and the site class (task QREC0b).
 *
 * A widget type is code; a widget instance and its position are rows. Every refusal
 * here is proven by attempting the forbidden thing — through the import, through
 * publish, or against the database itself.
 */
describeDb('page layout and the site class', () => {
  let owner: DataSource;
  let ds: DataSource;
  let app: INestApplication;
  let authoring: CatalogAuthoringService;
  let parser: WorkbookParserService;
  let validator: CatalogImportValidatorService;
  let applier: CatalogImportApplyService;
  let templates: CatalogTemplateService;
  let copies: CopyOnGrantService;
  let clientCatalog: ClientCatalogService;

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    ds = await createAppDataSource();
    authoring = new CatalogAuthoringService(
      ds.getRepository(EquipmentClassProfile), ds.getRepository(EquipmentClassFormula),
      ds.getRepository(ScenarioDefinition), ds.getRepository(SignalAlias),
      ds.getRepository(AlertRuleTemplate), ds.getRepository(NamedFormula),
      ds.getRepository(SensorRoleCapability),
    );
    parser = new WorkbookParserService(ds);
    validator = new CatalogImportValidatorService(ds);
    applier = new CatalogImportApplyService(ds);
    templates = new CatalogTemplateService();
    copies = new CopyOnGrantService(ds);
    clientCatalog = new ClientCatalogService(ds, copies);

    // Set explicitly: Nest's config otherwise falls back to .env for an unset key.
    process.env.AUTH_JWT_SECRET = SECRET;
    process.env.AUTH_JWT_ISSUER = ISSUER;
    process.env.AUTH_TENANT_CLAIM = 'client_id';
    process.env.CORS_ORIGINS = 'http://localhost:3000';
    app = await createApp({ database: true });
    await app.init();
  }, 60_000);

  afterAll(async () => { await app?.close(); await ds?.destroy(); await owner?.destroy(); });

  const truncate = () => owner.query(
    `TRUNCATE TABLE "catalog_import_row", "catalog_import_batch", "client_equipment_class_layout",
      "client_formula", "client_equipment_class", "equipment_class_layout", "equipment_class_formula",
      "equipment_class_sensor_requirement", "equipment_class_profile", "sensor", "plant"
     RESTART IDENTITY CASCADE`,
  );

  /** A draft class with one scalar, one series and one targeted scalar formula. */
  const draftClass = async () => {
    await authoring.createClass(platform, CLASS, {
      name: 'Layout test class',
      expectedSignals: [{ signal: 'coolant_temp_c', unit: 'degC', required: true }],
    });
    const formulas = ds.getRepository(EquipmentClassFormula);
    await formulas.save([
      formulas.create({ classSlug: CLASS, classVersion: 1, formulaKey: 'mean_temp', kind: 'empirical', expression: 'avg(coolant_temp_c)' }),
      formulas.create({ classSlug: CLASS, classVersion: 1, formulaKey: 'temp_trace', kind: 'empirical', expression: 'coolant_temp_c' }),
      formulas.create({
        classSlug: CLASS, classVersion: 1, formulaKey: 'peak_temp', kind: 'empirical', expression: 'max(coolant_temp_c)',
        targetValue: 95, targetDirection: 'lower_better',
      }),
    ]);
  };
  const widget = (w: Partial<LayoutWidget> & Pick<LayoutWidget, 'widgetType' | 'widgetKey' | 'position'>, version = 1) =>
    ds.getRepository(EquipmentClassLayout).save(ds.getRepository(EquipmentClassLayout).create({
      classSlug: CLASS, classVersion: version, boundTo: null, title: null, size: 'medium', ...w,
    } as Partial<EquipmentClassLayout>));
  const publish = () => authoring.publishClass(platform, CLASS);

  // ------------------------------------------------------------------ workbooks
  const v4Workbook = async (mutate?: (wb: Workbook) => void): Promise<Buffer> => {
    const wb = new Workbook();
    await wb.xlsx.load(await templates.build(new Date('2026-10-05T00:00:00Z')) as any); // eslint-disable-line @typescript-eslint/no-explicit-any
    wb.removeWorksheet(wb.getWorksheet('sensor_capability')!.id);
    mutate?.(wb);
    return (await wb.xlsx.writeBuffer()) as unknown as Buffer;
  };
  const addLayoutRow = (wb: Workbook, values: Record<string, unknown>) => {
    const schema = ALL_SHEETS.find((s) => s.sheet === 'layout')!;
    wb.getWorksheet('layout')!.addRow(schema.columns.map((c) => values[c.name] ?? ''));
  };
  const stage = async (buffer: Buffer) => {
    const parsed = await parser.parse(buffer, 'wb.xlsx', 'deepak');
    await validator.validate(parsed.id);
    return parsed.id;
  };
  const layoutRowsOf = (batchId: string) =>
    ds.getRepository(CatalogImportRow).find({ where: { batchId, sheet: 'layout' }, order: { rowNumber: 'ASC' } });

  beforeEach(truncate);

  // ============================================================== the vocabulary
  it('the database CHECK and the code agree on the widget vocabulary', async () => {
    // Drift between the two is a type the database accepts and no renderer exists
    // for, or the reverse. A new type changes both, in one deploy.
    for (const constraint of ['ck_class_layout_widget_type', 'ck_client_layout_widget_type', 'ck_site_layout_widget_type']) {
      const [{ def }] = await owner.query(
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = $1`, [constraint],
      );
      const inDb = [...def.matchAll(/'([a-z_]+)'::text/g)].map((m: RegExpMatchArray) => m[1]).sort();
      expect(inDb).toEqual([...WIDGET_TYPES].sort());
    }
  });

  // ================================================================== refusals
  describe('refused, naming what and where', () => {
    it('1. a widget type outside the vocabulary — at validate, and by the database', async () => {
      const batchId = await stage(await v4Workbook((wb) => {
        addLayoutRow(wb, { class_slug: 'diesel-generator', widget_key: 'pie', widget_type: 'pie_chart', position: 2, size: 'small' });
      }));
      const [, pie] = await layoutRowsOf(batchId);
      expect(pie.status).toBe('invalid');
      expect(pie.message).toMatch(/layout row 3: widget type "pie_chart" is not in the widget vocabulary/);

      await draftClass();
      await expect(widget({ widgetType: 'pie_chart' as any, widgetKey: 'pie', position: 1 }))
        .rejects.toThrow(/ck_class_layout_widget_type/);
    });

    it('2. bound_to naming a formula the class does not declare', async () => {
      await draftClass();
      await widget({ widgetType: 'kpi_number', widgetKey: 'ghost', boundTo: 'ghost_formula', position: 1 });
      await expect(publish()).rejects.toThrow(/widget "ghost" is bound to formula "ghost_formula", which the class does not declare/);
    });

    it('3. bound_to naming a signal the class does not declare', async () => {
      await draftClass();
      await widget({ widgetType: 'signal_chart', widgetKey: 'oil', boundTo: 'oil_pressure_kpa', position: 1 });
      await expect(publish()).rejects.toThrow(/widget "oil" is bound to signal "oil_pressure_kpa", which the class does not declare/);
    });

    it('4. kpi_chart on a scalar is refused; kpi_number on a series is refused', async () => {
      await draftClass();
      await widget({ widgetType: 'kpi_chart', widgetKey: 'mean_chart', boundTo: 'mean_temp', position: 1 });
      await widget({ widgetType: 'kpi_number', widgetKey: 'trace_number', boundTo: 'temp_trace', position: 2 });
      // One publish attempt names both, not just the first it finds.
      const message = await publish().catch((e: Error) => e.message);
      expect(message).toMatch(/widget "mean_chart": "kpi_chart" contradicts formula "mean_temp".*result_kind "scalar"/);
      expect(message).toMatch(/widget "trace_number": "kpi_number" contradicts formula "temp_trace".*result_kind "series"/);
    });

    it('4b. a series whose formula says chart_type "number" is a kpi_number — the formula decides presentation', async () => {
      await draftClass();
      await ds.getRepository(EquipmentClassFormula).update({ classSlug: CLASS, formulaKey: 'temp_trace' }, { chartType: 'number' });
      await widget({ widgetType: 'kpi_number', widgetKey: 'latest_temp', boundTo: 'temp_trace', position: 1 });
      await expect(publish()).resolves.toMatchObject({ status: 'published' });
    });

    it('4c. and a layout that charts it anyway is refused — the layout must agree with the formula', async () => {
      await draftClass();
      await ds.getRepository(EquipmentClassFormula).update({ classSlug: CLASS, formulaKey: 'temp_trace' }, { chartType: 'number' });
      await widget({ widgetType: 'kpi_chart', widgetKey: 'trace_chart', boundTo: 'temp_trace', position: 1 });
      await expect(publish()).rejects.toThrow(/"kpi_chart" contradicts formula "temp_trace" \(chart_type "number"/);
    });

    it('5. kpi_gauge on a formula with no target', async () => {
      await draftClass();
      await widget({ widgetType: 'kpi_gauge', widgetKey: 'mean_gauge', boundTo: 'mean_temp', position: 1 });
      await expect(publish()).rejects.toThrow(/widget "mean_gauge": a gauge needs a target, and formula "mean_temp" has no target_value or band/);
    });

    it('5b. a gauge on a formula with a target publishes', async () => {
      await draftClass();
      await widget({ widgetType: 'kpi_gauge', widgetKey: 'peak_gauge', boundTo: 'peak_temp', position: 1 });
      await expect(publish()).resolves.toMatchObject({ status: 'published' });
    });

    it('bound_to on a type that binds to nothing, and missing on one that needs it', async () => {
      await draftClass();
      await widget({ widgetType: 'alert_list', widgetKey: 'alerts', boundTo: 'mean_temp', position: 1 });
      await widget({ widgetType: 'kpi_number', widgetKey: 'unbound', position: 2 });
      const message = await publish().catch((e: Error) => e.message);
      expect(message).toMatch(/widget "alerts": "alert_list" binds to nothing, but bound_to is "mean_temp"/);
      expect(message).toMatch(/widget "unbound": "kpi_number" must be bound to a formula, and bound_to is blank/);
    });

    it('a site-only widget on a machine page', async () => {
      await draftClass();
      await widget({ widgetType: 'machine_list', widgetKey: 'machines', position: 1 });
      await expect(publish()).rejects.toThrow(/"machine_list" has no meaning on an equipment page/);
    });

    it('6. two widgets at one position — at validate naming both rows, and by the database', async () => {
      const batchId = await stage(await v4Workbook((wb) => {
        addLayoutRow(wb, { class_slug: 'diesel-generator', widget_key: 'alerts', widget_type: 'alert_list', position: 1, size: 'medium' });
      }));
      const rows = await layoutRowsOf(batchId);
      for (const r of rows) {
        expect(r.status).toBe('invalid');
        expect(r.message).toMatch(/class "diesel-generator" has two widgets at position 1 \(rows 2, 3\)/);
      }

      await draftClass();
      await widget({ widgetType: 'alert_list', widgetKey: 'alerts', position: 1 });
      await expect(widget({ widgetType: 'work_order_list', widgetKey: 'work', position: 1 }))
        .rejects.toThrow(/uq_class_layout_position/);
    });
  });

  // ================================================================== fallback
  it('7. a class with no layout publishes, and the fallback is a readiness list plus each KPI in its own form', async () => {
    await draftClass();
    await expect(publish()).resolves.toMatchObject({ status: 'published' });
    expect(await ds.getRepository(EquipmentClassLayout).count()).toBe(0);

    const fallback = fallbackLayout(await formulaPresentations(ds.manager, CLASS, 1));
    expect(fallback.map((w) => [w.widgetType, w.boundTo, w.position])).toEqual([
      ['readiness_list', null, 1],
      // Ordered by formula key. The series charts; the scalars are numbers — the
      // presentation each formula asks for, decided by its compiled result_kind
      // because none of them declares a chart_type.
      ['kpi_number', 'mean_temp', 2],
      ['kpi_number', 'peak_temp', 3],
      ['kpi_chart', 'temp_trace', 4],
    ]);
  });

  // ================================================================== versions
  it('a published version\'s layout cannot be edited — the database refuses', async () => {
    await draftClass();
    await widget({ widgetType: 'alert_list', widgetKey: 'alerts', position: 1 });
    await publish();
    await expect(ds.getRepository(EquipmentClassLayout).update({ classSlug: CLASS }, { position: 5 }))
      .rejects.toThrow(/ck_class_content_draft_only/);
  });

  it('a fork carries the version\'s layout forward', async () => {
    await draftClass();
    await widget({ widgetType: 'alert_list', widgetKey: 'alerts', position: 1 });
    await publish();
    await authoring.editClass(platform, CLASS, { description: 'v2' });
    expect(await ds.getRepository(EquipmentClassLayout).countBy({ classSlug: CLASS, classVersion: 2 })).toBe(1);
  });

  // ============================================================= grant and tenant
  describe('copy on grant, and the tenant\'s two changes', () => {
    const grantWithLayout = async () => {
      await draftClass();
      await widget({ widgetType: 'readiness_list', widgetKey: 'readiness', position: 1, size: 'full' });
      await widget({ widgetType: 'kpi_number', widgetKey: 'mean', boundTo: 'mean_temp', position: 2 });
      await widget({ widgetType: 'alert_list', widgetKey: 'alerts', position: 3 });
      await publish();
      return copies.copyForTenant('acme', CLASS, 'deepak');
    };
    const tenantRows = () => withTenantId(ds, 'acme', (m) =>
      m.getRepository(ClientEquipmentClassLayout).find({ where: { tenantId: 'acme' }, order: { position: 'ASC' } }));
    const asTenant = (rows: ClientEquipmentClassLayout[]): TenantLayoutWidget[] => rows.map((r) => ({
      widgetType: r.widgetType, widgetKey: r.widgetKey, boundTo: r.boundTo, title: r.title, position: r.position,
      size: r.size, hidden: r.hidden, positionCustom: r.positionCustom,
    }));

    it('8. copy-on-grant carries the layout; the inventory audit passes, and the site tables are recorded as exclude', async () => {
      const result = await grantWithLayout();
      expect(result.layoutWidgetsCopied).toBe(3);
      expect((await tenantRows()).map((r) => [r.widgetKey, r.hidden, r.positionCustom])).toEqual([
        ['readiness', false, false], ['mean', false, false], ['alerts', false, false],
      ]);
      expect(await withTenantId(ds, 'globex', (m) => m.getRepository(ClientEquipmentClassLayout).count())).toBe(0);

      const live = await findClassReferencingTables(ds.manager);
      expect(live).toContain('equipment_class_layout');
      expect(auditClassContentTables(live, CLASS_CONTENT_INVENTORY)).toEqual([]);
      expect(CLASS_CONTENT_INVENTORY.find((e) => e.table === 'equipment_class_layout')?.disposition).toBe('copy');
      // The audit cannot see these (no class_slug column) — which is why they are
      // written down, with the reason, rather than left absent.
      for (const table of ['site_class', 'site_class_layout']) {
        const entry = CLASS_CONTENT_INVENTORY.find((e) => e.table === table);
        expect(entry?.disposition).toBe('exclude');
        expect(entry?.reason).toBeTruthy();
      }
    });

    it('9. a widget the tenant hid stays hidden on a new class version', async () => {
      await grantWithLayout();
      await clientCatalog.setWidgetHidden(acme, CLASS, 'alerts', true);

      const nextVersion: LayoutWidget[] = [
        { widgetType: 'readiness_list', widgetKey: 'readiness', boundTo: null, title: null, position: 1, size: 'full' },
        { widgetType: 'kpi_number', widgetKey: 'mean', boundTo: 'mean_temp', title: 'Mean coolant', position: 2, size: 'small' },
        { widgetType: 'alert_list', widgetKey: 'alerts', boundTo: null, title: 'Open alerts', position: 3, size: 'large' },
      ];
      const merged = mergeTenantLayout(asTenant(await tenantRows()), nextVersion);
      const alerts = merged.find((w) => w.widgetKey === 'alerts')!;
      expect(alerts.hidden).toBe(true);
      // Class-origin fields update; the tenant's own decision does not.
      expect(alerts).toMatchObject({ title: 'Open alerts', size: 'large' });
      expect(merged.find((w) => w.widgetKey === 'mean')).toMatchObject({ title: 'Mean coolant', hidden: false });
    });

    it('10. a tenant reorder survives a new class version, marked custom, and a new widget makes room', async () => {
      await grantWithLayout();
      await clientCatalog.reorderLayout(acme, CLASS, ['alerts', 'readiness', 'mean']);
      const reordered = await tenantRows();
      expect(reordered.map((r) => [r.widgetKey, r.position, r.positionCustom])).toEqual([
        ['alerts', 1, true], ['readiness', 2, true], ['mean', 3, true],
      ]);

      // The new version keeps its own order and adds a widget at position 1.
      const nextVersion: LayoutWidget[] = [
        { widgetType: 'work_order_list', widgetKey: 'work', boundTo: null, title: null, position: 1, size: 'medium' },
        { widgetType: 'readiness_list', widgetKey: 'readiness', boundTo: null, title: null, position: 2, size: 'full' },
        { widgetType: 'kpi_number', widgetKey: 'mean', boundTo: 'mean_temp', title: null, position: 3, size: 'small' },
        { widgetType: 'alert_list', widgetKey: 'alerts', boundTo: null, title: null, position: 4, size: 'medium' },
      ];
      const merged = mergeTenantLayout(asTenant(reordered), nextVersion);
      expect(merged.map((w) => [w.widgetKey, w.position, w.positionCustom])).toEqual([
        ['alerts', 1, true], ['readiness', 2, true], ['mean', 3, true],
        // A deliberate change wins the collision; the new widget moves past it.
        ['work', 4, false],
      ]);
    });

    it('a reorder that leaves a widget out, or names one not on the page, is refused', async () => {
      await grantWithLayout();
      await expect(clientCatalog.reorderLayout(acme, CLASS, ['alerts', 'readiness']))
        .rejects.toThrow(/names every widget on "layout-test-class" exactly once\. Missing: mean/);
      await expect(clientCatalog.reorderLayout(acme, CLASS, ['alerts', 'readiness', 'mean', 'ghost']))
        .rejects.toThrow(/Not on this page: ghost/);
    });

    it('a class granted with no layout reads as the fallback, and says so', async () => {
      await draftClass();
      await publish();
      await copies.copyForTenant('acme', CLASS, 'deepak');
      const page = await clientCatalog.layout(acme, CLASS);
      expect(page.fallback).toBe(true);
      expect(page.widgets[0].widgetType).toBe('readiness_list');
    });

    describe('over HTTP', () => {
      const token = () => app.get(JwtService).signAsync(
        { sub: '00000000-0000-4000-8000-0000000000a1', client_id: 'acme', roles: ['super admin'] }, { secret: SECRET, issuer: ISSUER },
      );
      const base = `/api/v1/my-catalog/equipment-classes/${CLASS}/layout`;

      it('hides a widget, and refuses a body that is not { hidden: boolean }', async () => {
        await grantWithLayout();
        const auth = `Bearer ${await token()}`;
        const bad = await request(app.getHttpServer()).patch(`${base}/alerts`).set('Authorization', auth).send({ hide: true });
        expect(bad.status).toBe(400);
        const none = await request(app.getHttpServer()).patch(`${base}/alerts`).set('Authorization', auth);
        expect(none.status).toBe(400);

        const ok = await request(app.getHttpServer()).patch(`${base}/alerts`).set('Authorization', auth).send({ hidden: true });
        expect(ok.status).toBe(200);
        expect(ok.body).toMatchObject({ widgetKey: 'alerts', hidden: true });
      });

      it('reorders, and refuses an empty or missing list', async () => {
        await grantWithLayout();
        const auth = `Bearer ${await token()}`;
        expect((await request(app.getHttpServer()).put(`${base}/order`).set('Authorization', auth)).status).toBe(400);
        expect((await request(app.getHttpServer()).put(`${base}/order`).set('Authorization', auth).send({ widgetKeys: [] })).status).toBe(400);
        const ok = await request(app.getHttpServer()).put(`${base}/order`).set('Authorization', auth)
          .send({ widgetKeys: ['mean', 'alerts', 'readiness'] });
        expect(ok.status).toBe(200);
        expect(ok.body.map((w: TenantLayoutWidget) => w.widgetKey)).toEqual(['mean', 'alerts', 'readiness']);
      });
    });
  });

  // ================================================================ site class
  describe('the site class', () => {
    it('11. a plant with no site class resolves to the seeded default, whose page passes its own rules', async () => {
      const [plant] = await owner.query(
        `INSERT INTO plant (tenant_id, code, name) VALUES ('acme', 'P1', 'Yard') RETURNING site_class_slug, site_class_version`,
      );
      expect(plant).toEqual({ site_class_slug: null, site_class_version: null });

      const site = await resolveSiteClass(ds.manager, { siteClassSlug: null, siteClassVersion: null });
      expect(site).toMatchObject({ slug: 'default', version: 1, status: 'published' });
      const page = await siteLayout(ds.manager, site);
      expect(page.map((w) => w.widgetType)).toEqual(['machine_list', 'alert_list', 'work_order_list']);
      expect(siteLayoutProblems(page)).toEqual([]);
    });

    it('a plant names a site class completely or not at all, and only one that exists', async () => {
      await expect(owner.query(
        `INSERT INTO plant (tenant_id, code, name, site_class_slug) VALUES ('acme', 'P2', 'Half', 'default')`,
      )).rejects.toThrow(/ck_plant_site_class_pair/);
      await expect(owner.query(
        `INSERT INTO plant (tenant_id, code, name, site_class_slug, site_class_version) VALUES ('acme', 'P3', 'Ghost', 'quarry', 1)`,
      )).rejects.toThrow(/fk_plant_site_class/);
    });
  });

  // ================================================================== template
  describe('template v4, layout sheet', () => {
    it('12. a v4 workbook with no layout sheet loads, and the class gets the fallback', async () => {
      const batchId = await stage(await v4Workbook((wb) => wb.removeWorksheet(wb.getWorksheet('layout')!.id)));
      const rejected = await ds.getRepository(CatalogImportRow).count({ where: { batchId, status: 'invalid' } });
      expect(rejected).toBe(0);
      const summary = await applier.apply(batchId, 'deepak');
      expect(summary.classes['diesel-generator'].created.layout).toBeUndefined();
      expect(await ds.getRepository(EquipmentClassLayout).count()).toBe(0);
    });

    it('13. a v4 workbook with a layout sheet applies, the rows land, and the class publishes', async () => {
      const batchId = await stage(await v4Workbook((wb) => {
        addLayoutRow(wb, { class_slug: 'diesel-generator', widget_key: 'alerts', widget_type: 'alert_list', position: 2, size: 'medium' });
      }));
      expect(await ds.getRepository(CatalogImportRow).count({ where: { batchId, status: 'invalid' } })).toBe(0);
      const summary = await applier.apply(batchId, 'deepak');
      expect(summary.classes['diesel-generator'].created.layout).toBe(2);

      const rows = await ds.getRepository(EquipmentClassLayout).find({ where: { classSlug: 'diesel-generator' }, order: { position: 'ASC' } });
      expect(rows.map((r) => [r.widgetKey, r.widgetType, r.boundTo, r.source])).toEqual([
        ['coolant_margin', 'kpi_chart', 'coolant_margin_c', 'excel-import'],
        ['alerts', 'alert_list', null, 'excel-import'],
      ]);
      await expect(authoring.publishClass(platform, 'diesel-generator')).resolves.toMatchObject({ status: 'published' });
    });

    it('a layout row bound to a formula the batch does not declare is refused at validate, naming it', async () => {
      const batchId = await stage(await v4Workbook((wb) => {
        addLayoutRow(wb, { class_slug: 'diesel-generator', widget_key: 'ghost', widget_type: 'kpi_number', bound_to: 'ghost_formula', position: 2, size: 'small' });
      }));
      const [, ghost] = await layoutRowsOf(batchId);
      expect(ghost.status).toBe('invalid');
      expect(ghost.message).toMatch(/widget "ghost" is bound to formula "ghost_formula", which class "diesel-generator" does not declare/);
    });
  });

  // ================================================================= migration
  describe('the migration', () => {
    afterAll(() => owner.runMigrations({ transaction: 'all' }));

    it('applies over a tenant copy that existed beforehand, and that copy reads as the fallback', async () => {
      await draftClass();
      await publish();
      await copies.copyForTenant('acme', CLASS, 'deepak');
      await undoMigrationNamed(owner, MIGRATION);
      await owner.runMigrations({ transaction: 'all' });

      const page = await clientCatalog.layout(acme, CLASS);
      expect(page.fallback).toBe(true);
      expect(page.widgets.map((w) => w.widgetType)).toEqual(['readiness_list', 'kpi_number', 'kpi_number', 'kpi_chart']);
    }, 60_000);

    it('has a down path, named by its own migration, that leaves none of its additions behind', async () => {
      await undoMigrationNamed(owner, MIGRATION);
      const tables: { table_name: string }[] = await owner.query(`
        SELECT table_name FROM information_schema.tables
         WHERE table_name IN ('equipment_class_layout', 'client_equipment_class_layout', 'site_class', 'site_class_layout')`);
      expect(tables).toEqual([]);
      const columns: { column_name: string }[] = await owner.query(`
        SELECT column_name FROM information_schema.columns
         WHERE table_name = 'plant' AND column_name IN ('site_class_slug', 'site_class_version')`);
      expect(columns).toEqual([]);
    }, 60_000);
  });
});
