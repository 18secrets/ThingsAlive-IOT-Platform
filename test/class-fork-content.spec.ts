import { DataSource } from 'typeorm';
import { RequestScope } from '../src/auth/types/request-scope';
import { AlertRuleTemplate } from '../src/catalog/entities/alert-rule-template.entity';
import { EquipmentClassFormula } from '../src/catalog/entities/equipment-class-formula.entity';
import { EquipmentClassLayout } from '../src/catalog/entities/equipment-class-layout.entity';
import { EquipmentClassProfile } from '../src/catalog/entities/equipment-class-profile.entity';
import { EquipmentClassSensorRequirement } from '../src/catalog/entities/equipment-class-sensor-requirement.entity';
import { NamedFormula } from '../src/catalog/entities/named-formula.entity';
import { ScenarioDefinition } from '../src/catalog/entities/scenario-definition.entity';
import { SignalAlias } from '../src/catalog/entities/signal-alias.entity';
import { CatalogAuthoringService } from '../src/catalog/services/catalog-authoring.service';
import { SensorRoleCapability } from '../src/device-catalog/entities/sensor-role-capability.entity';
import { createTestDataSource, describeDb } from './db';

const PLATFORM: RequestScope = { tenantId: '', userId: 'author', roles: ['master-admin'], isPlatformRole: true };
const SLUG = 'fork-test-genset';

/**
 * Editing a published class forks a draft from it, and the draft has to carry
 * everything the published version had. It carried failure modes, recommendations,
 * layout, schematic and model, but not sensor requirements or formulas: the draft of a
 * class with KPI widgets could not be published at all ("bound to formula ..., which
 * the class does not declare"), and one without a layout published with no KPIs.
 */
describeDb('forking a published class', () => {
  let owner: DataSource;
  let authoring: CatalogAuthoringService;

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    authoring = new CatalogAuthoringService(
      owner.getRepository(EquipmentClassProfile), owner.getRepository(EquipmentClassFormula),
      owner.getRepository(ScenarioDefinition), owner.getRepository(SignalAlias), owner.getRepository(AlertRuleTemplate),
      owner.getRepository(NamedFormula), owner.getRepository(SensorRoleCapability),
    );

    await authoring.createClass(PLATFORM, SLUG, {
      name: 'Fork test genset', category: 'Power',
      expectedSignals: [{ signal: 'engine_coolant_temperature', unit: 'degC', required: true, description: 'Coolant' }],
    });
    await owner.transaction(async (m) => {
      await m.getRepository(EquipmentClassSensorRequirement).save({
        classSlug: SLUG, classVersion: 1, measurementRole: 'engine_coolant_temperature', componentScope: '',
        criticality: 'required', minCount: 1, canonicalUnit: 'degC', enables: [], notes: null,
      } as never);
      await m.getRepository(EquipmentClassFormula).save(m.getRepository(EquipmentClassFormula).create({
        classSlug: SLUG, classVersion: 1, formulaKey: 'avg_coolant', kind: 'empirical', expression: 'avg(engine_coolant_temperature)',
        inputs: [], outputUnit: null, basis: 'test', status: 'approved', approvedBy: 'author', approvedAt: new Date(),
        aggregationWindow: '24h', chartType: 'number',
      } as never));
      await m.getRepository(EquipmentClassLayout).save(m.getRepository(EquipmentClassLayout).create({
        classSlug: SLUG, classVersion: 1, widgetType: 'kpi_number', widgetKey: 'avg_coolant', boundTo: 'avg_coolant',
        title: 'Average coolant', position: 1, size: 'small', source: 'manual', importBatchId: null,
      } as never));
    });
    await authoring.publishClass(PLATFORM, SLUG);
  }, 60_000);

  afterAll(async () => { await owner?.destroy(); });

  const rows = (table: string, version: number) =>
    owner.query(`SELECT * FROM "${table}" WHERE class_slug = $1 AND class_version = $2`, [SLUG, version]);

  it('carries the sensor requirements and formulas into the draft, and the draft publishes', async () => {
    const draft = await authoring.editClass(PLATFORM, SLUG, { description: 'Second edition' });
    expect(draft.version).toBe(2);

    const [requirement] = await rows('equipment_class_sensor_requirement', 2);
    expect(requirement).toMatchObject({ measurement_role: 'engine_coolant_temperature', criticality: 'required' });
    const [formula] = await rows('equipment_class_formula', 2);
    expect(formula).toMatchObject({ formula_key: 'avg_coolant', status: 'approved', expression: 'avg(engine_coolant_temperature)' });

    // The publish that refused the fork before: the KPI widget's formula is declared.
    const published = await authoring.publishClass(PLATFORM, SLUG);
    expect(published).toMatchObject({ version: 2, status: 'published' });
  });

  it('leaves the published version it forked from exactly as it was', async () => {
    expect(await rows('equipment_class_sensor_requirement', 1)).toHaveLength(1);
    expect(await rows('equipment_class_formula', 1)).toHaveLength(1);
  });
});
