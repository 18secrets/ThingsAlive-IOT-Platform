import { DataSource, EntityManager } from 'typeorm';
import { RequestScope } from '../src/auth/types/request-scope';
import { AlertRuleTemplate } from '../src/catalog/entities/alert-rule-template.entity';
import { EquipmentClassFormula } from '../src/catalog/entities/equipment-class-formula.entity';
import { EquipmentClassLayout } from '../src/catalog/entities/equipment-class-layout.entity';
import { EquipmentClassProfile } from '../src/catalog/entities/equipment-class-profile.entity';
import { NamedFormula } from '../src/catalog/entities/named-formula.entity';
import { ScenarioDefinition } from '../src/catalog/entities/scenario-definition.entity';
import { SignalAlias } from '../src/catalog/entities/signal-alias.entity';
import { LayoutWidget, mergeTenantLayout, TenantLayoutWidget } from '../src/catalog/layout/layout-rules';
import { CatalogAuthoringService } from '../src/catalog/services/catalog-authoring.service';
import { ClientEquipmentClassLayout } from '../src/client-catalog/entities/client-equipment-class-layout.entity';
import { ClassUpgradeService } from '../src/client-catalog/services/class-upgrade.service';
import { CopyOnGrantService } from '../src/client-catalog/services/copy-on-grant.service';
import { SensorRoleCapability } from '../src/device-catalog/entities/sensor-role-capability.entity';
import { withTenantId } from '../src/scope/tenant-session';
import { createAppDataSource, createTestDataSource, describeDb } from './db';

/**
 * D49: an upgrade drops a widget only when the library removed it. A widget the version
 * the copy came from never had was the account's own, and it survives. Before this, an
 * upgrade of demo-construction's sixteen classes deleted the nineteen widgets on each of
 * its 83 machine pages, because none of them had ever been in the library.
 */
const w = (widgetKey: string, position: number, widgetType = 'alert_list'): LayoutWidget =>
  ({ widgetType, widgetKey, boundTo: null, title: null, position, size: 'medium' });
const mine = (widgetKey: string, position: number, extra: Partial<TenantLayoutWidget> = {}): TenantLayoutWidget =>
  ({ ...w(widgetKey, position), hidden: false, positionCustom: false, ...extra });

describe('D49: the layout merge, as a pure function', () => {
  it('keeps a widget neither version has, where the account put it; the library\'s move round it', () => {
    const merged = mergeTenantLayout([mine('lib', 1), mine('own', 2, { hidden: true })], [w('lib', 1), w('new', 2)], [w('lib', 1)]);
    expect(merged.map((x) => [x.widgetKey, x.position, x.hidden])).toEqual([
      ['lib', 1, false], ['own', 2, true], ['new', 3, false],
    ]);
  });

  it('still drops a widget the library removed', () => {
    const merged = mergeTenantLayout([mine('gone', 1), mine('own', 2)], [w('new', 1)], [w('gone', 1)]);
    expect(merged.map((x) => x.widgetKey)).toEqual(['new', 'own']);
  });

  it('keeps every widget of a copy whose library layout was empty in both versions', () => {
    const copy = ['readiness', 'alerts', 'work_orders'].map((k, i) => mine(k, i + 1));
    expect(mergeTenantLayout(copy, [], []).map((x) => [x.widgetKey, x.position])).toEqual([
      ['readiness', 1], ['alerts', 2], ['work_orders', 3],
    ]);
  });

  it('without the base version, treats every widget as the library\'s, as before', () => {
    expect(mergeTenantLayout([mine('own', 1)], [w('new', 1)])).toEqual([mine('new', 1)]);
  });
});

describeDb('D49: upgrading a copy that has widgets of its own', () => {
  let owner: DataSource;
  let ds: DataSource;
  let authoring: CatalogAuthoringService;
  let upgrades: ClassUpgradeService;

  const CLASS = 'own-widgets-genset';
  const master: RequestScope = { tenantId: 'things-alive', userId: 'u-master', roles: ['master-admin'], isPlatformRole: true };
  const acme: RequestScope = { tenantId: 'acme', userId: 'u-acme', roles: ['super admin'], isPlatformRole: false };
  const inAcme = <T>(fn: (m: EntityManager) => Promise<T>): Promise<T> => withTenantId(ds, 'acme', fn);
  const widget = (version: number, widgetKey: string, widgetType: string, position: number) =>
    owner.getRepository(EquipmentClassLayout).save(owner.getRepository(EquipmentClassLayout).create({
      classSlug: CLASS, classVersion: version, widgetType, widgetKey, boundTo: null, position, title: null, size: 'medium',
    } as Partial<EquipmentClassLayout>));
  const layout = () => inAcme((m) => m.getRepository(ClientEquipmentClassLayout).find({ order: { position: 'ASC' } }));

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    ds = await createAppDataSource();
    authoring = new CatalogAuthoringService(
      owner.getRepository(EquipmentClassProfile), owner.getRepository(EquipmentClassFormula),
      owner.getRepository(ScenarioDefinition), owner.getRepository(SignalAlias),
      owner.getRepository(AlertRuleTemplate), owner.getRepository(NamedFormula),
      owner.getRepository(SensorRoleCapability),
    );
    upgrades = new ClassUpgradeService(ds);

    // ---- v1 has the alerts widget; acme's copy gets it, then a widget of acme's own.
    await authoring.createClass(master, CLASS, {
      name: 'Own widgets genset', expectedSignals: [{ signal: 'coolant_temp', unit: 'degC', required: true }],
    });
    await widget(1, 'alerts', 'alert_list', 1);
    await authoring.publishClass(master, CLASS);
    await new CopyOnGrantService(ds).copyForTenant('acme', CLASS, 'u-master');
    await inAcme((m) => m.getRepository(ClientEquipmentClassLayout).save(m.getRepository(ClientEquipmentClassLayout).create({
      tenantId: 'acme', clientEquipmentClassSlug: CLASS, widgetType: 'work_order_list', widgetKey: 'work_orders',
      boundTo: null, title: 'Our work orders', position: 2, size: 'large', hidden: false, positionCustom: false,
      templateVersion: null, copiedAt: null,
    } as Partial<ClientEquipmentClassLayout>)));

    // ---- v2 drops alerts and adds readiness.
    await authoring.editClass(master, CLASS, {});
    await owner.query(`DELETE FROM equipment_class_layout WHERE class_slug = $1 AND class_version = 2`, [CLASS]);
    await widget(2, 'readiness', 'readiness_list', 1);
    await authoring.publishClass(master, CLASS);
  }, 60_000);

  afterAll(async () => { await ds?.destroy(); await owner?.destroy(); });

  it('previews the account\'s widget as kept, and only the library\'s as removed', async () => {
    expect((await upgrades.preview(acme, CLASS)).layout).toEqual({
      added: ['readiness'], removed: ['alerts'], keptCustom: ['work_orders'],
    });
  });

  it('applies it: the account\'s widget survives as it was, the removed one goes', async () => {
    expect((await upgrades.apply(acme, CLASS, 2)).upgraded).toBe(true);
    const rows = await layout();
    expect(rows.map((r: ClientEquipmentClassLayout) => [r.widgetKey, r.position, r.templateVersion])).toEqual([
      ['readiness', 1, 2], ['work_orders', 2, null],
    ]);
    // Still the account's own, title and size included: no library version is its source.
    expect(rows[1]).toMatchObject({ title: 'Our work orders', size: 'large', copiedAt: null });
  });
});
