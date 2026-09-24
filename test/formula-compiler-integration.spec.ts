import { DataSource } from 'typeorm';
import { RequestScope } from '../src/auth/types/request-scope';
import { AlertRuleTemplate } from '../src/catalog/entities/alert-rule-template.entity';
import { EquipmentClassFormula } from '../src/catalog/entities/equipment-class-formula.entity';
import { EquipmentClassProfile } from '../src/catalog/entities/equipment-class-profile.entity';
import { ScenarioDefinition } from '../src/catalog/entities/scenario-definition.entity';
import { SignalAlias } from '../src/catalog/entities/signal-alias.entity';
import { CatalogAuthoringService } from '../src/catalog/services/catalog-authoring.service';
import { COMPILER_VERSION } from '../src/catalog/formula/formula-compiler';
import { createTestDataSource, describeDb, undoMigrationNamed } from './db';

/**
 * Task QCE1, item 14 and the migration — publish is the enforcement point for
 * every formula on a class, and the migration's own down path is proven, not
 * assumed. The compiler's own refusals (items 1–13, 15, 16) live in
 * formula-compiler.spec.ts; this is where they meet the database.
 */
describeDb('formula compiler: publish and migration', () => {
  let ds: DataSource;
  let authoring: CatalogAuthoringService;

  const master: RequestScope = {
    tenantId: 'things-alive', userId: 'u-master', roles: ['master-admin'], isPlatformRole: true,
  };
  const CLASS_SLUG = 'diesel-generator';

  beforeAll(async () => {
    ds = await createTestDataSource();
    await ds.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await ds.runMigrations({ transaction: 'all' });
    authoring = new CatalogAuthoringService(
      ds.getRepository(EquipmentClassProfile),
      ds.getRepository(EquipmentClassFormula),
      ds.getRepository(ScenarioDefinition),
      ds.getRepository(SignalAlias),
      ds.getRepository(AlertRuleTemplate),
    );
  }, 30_000);

  afterAll(async () => { await ds?.destroy(); });

  beforeEach(async () => {
    await ds.query(
      `TRUNCATE TABLE "equipment_class_formula", "equipment_class_profile" RESTART IDENTITY CASCADE`,
    );
  });

  const seedDraft = () => ds.getRepository(EquipmentClassProfile).save(
    ds.getRepository(EquipmentClassProfile).create({
      slug: CLASS_SLUG, version: 1, name: 'Diesel Generator', status: 'draft',
      expectedSignals: [
        { signal: 'coolant_temp_c', unit: 'degC', required: true },
        { signal: 'active_power', unit: 'MW', required: true },
      ],
    }),
  );

  describe('publish', () => {
    it('14. refuses to publish a version containing a formula that fails to compile, naming it and why', async () => {
      await seedDraft();
      await ds.getRepository(EquipmentClassFormula).save(ds.getRepository(EquipmentClassFormula).create({
        classSlug: CLASS_SLUG, classVersion: 1, formulaKey: 'broken_formula', kind: 'empirical',
        expression: 'avg(coolant_temp_c) + avg(active_power)', // degC + MW: different units
        inputs: ['coolant_temp_c', 'active_power'], status: 'proposed',
      }));

      await expect(authoring.publishClass(master, CLASS_SLUG)).rejects.toThrow(
        /Cannot publish "diesel-generator" v1: formula "broken_formula": "\+" combines "degC" and "MW"/,
      );

      const stillDraft = await ds.getRepository(EquipmentClassProfile).findOneOrFail({
        where: { slug: CLASS_SLUG, version: 1 },
      });
      expect(stillDraft.status).toBe('draft');
    });

    it('names every failing formula, not just the first', async () => {
      await seedDraft();
      const formulas = ds.getRepository(EquipmentClassFormula);
      await formulas.save(formulas.create({
        classSlug: CLASS_SLUG, classVersion: 1, formulaKey: 'first_broken', kind: 'empirical',
        expression: 'unknown_fn(coolant_temp_c)', inputs: ['coolant_temp_c'], status: 'proposed',
      }));
      await formulas.save(formulas.create({
        classSlug: CLASS_SLUG, classVersion: 1, formulaKey: 'second_broken', kind: 'empirical',
        expression: 'avg(nonexistent_signal)', inputs: [], status: 'proposed',
      }));

      await expect(authoring.publishClass(master, CLASS_SLUG)).rejects.toThrow(
        /formula "first_broken".*formula "second_broken"/s,
      );
    });

    it('compiles a valid formula and persists the plan, result_unit and required_signals', async () => {
      await seedDraft();
      await ds.getRepository(EquipmentClassFormula).save(ds.getRepository(EquipmentClassFormula).create({
        classSlug: CLASS_SLUG, classVersion: 1, formulaKey: 'generation_mwh', kind: 'empirical',
        expression: 'integrate(active_power)', inputs: ['active_power'], status: 'proposed',
      }));

      const published = await authoring.publishClass(master, CLASS_SLUG);
      expect(published.status).toBe('published');

      const formula = await ds.getRepository(EquipmentClassFormula).findOneOrFail({
        where: { classSlug: CLASS_SLUG, classVersion: 1, formulaKey: 'generation_mwh' },
      });
      expect(formula.resultUnit).toBe('MWh');
      expect(formula.requiredSignals).toEqual(['active_power']);
      expect(formula.requiredParameters).toEqual([]);
      expect(formula.compilerVersion).toBe(COMPILER_VERSION);
      expect(formula.compiledAt).not.toBeNull();
      expect(formula.compiledPlan).toMatchObject({ type: 'call', name: 'integrate' });
    });

    it('refuses when the formula\'s own declared result_kind disagrees with what it computes', async () => {
      await seedDraft();
      await ds.getRepository(EquipmentClassFormula).save(ds.getRepository(EquipmentClassFormula).create({
        classSlug: CLASS_SLUG, classVersion: 1, formulaKey: 'raw_series', kind: 'empirical',
        expression: 'coolant_temp_c', inputs: ['coolant_temp_c'], status: 'proposed',
        resultKind: 'scalar',
      }));

      await expect(authoring.publishClass(master, CLASS_SLUG)).rejects.toThrow(
        /formula "raw_series": declared result_kind "scalar" does not match the inferred kind "series"/,
      );
    });
  });

  describe('the migration', () => {
    it('has a down path that leaves the KPI presentation columns behind, named explicitly', async () => {
      const [{ count: before }] = await ds.query(
        `SELECT count(*)::int FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'equipment_class_formula' AND column_name = 'result_kind'`,
      );
      expect(before).toBe(1);

      await undoMigrationNamed(ds, 'FormulaCompilerMetadata1758010000000');

      const [{ count: after }] = await ds.query(
        `SELECT count(*)::int FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'equipment_class_formula' AND column_name = 'result_kind'`,
      );
      expect(after).toBe(0);
      const [{ count: reqSignalsAfter }] = await ds.query(
        `SELECT count(*)::int FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'equipment_class_formula'
            AND column_name = 'required_signals'`,
      );
      expect(reqSignalsAfter).toBe(0);

      await ds.runMigrations({ transaction: 'all' });
    });
  });
});
