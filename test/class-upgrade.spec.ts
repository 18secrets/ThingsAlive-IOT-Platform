import { ConflictException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { RequestScope } from '../src/auth/types/request-scope';
import { AlertRuleTemplate } from '../src/catalog/entities/alert-rule-template.entity';
import { EquipmentClassFormula } from '../src/catalog/entities/equipment-class-formula.entity';
import { EquipmentClassLayout } from '../src/catalog/entities/equipment-class-layout.entity';
import { EquipmentClassProfile } from '../src/catalog/entities/equipment-class-profile.entity';
import { NamedFormula } from '../src/catalog/entities/named-formula.entity';
import { ScenarioDefinition } from '../src/catalog/entities/scenario-definition.entity';
import { SignalAlias } from '../src/catalog/entities/signal-alias.entity';
import { CatalogAuthoringService } from '../src/catalog/services/catalog-authoring.service';
import { insertClassContent } from '../src/catalog/services/class-failure-modes';
import { ClientEquipmentClass } from '../src/client-catalog/entities/client-equipment-class.entity';
import { ClientEquipmentClassFailureMode } from '../src/client-catalog/entities/client-equipment-class-failure-mode.entity';
import { ClientEquipmentClassLayout } from '../src/client-catalog/entities/client-equipment-class-layout.entity';
import { ClientEquipmentClassRecommendation } from '../src/client-catalog/entities/client-equipment-class-recommendation.entity';
import { ClientEquipmentClassVisualAnchor } from '../src/client-catalog/entities/client-equipment-class-visual-anchor.entity';
import { ClientFormula } from '../src/client-catalog/entities/client-formula.entity';
import { planUpgrade, same } from '../src/client-catalog/services/class-upgrade-plan';
import { ClassUpgradeService } from '../src/client-catalog/services/class-upgrade.service';
import { CopyOnGrantService } from '../src/client-catalog/services/copy-on-grant.service';
import { SensorRoleCapability } from '../src/device-catalog/entities/sensor-role-capability.entity';
import { withTenantId } from '../src/scope/tenant-session';
import { createAppDataSource, createTestDataSource, describeDb, undoMigrationNamed } from './db';

const MIGRATION = 'UpgradeLabels1758700000000';

/** QUPGRADE1: a tenant's class copy, moved to a newer version without losing their edits. */
describe('QUPGRADE1: the plan, as a pure function', () => {
  type Row = { key: string; v: string; templateVersion: number };
  const kind = { key: (r: Row) => r.key, content: (r: Row) => r.v };
  const plan = (tenant: Row[], base: Row[], next: Row[]) =>
    planUpgrade<Row, Row>(tenant, (r) => base.find((b) => b.key === r.key), next, kind, kind).map(({ next: _n, ...c }) => c);
  const r = (key: string, v: string): Row => ({ key, v, templateVersion: 1 });

  it('inherited: replaced whether upstream changed or not', () => {
    expect(plan([r('a', '1'), r('b', '1')], [r('a', '1'), r('b', '1')], [r('a', '2'), r('b', '1')])).toEqual([
      { key: 'a', origin: 'inherited', upstream: 'changed', action: 'replace' },
      { key: 'b', origin: 'inherited', upstream: 'unchanged', action: 'replace' },
    ]);
  });

  it('customised: kept, and the plan says when upstream moved under it', () => {
    expect(plan([r('a', 'mine')], [r('a', '1')], [r('a', '2')]))
      .toEqual([{ key: 'a', origin: 'customised', upstream: 'changed', action: 'keep' }]);
  });

  it('removed upstream: kept and orphaned, inherited or customised alike — never deleted', () => {
    expect(plan([r('a', '1'), r('b', 'mine')], [r('a', '1'), r('b', '1')], [])).toEqual([
      { key: 'a', origin: 'inherited', upstream: 'removed', action: 'orphan' },
      { key: 'b', origin: 'customised', upstream: 'removed', action: 'orphan' },
    ]);
  });

  it('tenant-added: kept; and the new version\'s own additions arrive', () => {
    expect(plan([r('mine', 'x')], [], [r('new', '1')])).toEqual([
      { key: 'mine', origin: 'tenant_added', upstream: 'unchanged', action: 'keep' },
      { key: 'new', origin: null, upstream: 'added', action: 'add' },
    ]);
  });

  it('a numeric column read back as a string is not an edit', () => {
    expect(same({ target: '95.5', parts: [1] }, { parts: [1], target: 95.5 })).toBe(true);
    expect(same({ target: '95.5' }, { target: 96 })).toBe(false);
  });
});

describeDb('QUPGRADE1: upgrading a held copy', () => {
  let owner: DataSource;
  let ds: DataSource;
  let authoring: CatalogAuthoringService;
  let grants: CopyOnGrantService;
  let upgrades: ClassUpgradeService;

  const CLASS = 'upgrade-genset';
  const master: RequestScope = { tenantId: 'things-alive', userId: 'u-master', roles: ['master-admin'], isPlatformRole: true };
  const acme: RequestScope = { tenantId: 'acme', userId: 'u-acme', roles: ['super admin'], isPlatformRole: false };
  const globex: RequestScope = { tenantId: 'globex', userId: 'u-globex', roles: ['super admin'], isPlatformRole: false };
  const signals = [{ signal: 'coolant_temp', unit: 'degC', required: true }];
  const formula = (version: number, formulaKey: string, expression: string, displayFormat = 'number:1') =>
    owner.getRepository(EquipmentClassFormula).save(owner.getRepository(EquipmentClassFormula).create({
      classSlug: CLASS, classVersion: version, formulaKey, kind: 'empirical', expression, displayFormat,
    }));
  const widget = (version: number, widgetKey: string, position: number) =>
    owner.getRepository(EquipmentClassLayout).save(owner.getRepository(EquipmentClassLayout).create({
      classSlug: CLASS, classVersion: version, widgetType: 'kpi_number', widgetKey, boundTo: widgetKey, position, title: null, size: 'medium',
    } as Partial<EquipmentClassLayout>));
  const inAcme = <T>(fn: (m: EntityManager) => Promise<T>): Promise<T> => withTenantId(ds, 'acme', fn);

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
    grants = new CopyOnGrantService(ds);
    upgrades = new ClassUpgradeService(ds);

    // ---- v1: two failure modes, a recommendation, two formulas, two widgets, a schematic and an anchor
    await authoring.createClass(master, CLASS, {
      name: 'Upgrade genset', expectedSignals: signals,
      failureModes: [
        { code: 'FM-1', name: 'Overheat', symptom: 'runs hot', severity: 'high', signals: ['coolant_temp'] },
        { code: 'FM-2', name: 'Sensor drift', symptom: 'odd readings', severity: 'low', signals: ['coolant_temp'] },
      ] as any,
    });
    await insertClassContent(owner.manager, CLASS, 1, [], [{
      failureModeCode: 'FM-1', action: 'Clean the radiator', urgency: 'next_service', estimatedHours: 1, requiredParts: null,
    }], { source: 'manual', importBatchId: null });
    await formula(1, 'mean_temp', 'avg(coolant_temp)');
    await formula(1, 'peak_temp', 'max(coolant_temp)');
    await widget(1, 'mean_temp', 1);
    await widget(1, 'peak_temp', 2);
    await owner.query(
      `INSERT INTO equipment_class_visual (class_slug, class_version, tier, asset_key, content_type, width_px, height_px)
       VALUES ($1, 1, 'schematic', 'class-visuals/v1.png', 'image/png', 100, 100)`, [CLASS],
    );
    await owner.query(
      `INSERT INTO equipment_class_visual_anchor (class_slug, class_version, signal, hotspot_x, hotspot_y) VALUES ($1, 1, 'coolant_temp', 10, 10)`, [CLASS],
    );
    await authoring.publishClass(master, CLASS);
    await grants.copyForTenant('acme', CLASS, 'u-master');
    await grants.copyForTenant('globex', CLASS, 'u-master');

    // ---- acme makes the copy theirs: a formula edited, one added, a widget moved, the anchor moved
    await inAcme(async (m) => {
      await m.query(`UPDATE client_formula SET expression = 'max(coolant_temp) - 1' WHERE formula_key = 'peak_temp'`);
      const f = await m.getRepository(ClientFormula).findOneByOrFail({ formulaKey: 'mean_temp' });
      await m.getRepository(ClientFormula).save(m.getRepository(ClientFormula).create({
        ...f, id: undefined, formulaKey: 'my_kpi', expression: 'min(coolant_temp)', templateVersion: 1,
      }));
      await m.query(`UPDATE client_equipment_class_layout SET position = 9, position_custom = true WHERE widget_key = 'peak_temp'`);
      await m.query(`UPDATE client_equipment_class_visual_anchor SET hotspot_x = 55, placement_custom = true`);
    });

    // ---- v2: mean_temp re-formatted, peak_temp changed upstream too, FM-2 dropped, FM-3 and new_kpi added, a new picture
    await authoring.editClass(master, CLASS, {
      failureModes: [
        { code: 'FM-1', name: 'Overheat', symptom: 'runs hot', severity: 'high', signals: ['coolant_temp'] },
        { code: 'FM-3', name: 'Low coolant', symptom: 'level falls', severity: 'medium', signals: ['coolant_temp'] },
      ] as any,
    });
    await insertClassContent(owner.manager, CLASS, 2, [], [{
      failureModeCode: 'FM-1', action: 'Clean the radiator', urgency: 'next_service', estimatedHours: 1, requiredParts: null,
    }], { source: 'manual', importBatchId: null }).catch(() => undefined); // the fork may already carry it
    await owner.query(`DELETE FROM equipment_class_formula WHERE class_slug = $1 AND class_version = 2`, [CLASS]);
    await formula(2, 'mean_temp', 'avg(coolant_temp)', 'number:2');
    await formula(2, 'peak_temp', 'max(coolant_temp)', 'number:2');
    await formula(2, 'new_kpi', 'last(coolant_temp)');
    await owner.query(`DELETE FROM equipment_class_layout WHERE class_slug = $1 AND class_version = 2`, [CLASS]);
    await widget(2, 'mean_temp', 1);
    await widget(2, 'peak_temp', 2);
    await widget(2, 'new_kpi', 3);
    await owner.query(`UPDATE equipment_class_visual SET asset_key = 'class-visuals/v2.png' WHERE class_slug = $1 AND class_version = 2`, [CLASS]);
    await authoring.publishClass(master, CLASS);
  }, 60_000);

  afterAll(async () => { await ds?.destroy(); await owner?.destroy(); });

  it('previews the upgrade without changing anything', async () => {
    const p = await upgrades.preview(acme, CLASS);
    expect(p).toMatchObject({ fromVersion: 1, toVersion: 2, upToDate: false, classFields: { origin: 'inherited' } });
    const byKey = (xs: { key: string }[]) => Object.fromEntries(xs.map((x) => [x.key, x]));
    expect(byKey(p.formulas)).toMatchObject({
      mean_temp: { origin: 'inherited', upstream: 'changed', action: 'replace' },
      peak_temp: { origin: 'customised', upstream: 'changed', action: 'keep' },
      my_kpi: { origin: 'tenant_added', action: 'keep' },
      new_kpi: { origin: null, upstream: 'added', action: 'add' },
    });
    expect(byKey(p.failureModes)).toMatchObject({
      'FM-1': { action: 'replace' }, 'FM-2': { upstream: 'removed', action: 'orphan' }, 'FM-3': { action: 'add' },
    });
    expect(p.layout).toEqual({ added: ['new_kpi'], removed: [], keptCustom: ['peak_temp'] });
    expect(p.anchors.needsRecheck).toEqual(['coolant_temp']);
    const held: ClientEquipmentClass = await inAcme((m) => m.getRepository(ClientEquipmentClass).findOneByOrFail({ slug: CLASS }));
    expect(held.templateVersion).toBe(1);
  });

  it('refuses to apply a version other than the latest — a diff nobody read', async () => {
    await expect(upgrades.apply(acme, CLASS, 1)).rejects.toBeInstanceOf(ConflictException);
  });

  it('applies it: inherited follows the library, the tenant\'s edits and additions survive', async () => {
    const result = await upgrades.apply(acme, CLASS, 2);
    expect(result.upgraded).toBe(true);

    const formulas = await inAcme((m) => m.getRepository(ClientFormula).find({ order: { formulaKey: 'ASC' } }));
    const f = Object.fromEntries(formulas.map((x: ClientFormula) => [x.formulaKey, x]));
    expect(f.mean_temp).toMatchObject({ displayFormat: 'number:2', templateVersion: 2 });
    expect(f.peak_temp).toMatchObject({ expression: 'max(coolant_temp) - 1', templateVersion: 1 }); // theirs, kept
    expect(f.my_kpi.expression).toBe('min(coolant_temp)');
    expect(f.new_kpi).toMatchObject({ expression: 'last(coolant_temp)', templateVersion: 2, orphanedAt: null });

    const modes = await inAcme((m) => m.getRepository(ClientEquipmentClassFailureMode).find({ order: { code: 'ASC' } }));
    expect(modes.map((x: ClientEquipmentClassFailureMode) => [x.code, x.orphanedAt !== null])).toEqual([
      ['FM-1', false], ['FM-2', true], ['FM-3', false],
    ]);
    expect(await inAcme((m) => m.getRepository(ClientEquipmentClassRecommendation).count())).toBe(1);

    const layout = await inAcme((m) => m.getRepository(ClientEquipmentClassLayout).find({ order: { position: 'ASC' } }));
    expect(layout.map((w: ClientEquipmentClassLayout) => [w.widgetKey, w.position, w.positionCustom])).toEqual([
      ['mean_temp', 1, false], ['new_kpi', 3, false], ['peak_temp', 9, true],
    ]);

    const [anchor] = await inAcme((m) => m.getRepository(ClientEquipmentClassVisualAnchor).find());
    expect(anchor).toMatchObject({ hotspotX: 55, placementCustom: true, needsRecheck: true });

    expect(await inAcme((m) => m.getRepository(ClientEquipmentClass).findOneByOrFail({ slug: CLASS })))
      .toMatchObject({ templateVersion: 2 });
  });

  it('a repeat is a no-op that says so', async () => {
    const again = await upgrades.apply(acme, CLASS, 2);
    expect(again).toMatchObject({ upgraded: false, upToDate: true });
  });

  it('never reaches another tenant — globex is still on v1', async () => {
    const cls = await withTenantId(ds, 'globex', (m) => m.getRepository(ClientEquipmentClass).findOneByOrFail({ slug: CLASS }));
    expect(cls.templateVersion).toBe(1);
  });

  it('two upgrades fired together both settle, and the upgrade runs once', async () => {
    const results = await Promise.allSettled([upgrades.apply(globex, CLASS, 2), upgrades.apply(globex, CLASS, 2)]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    const upgraded = results.map((r) => (r as PromiseFulfilledResult<{ upgraded: boolean }>).value.upgraded).sort();
    expect(upgraded).toEqual([false, true]);
    const count = await withTenantId(ds, 'globex', (m) => m.getRepository(ClientFormula).countBy({ formulaKey: 'new_kpi' }));
    expect(count).toBe(1);
  });

  it(`${MIGRATION} runs down and up again`, async () => {
    await undoMigrationNamed(owner, MIGRATION);
    const [{ n }] = await owner.query(
      `SELECT count(*)::int AS n FROM information_schema.columns WHERE column_name IN ('orphaned_at', 'needs_recheck')`,
    );
    expect(n).toBe(0);
    await owner.runMigrations({ transaction: 'all' });
  });
});
