import { DataSource } from 'typeorm';
import { RequestScope } from '../src/auth/types/request-scope';
import { AlertRuleTemplate } from '../src/catalog/entities/alert-rule-template.entity';
import { EquipmentClassFormula } from '../src/catalog/entities/equipment-class-formula.entity';
import { EquipmentClassProfile } from '../src/catalog/entities/equipment-class-profile.entity';
import { NamedFormula } from '../src/catalog/entities/named-formula.entity';
import { ScenarioDefinition } from '../src/catalog/entities/scenario-definition.entity';
import { SignalAlias } from '../src/catalog/entities/signal-alias.entity';
import { CatalogAuthoringService } from '../src/catalog/services/catalog-authoring.service';
import { ClientFormula } from '../src/client-catalog/entities/client-formula.entity';
import { CopyOnGrantService } from '../src/client-catalog/services/copy-on-grant.service';
import { withTenantId } from '../src/scope/tenant-session';
import { SensorRoleCapability } from '../src/device-catalog/entities/sensor-role-capability.entity';
import { createAppDataSource, createTestDataSource, describeDb } from './db';

const scope: RequestScope = { tenantId: '', userId: 'deepak', roles: [], isPlatformRole: true };
const CLASS_SLUG = 'copy-grant-test-class';

/**
 * Copy-on-grant carries formulas (task QGRANT0 §1) — the gap found by reading
 * `copy-on-grant.service.ts`, not by a failing test: `equipment_class_formula` had
 * carried class content since QCE1 and was never copied. A tenant granted a class
 * received a machine with no KPIs.
 *
 * Seeded before copying, against a class that already holds a formula — not one
 * created empty by the test (task QGRANT0 §7).
 */
describeDb('copy-on-grant: formulas', () => {
  let ds: DataSource;
  let owner: DataSource;
  let authoring: CatalogAuthoringService;
  let copies: CopyOnGrantService;

  const NOW = new Date('2026-10-01T00:00:00.000Z');

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
    copies = new CopyOnGrantService(ds);
  }, 30_000);

  afterAll(async () => { await ds?.destroy(); await owner?.destroy(); });

  beforeEach(async () => {
    await owner.query(
      `TRUNCATE TABLE "client_formula", "client_scenario", "client_equipment_class",
        "equipment_class_formula", "equipment_class_profile", "named_formula"
       RESTART IDENTITY CASCADE`,
    );
  });

  // client_formula is row-level secured like every other client-owned table — a
  // direct repository read with no tenant session set sees nothing, by design
  // (RLS FORCEd, so even the migration-owner role would see nothing without it).
  const clientFormulaFor = (tenantId: string, formulaKey: string) =>
    withTenantId(ds, tenantId, (m) => m.getRepository(ClientFormula).findOneOrFail({
      where: { tenantId, clientEquipmentClassSlug: CLASS_SLUG, formulaKey },
    }));

  const grantFreshClass = async () => {
    await authoring.createClass(scope, CLASS_SLUG, {
      name: 'Copy Grant Test Class',
      expectedSignals: [{ signal: 'coolant_temp_c', unit: 'degC', required: true }],
    });
    await ds.getRepository(EquipmentClassFormula).save(ds.getRepository(EquipmentClassFormula).create({
      classSlug: CLASS_SLUG, classVersion: 1, formulaKey: 'margin', kind: 'empirical',
      expression: '105 - coolant_temp_c',
    }));
    await authoring.publishClass(scope, CLASS_SLUG);
    return copies.copyForTenant('acme', CLASS_SLUG, 'deepak', NOW);
  };

  it('a granted class\'s tenant copy holds every formula the platform class holds, with an identical compiled_plan', async () => {
    await grantFreshClass();

    const platform = await ds.getRepository(EquipmentClassFormula).findOneOrFail({
      where: { classSlug: CLASS_SLUG, classVersion: 1, formulaKey: 'margin' },
    });
    const copy = await clientFormulaFor('acme', 'margin');

    expect(copy.compiledPlan).toEqual(platform.compiledPlan);
    expect(copy.resultUnit).toBe(platform.resultUnit);
    expect(copy.requiredSignals).toEqual(platform.requiredSignals);
  });

  it('the provenance fields survive the copy', async () => {
    await ds.getRepository(NamedFormula).save(ds.getRepository(NamedFormula).create({
      slug: 'margin-physics', version: 1, name: 'Margin physics', status: 'draft',
      expression: 'limit - raw', inputs: [
        { role: 'limit', dimension: 'degC' }, { role: 'raw', dimension: 'degC' },
      ],
    }));
    await ds.getRepository(NamedFormula).update(
      { slug: 'margin-physics', version: 1 },
      { status: 'published', publishedAt: NOW, compiledPlan: {}, compilerVersion: 'test', resultUnit: 'degC' },
    );

    await authoring.createClass(scope, CLASS_SLUG, {
      name: 'Copy Grant Test Class',
      expectedSignals: [{ signal: 'coolant_temp_c', unit: 'degC', required: true }],
    });
    await ds.getRepository(EquipmentClassFormula).save(ds.getRepository(EquipmentClassFormula).create({
      classSlug: CLASS_SLUG, classVersion: 1, formulaKey: 'bound_margin', kind: 'empirical',
      expression: '105 - coolant_temp_c',
      namedFormulaSlug: 'margin-physics', namedFormulaVersion: 1,
      bindings: [{ role: 'limit', signal: 'coolant_temp_c' }, { role: 'raw', signal: 'coolant_temp_c' }],
    }));
    await authoring.publishClass(scope, CLASS_SLUG);
    await copies.copyForTenant('acme', CLASS_SLUG, 'deepak', NOW);

    const copy = await clientFormulaFor('acme', 'bound_margin');
    expect(copy.namedFormulaSlug).toBe('margin-physics');
    expect(copy.namedFormulaVersion).toBe(1);
    expect(copy.bindings).toEqual([{ role: 'limit', signal: 'coolant_temp_c' }, { role: 'raw', signal: 'coolant_temp_c' }]);
  });

  it('publishing a new named-formula version leaves an existing tenant copy untouched', async () => {
    await ds.getRepository(NamedFormula).save(ds.getRepository(NamedFormula).create({
      slug: 'margin-physics-2', version: 1, name: 'Margin physics', status: 'published', publishedAt: NOW,
      expression: 'limit - raw', inputs: [
        { role: 'limit', dimension: 'degC' }, { role: 'raw', dimension: 'degC' },
      ],
      compiledPlan: { v: 1 }, compilerVersion: 'test', resultUnit: 'degC',
    }));
    await authoring.createClass(scope, CLASS_SLUG, {
      name: 'Copy Grant Test Class',
      expectedSignals: [{ signal: 'coolant_temp_c', unit: 'degC', required: true }],
    });
    await ds.getRepository(EquipmentClassFormula).save(ds.getRepository(EquipmentClassFormula).create({
      classSlug: CLASS_SLUG, classVersion: 1, formulaKey: 'bound_margin', kind: 'empirical',
      expression: '105 - coolant_temp_c',
      namedFormulaSlug: 'margin-physics-2', namedFormulaVersion: 1,
      bindings: [{ role: 'limit', signal: 'coolant_temp_c' }, { role: 'raw', signal: 'coolant_temp_c' }],
    }));
    await authoring.publishClass(scope, CLASS_SLUG);
    await copies.copyForTenant('acme', CLASS_SLUG, 'deepak', NOW);

    const before = await clientFormulaFor('acme', 'bound_margin');

    await ds.getRepository(NamedFormula).save(ds.getRepository(NamedFormula).create({
      slug: 'margin-physics-2', version: 2, name: 'Margin physics v2', status: 'published', publishedAt: NOW,
      expression: '(limit - raw) * 2', inputs: [
        { role: 'limit', dimension: 'degC' }, { role: 'raw', dimension: 'degC' },
      ],
      compiledPlan: { v: 2 }, compilerVersion: 'test', resultUnit: 'degC',
    }));

    const after = await clientFormulaFor('acme', 'bound_margin');
    expect(after.compiledPlan).toEqual(before.compiledPlan);
    expect(after.namedFormulaVersion).toBe(1);
  });

  describe('re-grant semantics (§4)', () => {
    it('no copy exists -> copies', async () => {
      const result = await grantFreshClass();
      expect(result.alreadyPresent).toBe(false);
      expect(result.formulasCopied).toBe(1);
    });

    it('a copy of the same class version exists -> no-op, reported as already held', async () => {
      await grantFreshClass();
      const again = await copies.copyForTenant('acme', CLASS_SLUG, 'deepak', NOW);
      expect(again.alreadyPresent).toBe(true);
      expect(again.formulasCopied).toBe(0);
    });

    it('a newer class version exists -> refused, naming QUPGRADE1', async () => {
      await grantFreshClass();

      await authoring.editClass(scope, CLASS_SLUG, { description: 'v2' });
      await authoring.publishClass(scope, CLASS_SLUG);

      await expect(copies.copyForTenant('acme', CLASS_SLUG, 'deepak', NOW))
        .rejects.toThrow(/QUPGRADE1/);

      // Nothing changed — the tenant's copy still reflects v1.
      const copy = await clientFormulaFor('acme', 'margin');
      expect(copy.templateVersion).toBe(1);
    });
  });
});
