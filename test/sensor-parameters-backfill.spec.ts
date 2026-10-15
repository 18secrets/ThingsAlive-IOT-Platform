import { DataSource } from 'typeorm';
import { createTestDataSource, describeDb, undoMigrationNamed } from './db';

const MIGRATION = 'SensorParametersFromCapabilities1760500000000';

/**
 * The backfill for sensors imported before TC_123 was fixed: each gains the parameters
 * its signal links name, and nothing it already declared is touched. Driven through
 * the migration itself — down to before it, seed what an old import left behind, up
 * again — because that is the only path this code ever runs on.
 */
describeDb(`${MIGRATION}: imported sensors get their parameters`, () => {
  let owner: DataSource;
  const specsOf = async (id: string) => (await owner.query(
    `SELECT parameter_specs AS specs FROM sensor WHERE id = $1`, [id],
  ))[0].specs as Record<string, unknown>[];

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
  }, 60_000);

  afterAll(async () => { await owner?.destroy(); });

  it('adds what the links name, keeps what was there, and its down path removes only what it added', async () => {
    await undoMigrationNamed(owner, MIGRATION);

    // What an old import left: a sensor declaring one channel by hand, with links for
    // that channel, a second keyed one, and one with no parameter_key at all.
    const [{ id }] = await owner.query(`
      INSERT INTO sensor (sensor_name, slug, parameter_specs)
      VALUES ('Oil Probe', 'oil-probe',
        '[{"parameter":"oil_p","unit":"bar","min":0,"max":10,"normalRange":"2-6","notes":"set by hand"}]'::jsonb)
      RETURNING id`);
    await owner.query(`
      INSERT INTO sensor_role_capability (sensor_id, measurement_role, parameter_key, canonical_unit, source) VALUES
        ($1, 'oil_pressure', 'oil_p', 'bar', 'excel-import'),
        ($1, 'oil_temp', 'oil_t', 'degC', 'excel-import'),
        ($1, 'oil_level', NULL, '%', 'excel-import')`, [id]);
    // A sensor with no links is left exactly as it is.
    const [{ id: untouched }] = await owner.query(`
      INSERT INTO sensor (sensor_name, slug, parameter_specs) VALUES ('Spare', 'spare', '[]'::jsonb) RETURNING id`);

    await owner.runMigrations({ transaction: 'all' });

    const after = await specsOf(id);
    expect(after[0]).toEqual({ parameter: 'oil_p', unit: 'bar', min: 0, max: 10, normalRange: '2-6', notes: 'set by hand' });
    expect(after.slice(1).map((s) => [s.parameter, s.unit, s.min, s.max])).toEqual([
      ['oil_level', '%', null, null],
      ['oil_t', 'degC', null, null],
    ]);
    expect(await specsOf(untouched)).toEqual([]);

    // Down removes the backfilled specs and nothing else — not the hand-written one,
    // and not one a later import added with the importer's own note.
    await owner.query(`
      UPDATE sensor SET parameter_specs = parameter_specs || '[{"parameter":"oil_x","unit":"","min":null,"max":null,"normalRange":"","notes":"From a catalog import: set the expected range."}]'::jsonb
       WHERE id = $1`, [id]);
    await undoMigrationNamed(owner, MIGRATION);
    expect((await specsOf(id)).map((s) => s.parameter)).toEqual(['oil_p', 'oil_x']);

    await owner.runMigrations({ transaction: 'all' });
    expect((await specsOf(id)).map((s) => s.parameter)).toEqual(['oil_p', 'oil_x', 'oil_level', 'oil_t']);
  });
});
