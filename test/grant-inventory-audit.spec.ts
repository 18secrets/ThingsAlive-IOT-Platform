import { DataSource } from 'typeorm';
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
import {
  auditClassContentTables, CLASS_CONTENT_INVENTORY, entriesMissingDestination, findClassReferencingTables,
} from '../src/client-catalog/services/class-content-inventory';
import { CopyOnGrantService } from '../src/client-catalog/services/copy-on-grant.service';
import { SensorRoleCapability } from '../src/device-catalog/entities/sensor-role-capability.entity';
import { withTenantId } from '../src/scope/tenant-session';
import { createAppDataSource, createTestDataSource, describeDb } from './db';

const CLASS = 'audit-genset';
const master: RequestScope = { tenantId: 'things-alive', userId: 'u-master', roles: ['master-admin'], isPlatformRole: true };

/**
 * QGRANT1: the inventory is held to what it says. QGRANT0's test proves every
 * class-referencing table is *listed*; nothing proved a `copy` table is *copied*.
 * Stop copying one and that test stayed green.
 */
describe('class content inventory: every copy says where it lands', () => {
  it('no copy or is_the_class entry is missing its destination', () => {
    expect(entriesMissingDestination(CLASS_CONTENT_INVENTORY)).toEqual([]);
  });

  it('a copy with no destination is caught, naming the table', () => {
    expect(entriesMissingDestination([{ table: 'new_class_content', disposition: 'copy' }])).toEqual(['new_class_content']);
  });

  it('a copy destination counts as covered, not as a second source', () => {
    expect(auditClassContentTables(
      ['equipment_class_formula', 'client_formula', 'a_new_table'], CLASS_CONTENT_INVENTORY,
    )).toEqual(['a_new_table']);
  });
});

describeDb('class content inventory: copy is proven', () => {
  let owner: DataSource;
  let ds: DataSource;
  let authoring: CatalogAuthoringService;
  let copies: CopyOnGrantService;

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
    copies = new CopyOnGrantService(ds);

    // One row in every copy source, through the authoring path a real class takes —
    // so publish's own checks (formulas compile, layout agrees with them) apply.
    await authoring.createClass(master, CLASS, {
      name: 'Audit genset',
      expectedSignals: [{ signal: 'coolant_temp', unit: 'degC', required: true }],
      failureModes: [{ code: 'FM-1', name: 'Overheat', symptom: 'runs hot', severity: 'high', signals: ['coolant_temp'] }] as any,
    });
    await insertClassContent(owner.manager, CLASS, 1, [], [{
      failureModeCode: 'FM-1', action: 'Clean the radiator', urgency: 'next_service', estimatedHours: 1, requiredParts: null,
    }], { source: 'manual', importBatchId: null });
    await owner.getRepository(EquipmentClassFormula).save(owner.getRepository(EquipmentClassFormula).create({
      classSlug: CLASS, classVersion: 1, formulaKey: 'mean_temp', kind: 'empirical', expression: 'avg(coolant_temp)',
    }));
    await owner.getRepository(EquipmentClassLayout).save(owner.getRepository(EquipmentClassLayout).create({
      classSlug: CLASS, classVersion: 1, widgetType: 'kpi_number', widgetKey: 'mean_temp', position: 1,
      boundTo: 'mean_temp', title: null, size: 'medium',
    } as Partial<EquipmentClassLayout>));
    await authoring.publishClass(master, CLASS);
    await authoring.createScenario(master, 'audit-overheat', {
      equipmentClassSlug: CLASS, name: 'Overheat', requiredSignals: ['coolant_temp'], parameters: [] as any,
    });
    await authoring.publishScenario(master, 'audit-overheat');
    await authoring.createAlertTemplate(master, 'audit-hot', {
      equipmentClassSlug: CLASS, name: 'Running hot', trigger: 'signal-threshold',
      params: { signal: 'coolant_temp', max: 103 } as any, severity: 'high' as any,
    });
    await authoring.publishAlertTemplate(master, 'audit-hot');
  }, 60_000);

  afterAll(async () => { await ds?.destroy(); await owner?.destroy(); });

  it('names every class-referencing table the wider audit finds, and leaves none undecided', async () => {
    const live = await findClassReferencingTables(owner.manager);
    // eslint-disable-next-line no-console
    console.log('QGRANT1 audit — tables with a *class_slug column:', live);
    expect(live).toContain('plant'); // the reference the two-name match could not see
    expect(auditClassContentTables(live, CLASS_CONTENT_INVENTORY)).toEqual([]);
  });

  it('the fixture really has a row in every copy source — otherwise the next test proves nothing', async () => {
    for (const e of CLASS_CONTENT_INVENTORY.filter((x) => x.copiedTo)) {
      const column = e.table === 'equipment_class_profile' ? 'slug'
        : ['scenario_definition', 'alert_rule_template'].includes(e.table) ? 'equipment_class_slug' : 'class_slug';
      const [{ n }] = await owner.query(`SELECT count(*)::int AS n FROM "${e.table}" WHERE "${column}" = $1`, [CLASS]);
      expect({ table: e.table, rows: n > 0 }).toEqual({ table: e.table, rows: true });
    }
  });

  it('a grant writes every table the inventory says it copies to — and only for that tenant', async () => {
    await copies.copyForTenant('acme', CLASS, 'u-master');
    for (const e of CLASS_CONTENT_INVENTORY.filter((x) => x.copiedTo)) {
      const [{ n }] = await withTenantId(ds, 'acme', (m) => m.query(`SELECT count(*)::int AS n FROM "${e.copiedTo}"`));
      expect({ source: e.table, copiedTo: e.copiedTo, copied: n > 0 })
        .toEqual({ source: e.table, copiedTo: e.copiedTo, copied: true });
      const [{ other }] = await withTenantId(ds, 'globex', (m) => m.query(`SELECT count(*)::int AS other FROM "${e.copiedTo}"`));
      expect({ copiedTo: e.copiedTo, otherTenant: other }).toEqual({ copiedTo: e.copiedTo, otherTenant: 0 });
    }
  });
});
