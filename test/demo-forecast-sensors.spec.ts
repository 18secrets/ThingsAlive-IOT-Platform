import { DataSource } from 'typeorm';
import { DEMO_CLASS, DEMO_FORECAST_SIGNALS, seedDemo } from '../src/database/seeds/seed-demo';
import { forecastDeclarations } from '../src/forecast/forecast-inputs';
import { createTestDataSource, describeDb, undoMigrationNamed } from './db';

const NOW = new Date('2026-10-06T07:00:00.000Z');
const ENABLED = { SEED_DEMO_ENABLED: 'true' } as NodeJS.ProcessEnv;
const MIGRATION = 'DemoForecastSensors1762300000000';

/**
 * The demo forecasts the signals its failure modes watch: seeded that way now, and a demo
 * seeded before is brought up to it by the migration — which touches the seed-only demo
 * class and nothing else.
 */
describeDb('the demo class declares its forecasts', () => {
  let owner: DataSource;

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    await seedDemo(owner, { now: NOW, env: ENABLED });
    // A library class with the same roles, which no demo migration may touch.
    await owner.query(`INSERT INTO equipment_class_profile (slug, version, status, name, expected_signals)
      VALUES ('library-excavator', 1, 'published', 'Excavator', $1::jsonb)`,
    [JSON.stringify(DEMO_FORECAST_SIGNALS.map((s) => ({ signal: s, unit: 'u', required: true })))]);
    await owner.query(`INSERT INTO equipment_class_sensor_requirement (class_slug, class_version, measurement_role, canonical_unit)
      SELECT 'library-excavator', 1, s, 'u' FROM unnest($1::text[]) s`, [DEMO_FORECAST_SIGNALS]);
  }, 180_000);

  afterAll(async () => { await owner?.destroy(); });

  const declared = async (slug: string) =>
    (await forecastDeclarations(owner.manager, slug, 1)).map((r) => [r.measurementRole, r.forecastHorizonHours]).sort();

  it('1. a fresh seed declares coolant, hydraulic oil and oil pressure, 24 h each, and nothing else', async () => {
    expect(await declared(DEMO_CLASS)).toEqual([...DEMO_FORECAST_SIGNALS].sort().map((s) => [s, 24]));
  });

  // Last two: they take the schema down a step and put it back.
  it(`2. ${MIGRATION} down turns them off on the demo only; up turns them back on, and the library class is never touched`, async () => {
    await undoMigrationNamed(owner, MIGRATION);
    expect(await declared(DEMO_CLASS)).toEqual([]);
    expect(await declared('library-excavator')).toEqual([]);
    await owner.runMigrations({ transaction: 'all' });
    expect(await declared(DEMO_CLASS)).toHaveLength(3);
    expect(await declared('library-excavator')).toEqual([]);
  });

  it('3. a demo seeded before the declarations existed is brought up to them by the migration', async () => {
    await undoMigrationNamed(owner, MIGRATION);
    // As an older seed left it: none declared.
    await owner.query(`UPDATE equipment_class_sensor_requirement SET forecast_enabled = false, forecast_horizon_hours = NULL WHERE class_slug = $1`, [DEMO_CLASS]);
    await owner.runMigrations({ transaction: 'all' });
    expect(await declared(DEMO_CLASS)).toEqual([...DEMO_FORECAST_SIGNALS].sort().map((s) => [s, 24]));
  });
});
