import { DataSource } from 'typeorm';
import { RequestScope } from '../src/auth/types/request-scope';
import { AlertRuleTemplate } from '../src/catalog/entities/alert-rule-template.entity';
import { EquipmentClassFormula } from '../src/catalog/entities/equipment-class-formula.entity';
import { EquipmentClassProfile } from '../src/catalog/entities/equipment-class-profile.entity';
import { NamedFormula } from '../src/catalog/entities/named-formula.entity';
import { ScenarioDefinition } from '../src/catalog/entities/scenario-definition.entity';
import { SignalAlias } from '../src/catalog/entities/signal-alias.entity';
import { CatalogAuthoringService } from '../src/catalog/services/catalog-authoring.service';
import { SensorRoleCapability } from '../src/device-catalog/entities/sensor-role-capability.entity';
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
      ds.getRepository(NamedFormula),
      ds.getRepository(SensorRoleCapability),
    );
  }, 30_000);

  afterAll(async () => { await ds?.destroy(); });

  beforeEach(async () => {
    await ds.query(
      `TRUNCATE TABLE "equipment_class_formula", "equipment_class_profile" RESTART IDENTITY CASCADE`,
    );
  });

  // Raw SQL, not the TypeORM repository — the same reason the migration test below
  // gives for its formula row: a repository insert is built from the entity's current
  // shape, and the migration tests unwind the schema to before some of its columns
  // existed (QSEED1's `seed_only` was the one that broke this). These five columns are
  // in every schema this file unwinds to.
  const seedDraft = () => ds.query(
    `INSERT INTO equipment_class_profile (slug, version, name, status, expected_signals)
       VALUES ($1, 1, 'Diesel Generator', 'draft', $2::jsonb)`,
    [CLASS_SLUG, JSON.stringify([
      { signal: 'coolant_temp_c', unit: 'degC', required: true },
      { signal: 'active_power', unit: 'MW', required: true },
    ])],
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

    // Task QCE1.1: result_kind's DEFAULT 'scalar' (1758010000000) turned "nobody
    // declared one" into "the author said scalar" — exactly what an imported
    // formula row looks like (catalog-import-apply.service.ts never sets
    // result_kind). `105 - coolant_temp_c`, the shipped template's own example, is
    // the expression that surfaced this: literal-unit-polymorphic in "-", so it
    // compiles, but its result is series-valued — which the old default refused.

    it('an imported formula with no declared result_kind publishes, and the persisted '
      + 'result_kind equals the inferred kind', async () => {
      await seedDraft();
      await ds.getRepository(EquipmentClassFormula).save(ds.getRepository(EquipmentClassFormula).create({
        classSlug: CLASS_SLUG, classVersion: 1, formulaKey: 'coolant_margin_c', kind: 'empirical',
        expression: '105 - coolant_temp_c', inputs: ['coolant_temp_c'], status: 'proposed',
        // No resultKind — exactly what an imported row looks like before publish.
      }));

      const published = await authoring.publishClass(master, CLASS_SLUG);
      expect(published.status).toBe('published');

      const formula = await ds.getRepository(EquipmentClassFormula).findOneOrFail({
        where: { classSlug: CLASS_SLUG, classVersion: 1, formulaKey: 'coolant_margin_c' },
      });
      expect(formula.resultKind).toBe('series');
      expect(formula.resultUnit).toBe('degC');
    });

    it('an imported formula WITH a declared result_kind that disagrees with inference '
      + 'still refuses to publish', async () => {
      await seedDraft();
      await ds.getRepository(EquipmentClassFormula).save(ds.getRepository(EquipmentClassFormula).create({
        classSlug: CLASS_SLUG, classVersion: 1, formulaKey: 'coolant_margin_c', kind: 'empirical',
        expression: '105 - coolant_temp_c', inputs: ['coolant_temp_c'], status: 'proposed',
        resultKind: 'scalar', // declared, and wrong — this expression is series-valued.
      }));

      await expect(authoring.publishClass(master, CLASS_SLUG)).rejects.toThrow(
        /formula "coolant_margin_c": declared result_kind "scalar" does not match the inferred kind "series"/,
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

    it('DeclaredKindIsOptional1758020000000 has a down path that restores '
      + 'NOT NULL DEFAULT \'scalar\' on result_kind, named explicitly', async () => {
      const [{ isNullable: before }] = await ds.query(`
        SELECT is_nullable AS "isNullable" FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'equipment_class_formula' AND column_name = 'result_kind'`);
      expect(before).toBe('YES');

      await undoMigrationNamed(ds, 'DeclaredKindIsOptional1758020000000');

      const [{ isNullable: after, columnDefault }] = await ds.query(`
        SELECT is_nullable AS "isNullable", column_default AS "columnDefault" FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'equipment_class_formula' AND column_name = 'result_kind'`);
      expect(after).toBe('NO');
      expect(columnDefault).toMatch(/scalar/);

      await ds.runMigrations({ transaction: 'all' });
    });

    // Caught on Railway's Development database, not by any test until now: every
    // local run starts from an empty table, where `UPDATE ... SET result_kind =
    // NULL` has nothing to violate even if it runs before `DROP NOT NULL` rather
    // than after. A real imported-but-unpublished row - written under the old
    // NOT NULL DEFAULT 'scalar', exactly like a catalog-import row is - has
    // something to violate, and did.
    it('DeclaredKindIsOptional1758020000000 runs forward cleanly over a row already '
      + 'carrying the old NOT NULL DEFAULT, not just over an empty table', async () => {
      await undoMigrationNamed(ds, 'DeclaredKindIsOptional1758020000000');
      await seedDraft();

      // Raw SQL, not the TypeORM repository: the entity class now also declares
      // QCE3's named_formula_slug/named_formula_version/bindings columns, which do
      // not exist in the schema this far back — a repository insert or select would
      // reach for them regardless of how far the schema has been unwound, because
      // TypeORM builds its query from the entity's current shape, not the database's.
      // The raw INSERT below writes exactly the columns this historical schema has.
      const [{ id: formulaId }] = await ds.query(`
        INSERT INTO equipment_class_formula (class_slug, class_version, formula_key, kind, expression)
          VALUES ('diesel-generator', 1, 'pre_existing_row', 'empirical', 'avg(coolant_temp_c)')
          RETURNING id`);
      // resultKind deliberately left for the column's own NOT NULL DEFAULT 'scalar'
      // to fill in, exactly as an imported row would have it.
      const [{ result_kind: before }] = await ds.query(
        `SELECT result_kind FROM equipment_class_formula WHERE id = $1`, [formulaId],
      );
      expect(before).toBe('scalar');

      // If this throws, the test fails with the real error - a generic
      // "did not throw" assertion would only hide it.
      await ds.runMigrations({ transaction: 'all' });

      const after = await ds.getRepository(EquipmentClassFormula).findOneByOrFail({ id: formulaId });
      expect(after.resultKind).toBeNull();
    });
  });
});
