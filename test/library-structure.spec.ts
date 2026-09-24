import { DataSource } from 'typeorm';
import { createTestDataSource, describeDb, undoMigrationNamed } from './db';

/**
 * The equipment library's schema guarantees (task QL1).
 *
 * Every one of these is asserted by attempting the thing it forbids and expecting the
 * database to refuse it, the same convention `signal-binding.spec.ts` uses and for the
 * same reason: a service check loses to a concurrent write, and the next person to
 * write a repository method will not know a rule existed unless the database enforces
 * it itself.
 */
describeDb('equipment library structure', () => {
  let ds: DataSource;

  const CLASS_SLUG = 'diesel-generator';
  const CLASS_VERSION = 1;

  beforeAll(async () => {
    ds = await createTestDataSource();
    await ds.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await ds.runMigrations({ transaction: 'all' });

    await ds.query(
      `INSERT INTO equipment_class_profile (slug, version, name, expected_signals)
       VALUES ($1, $2, 'Diesel Generator', $3::jsonb)`,
      [CLASS_SLUG, CLASS_VERSION, JSON.stringify([
        { signal: 'coolant_temp_c', unit: 'degC', required: true },
        { signal: 'oil_pressure_kpa', unit: 'kPa', required: true },
      ])],
    );
  }, 30_000);

  afterAll(async () => { await ds?.destroy(); });

  const requirement = (over: Record<string, unknown> = {}) => {
    const row = {
      class_slug: CLASS_SLUG, class_version: CLASS_VERSION,
      measurement_role: 'coolant_temp_c', component_scope: '',
      criticality: 'required', min_count: 1,
      ...over,
    } as Record<string, unknown>;
    const cols = Object.keys(row);
    return ds.query(
      `INSERT INTO equipment_class_sensor_requirement (${cols.join(',')})
       VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')}) RETURNING id`,
      Object.values(row),
    );
  };

  const formula = (over: Record<string, unknown> = {}) => {
    const row = {
      class_slug: CLASS_SLUG, class_version: CLASS_VERSION,
      formula_key: 'usable_fuel_liters', kind: 'empirical',
      expression: 'tank_capacity_liters * 0.95', version: 1,
      ...over,
    } as Record<string, unknown>;
    const cols = Object.keys(row);
    return ds.query(
      `INSERT INTO equipment_class_formula (${cols.join(',')})
       VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')}) RETURNING id`,
      Object.values(row),
    );
  };

  describe('a requirement can only name a role the class actually declares', () => {
    it('refuses a measurement_role the class never put in expected_signals', async () => {
      await expect(requirement({ measurement_role: 'fuel_flow_lph' }))
        .rejects.toThrow(/not declared in expected_signals/);
    });

    it('accepts a role the class does declare', async () => {
      await expect(requirement({ measurement_role: 'oil_pressure_kpa' })).resolves.toBeDefined();
    });
  });

  describe('enables names a real intelligence layer', () => {
    it('refuses a layer that is not in the enum', async () => {
      await expect(
        requirement({ measurement_role: 'oil_pressure_kpa', component_scope: 'x1', enables: ['telepathy'] }),
      ).rejects.toThrow(/ck_sensor_requirement_enables/);
    });

    it('accepts every real layer at once', async () => {
      await expect(
        requirement({
          measurement_role: 'oil_pressure_kpa', component_scope: 'x2',
          enables: ['data_quality', 'physics_calculation', 'predictive_ml'],
        }),
      ).resolves.toBeDefined();
    });
  });

  it('refuses a duplicate (class, role, component_scope)', async () => {
    await requirement({ measurement_role: 'oil_pressure_kpa', component_scope: 'dup' });
    await expect(
      requirement({ measurement_role: 'oil_pressure_kpa', component_scope: 'dup' }),
    ).rejects.toThrow(/uq_sensor_requirement/);
  });

  it('allows the same role twice on one machine when the component differs', async () => {
    // The composite case: two real probes for one role, distinguished by where they sit.
    await requirement({ measurement_role: 'oil_pressure_kpa', component_scope: 'hydraulic-tank' });
    await expect(
      requirement({ measurement_role: 'oil_pressure_kpa', component_scope: 'hopper' }),
    ).resolves.toBeDefined();
  });

  it('refuses min_count of zero, which is not "not required", it is unsatisfiable', async () => {
    await expect(
      requirement({ measurement_role: 'oil_pressure_kpa', component_scope: 'x3', min_count: 0 }),
    ).rejects.toThrow(/ck_sensor_requirement_min_count/);
  });

  it('refuses a requirement pointing at a class version that does not exist', async () => {
    await expect(
      requirement({ class_version: 999, measurement_role: 'coolant_temp_c', component_scope: 'x4' }),
    ).rejects.toThrow(/fk_sensor_requirement_class/);
  });

  describe('sensor_role_capability', () => {
    it('answers which catalogued sensor could satisfy a role', async () => {
      const [{ id: sensorId }] = await ds.query(
        `INSERT INTO sensor (sensor_name) VALUES ('Coolant Temp Probe') RETURNING id`,
      );
      await expect(
        ds.query(
          `INSERT INTO sensor_role_capability (sensor_id, measurement_role, parameter_key, canonical_unit)
           VALUES ($1, 'coolant_temp_c', 'temperature', 'degC') RETURNING id`,
          [sensorId],
        ),
      ).resolves.toBeDefined();
    });

    it('refuses pointing at a sensor that does not exist', async () => {
      await expect(
        ds.query(
          `INSERT INTO sensor_role_capability (sensor_id, measurement_role)
           VALUES ('00000000-0000-0000-0000-000000000000', 'coolant_temp_c')`,
        ),
      ).rejects.toThrow();
    });
  });

  describe('formulas: stored, never evaluated, and approval means something', () => {
    it('refuses two approved rows for one formula_key', async () => {
      await formula({ version: 10, status: 'approved', approved_by: 'deepak' });
      await expect(
        formula({ formula_key: 'usable_fuel_liters', version: 11, status: 'approved', approved_by: 'deepak' }),
      ).rejects.toThrow(/uq_class_formula_approved/);
    });

    it('allows several proposed versions of the same formula_key at once', async () => {
      await formula({ formula_key: 'derate_factor', version: 1, status: 'proposed' });
      await expect(
        formula({ formula_key: 'derate_factor', version: 2, status: 'proposed' }),
      ).resolves.toBeDefined();
    });

    it('refuses an approved formula with no named approver', async () => {
      await expect(
        formula({ formula_key: 'load_factor', version: 1, status: 'approved', approved_by: null }),
      ).rejects.toThrow(/ck_class_formula_approved_by/);
    });

    it('refuses a physics formula with no inputs', async () => {
      await expect(
        formula({ formula_key: 'derate_curve', kind: 'physics', inputs: [], version: 1 }),
      ).rejects.toThrow(/ck_class_formula_physics_inputs/);
    });

    it('accepts a physics formula once it names its inputs', async () => {
      await expect(
        formula({
          formula_key: 'derate_curve_v2', kind: 'physics', version: 1,
          inputs: ['ambient_temp_c', 'altitude_m'],
        }),
      ).resolves.toBeDefined();
    });
  });

  describe('the migration', () => {
    it('has a down path that leaves none of the three tables behind', async () => {
      const tables = [
        'equipment_class_sensor_requirement', 'sensor_role_capability', 'equipment_class_formula',
      ];
      const [{ count: before }] = await ds.query(
        `SELECT count(*)::int FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = ANY($1)`,
        [tables],
      );
      expect(before).toBe(3);

      // Not undoLastMigration() alone: "last" stops meaning "this one" the moment a
      // later migration is added, which is exactly what broke this test when
      // CatalogImport1757980000000 landed afterward. Name the migration.
      await undoMigrationNamed(ds, 'LibraryStructure1757970000000');

      const [{ count: after }] = await ds.query(
        `SELECT count(*)::int FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = ANY($1)`,
        [tables],
      );
      expect(after).toBe(0);

      await ds.runMigrations({ transaction: 'all' });
    });
  });
});
