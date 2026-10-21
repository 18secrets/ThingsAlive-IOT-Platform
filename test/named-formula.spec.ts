import { DataSource } from 'typeorm';
import { RequestScope } from '../src/auth/types/request-scope';
import { NamedFormula } from '../src/catalog/entities/named-formula.entity';
import { NamedFormulaService } from '../src/catalog/services/named-formula.service';
import { createAppDataSource, createTestDataSource, describeDb } from './db';

const scope: RequestScope = { tenantId: '', userId: 'deepak', roles: [], isPlatformRole: true };

/**
 * The named formula catalogue (task QCE3): platform physics, authored once,
 * published, immutable. Draft/publish mirrors `equipment_class_profile` and
 * `CatalogAuthoringService` on purpose — a second versioned-content lifecycle that
 * worked differently would be a second thing to get wrong.
 */
describeDb('named formula catalogue', () => {
  let ds: DataSource;
  let owner: DataSource;
  let service: NamedFormulaService;

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    ds = await createAppDataSource();
    service = new NamedFormulaService(ds.getRepository(NamedFormula));
  }, 30_000);

  afterAll(async () => { await ds?.destroy(); await owner?.destroy(); });

  beforeEach(async () => {
    // Seeded migration content stays — these tests use their own slugs throughout,
    // so the seven real named formulas are simply other rows in the table.
    await owner.query(`DELETE FROM "named_formula" WHERE "created_by" = 'deepak'`);
  });

  const draft = (over: Partial<Parameters<NamedFormulaService['create']>[2]> = {}) => ({
    name: 'Specific Fuel Consumption',
    expression: 'fuel_rate / power_output',
    inputs: [
      { role: 'fuel_rate', dimension: 'L/h' },
      { role: 'power_output', dimension: 'kW' },
    ],
    ...over,
  });

  it('1. an expression that does not compile cannot be published', async () => {
    await service.create(scope, 'bad-formula', draft({ expression: 'fuel_rate / )' }));
    await expect(service.publish(scope, 'bad-formula', 1)).rejects.toThrow(/Cannot publish/);
  });

  it('2. result_dimension disagreeing with the inferred dimension refuses the publish, naming both', async () => {
    await service.create(scope, 'wrong-dimension', draft({ resultDimension: 'kg' }));
    let message = '';
    try {
      await service.publish(scope, 'wrong-dimension', 1);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/kg/);
    expect(message).toMatch(/L\/kW\/h/);
  });

  it('3. a published named formula cannot be edited; a draft can', async () => {
    await service.create(scope, 'editable', draft());
    await expect(service.edit(scope, 'editable', 1, { description: 'draft edit' })).resolves.toMatchObject({
      description: 'draft edit',
    });

    await service.publish(scope, 'editable', 1);
    await expect(service.edit(scope, 'editable', 1, { description: 'too late' }))
      .rejects.toThrow(/published and cannot be edited/);
  });

  it('publishing leaves result_kind and result_unit inferred, when neither was declared', async () => {
    await service.create(scope, 'infer-me', draft());
    const published = await service.publish(scope, 'infer-me', 1);
    expect(published.resultKind).toBe('series');
    expect(published.resultUnit).toBe('L/kW/h');
    expect(published.resultDimension).toBe('L/kW/h');
  });

  it('a second create forks the next version once the current one is published', async () => {
    await service.create(scope, 'versioned', draft());
    await service.publish(scope, 'versioned', 1);
    const v2 = await service.create(scope, 'versioned', draft({ description: 'v2' }));
    expect(v2.version).toBe(2);
    expect(v2.status).toBe('draft');
  });
});
