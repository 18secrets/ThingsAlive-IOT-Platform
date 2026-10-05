import { DataSource } from 'typeorm';
import { DeviceCatalogController } from '../src/device-catalog/device-catalog.controller';
import { Sensor } from '../src/device-catalog/entities/sensor.entity';
import { SensorCategory } from '../src/device-catalog/entities/sensor-category.entity';
import { SensorRoleCapability } from '../src/device-catalog/entities/sensor-role-capability.entity';
import { ToolMapping } from '../src/device-catalog/entities/tool-mapping.entity';
import { DeviceCatalogService } from '../src/device-catalog/services/device-catalog.service';
import { retiredSensorProblem } from '../src/device-catalog/services/sensor-retirement';
import { createAppDataSource, createTestDataSource, describeDb, undoMigrationNamed } from './db';

const MIGRATION = 'SensorRetirement1758100000000';

describe('sensor retirement (pure)', () => {
  it('names the sensor, its slug and the day it was retired', () => {
    expect(retiredSensorProblem({
      sensorName: 'Coolant Temp', slug: 'coolant-temp', retiredAt: new Date('2026-10-01T09:00:00Z'),
    })).toBe('sensor "Coolant Temp" (coolant-temp) was retired on 2026-10-01 and cannot be used on new content (sensor_retired).');
    expect(retiredSensorProblem({ sensorName: 'x', slug: 'x', retiredAt: null })).toBeNull();
  });

  it('includeRetired is true or false — anything else is refused, not read as false', () => {
    const controller = new DeviceCatalogController({ listSensors: async () => [] } as any);
    expect(() => controller.listSensors('yes')).toThrow('includeRetired must be true or false');
  });
});

describeDb('sensor retirement: migration, seeded before it runs', () => {
  let owner: DataSource;

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
  }, 30_000);

  afterAll(async () => { await owner?.destroy(); });

  it('existing sensors and categories come through live, and the down path leaves nothing behind', async () => {
    await undoMigrationNamed(owner, MIGRATION);
    const [cat] = await owner.query(`INSERT INTO sensor_category (name) VALUES ('Engine') RETURNING id`);
    await owner.query(
      `INSERT INTO sensor (sensor_name, slug, category_id) VALUES ('Coolant Temp', 'coolant-temp', $1)`, [cat.id],
    );

    await owner.runMigrations({ transaction: 'all' });
    const rows = await owner.query(`SELECT retired_at, retired_by FROM sensor UNION ALL SELECT retired_at, retired_by FROM sensor_category`);
    expect(rows).toEqual([{ retired_at: null, retired_by: null }, { retired_at: null, retired_by: null }]);

    await undoMigrationNamed(owner, MIGRATION);
    const [{ count: columns }] = await owner.query(
      `SELECT count(*)::int FROM information_schema.columns
        WHERE table_name IN ('sensor', 'sensor_category') AND column_name IN ('retired_at', 'retired_by')`);
    const [{ count: triggers }] = await owner.query(
      `SELECT count(*)::int FROM pg_trigger WHERE tgname IN ('trg_sensor_category_live', 'trg_sensor_category_retire_empty')`);
    expect(columns).toBe(0);
    expect(triggers).toBe(0);
    // The seeded rows survive the round trip.
    const [{ count: sensors }] = await owner.query(`SELECT count(*)::int FROM sensor`);
    expect(sensors).toBe(1);

    await owner.runMigrations({ transaction: 'all' });
  });
});

describeDb('sensor retirement: retire, un-retire and the category rule, as ta_app', () => {
  let owner: DataSource;
  let ds: DataSource;
  let catalog: DeviceCatalogService;
  let engine: SensorCategory;
  let coolant: Sensor;
  let oil: Sensor;

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    ds = await createAppDataSource();
    catalog = new DeviceCatalogService(
      ds.getRepository(SensorCategory), ds.getRepository(Sensor), ds.getRepository(ToolMapping),
    );
  }, 30_000);

  afterAll(async () => { await ds?.destroy(); await owner?.destroy(); });

  beforeEach(async () => {
    for (const t of ['tool_mapping', 'sensor_role_capability', 'sensor', 'sensor_category']) {
      await owner.query(`DELETE FROM "${t}"`);
    }
    engine = await owner.getRepository(SensorCategory).save({ name: 'Engine' });
    const spec = (parameter: string, unit: string) => [{ parameter, unit, min: 0, max: 200, normalRange: '0-200' }];
    coolant = await owner.getRepository(Sensor).save({
      sensorName: 'Coolant Temp', slug: 'coolant-temp', categoryId: engine.id, parameterSpecs: spec('coolant_temp_c', 'degC'),
    });
    oil = await owner.getRepository(Sensor).save({
      sensorName: 'Oil Pressure', slug: 'oil-pressure', categoryId: engine.id, parameterSpecs: spec('oil_pressure_kpa', 'kPa'),
    });
  });

  const names = (rows: { sensorName: string }[]) => rows.map((r) => r.sensorName);

  it('1. a retired sensor leaves the default list and stays in includeRetired, with who and when', async () => {
    const retired = await catalog.retireSensor(coolant.id, 'u-librarian');
    expect(retired.retiredAt).toBeInstanceOf(Date);
    expect(retired.retiredBy).toBe('u-librarian');

    expect(names(await catalog.listSensors())).toEqual(['Oil Pressure']);
    expect(names(await catalog.listSensors(true))).toEqual(['Coolant Temp', 'Oil Pressure']);
  });

  it('2. what already uses a retired sensor keeps working: its mapping resolves it, its capability rows stay', async () => {
    const mapping = await catalog.createToolMapping({
      toolName: 'DG logger', mappedSensors: [{ sensorId: coolant.id, parameters: ['coolant_temp_c'] }],
    });
    await owner.getRepository(SensorRoleCapability).save({ sensorId: coolant.id, measurementRole: 'coolant_temp_c' });

    await catalog.retireSensor(coolant.id, 'u-librarian');

    const after = await catalog.getToolMapping(mapping.id);
    expect(after.mappedSensors).toEqual([
      { sensorId: coolant.id, sensorName: 'Coolant Temp', parameters: ['coolant_temp_c'] },
    ]);
    expect(await owner.getRepository(SensorRoleCapability).count({ where: { sensorId: coolant.id } })).toBe(1);

    // An unrelated edit to the mapping that already carried it is not new use.
    const renamed = await catalog.updateToolMapping(mapping.id, {
      toolName: 'DG logger v2', mappedSensors: [{ sensorId: coolant.id, parameters: ['coolant_temp_c'] }],
    });
    expect(renamed.toolName).toBe('DG logger v2');
  });

  it('3. new content naming a retired sensor is refused, naming the sensor and the date', async () => {
    const retired = await catalog.retireSensor(coolant.id, 'u-librarian');
    const day = retired.retiredAt!.toISOString().slice(0, 10);

    await expect(catalog.createToolMapping({
      toolName: 'New logger', mappedSensors: [{ sensorId: coolant.id, parameters: ['coolant_temp_c'] }],
    })).rejects.toThrow(`sensor "Coolant Temp" (coolant-temp) was retired on ${day}`);

    // Adding it to an existing mapping that did not have it is new use too.
    const mapping = await catalog.createToolMapping({
      toolName: 'Oil logger', mappedSensors: [{ sensorId: oil.id, parameters: ['oil_pressure_kpa'] }],
    });
    await expect(catalog.updateToolMapping(mapping.id, {
      mappedSensors: [
        { sensorId: oil.id, parameters: ['oil_pressure_kpa'] },
        { sensorId: coolant.id, parameters: ['coolant_temp_c'] },
      ],
    })).rejects.toThrow('sensor_retired');
  });

  it('5. un-retiring returns it to the picker and clears who retired it', async () => {
    await catalog.retireSensor(coolant.id, 'u-librarian');
    const back = await catalog.unretireSensor(coolant.id);
    expect(back.retiredAt).toBeNull();
    expect(back.retiredBy).toBeNull();
    expect(names(await catalog.listSensors())).toEqual(['Coolant Temp', 'Oil Pressure']);
  });

  it('retire is idempotent: retiring again keeps the original who and when', async () => {
    const first = await catalog.retireSensor(coolant.id, 'u-first');
    const second = await catalog.retireSensor(coolant.id, 'u-second');
    expect(second.retiredBy).toBe('u-first');
    expect(second.retiredAt).toEqual(first.retiredAt);
  });

  it('two retires fired together both settle, and the sensor is retired once', async () => {
    const results = await Promise.allSettled([
      catalog.retireSensor(coolant.id, 'u-a'), catalog.retireSensor(coolant.id, 'u-b'),
    ]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    const [a, b] = results.map((r) => (r as PromiseFulfilledResult<Sensor>).value);
    expect(a.retiredBy).toBe(b.retiredBy);
    expect(a.retiredAt).toEqual(b.retiredAt);
  });

  it('6. a category holding a live sensor cannot be retired; the refusal names the sensors', async () => {
    await expect(catalog.retireCategory(engine.id, 'u-librarian'))
      .rejects.toThrow('category "Engine" still holds 2 live sensor(s): Coolant Temp, Oil Pressure');

    await catalog.retireSensor(coolant.id, 'u-librarian');
    await expect(catalog.retireCategory(engine.id, 'u-librarian')).rejects.toThrow('1 live sensor(s): Oil Pressure');

    await catalog.retireSensor(oil.id, 'u-librarian');
    const retired = await catalog.retireCategory(engine.id, 'u-librarian');
    expect(retired.retiredAt).toBeInstanceOf(Date);
    expect(await catalog.listCategories()).toEqual([]);
    expect((await catalog.listCategories(true)).map((c) => c.name)).toEqual(['Engine']);
  });

  it('the database refuses it too, not only the service — attempted directly as ta_app', async () => {
    await expect(ds.query(`UPDATE sensor_category SET retired_at = now() WHERE id = $1`, [engine.id]))
      .rejects.toThrow('ck_sensor_category_retire_empty');

    await ds.query(`UPDATE sensor SET retired_at = now() WHERE category_id = $1`, [engine.id]);
    await ds.query(`UPDATE sensor_category SET retired_at = now() WHERE id = $1`, [engine.id]);

    // No way back into a retired category: not by un-retiring, not by inserting, not by moving.
    await expect(ds.query(`UPDATE sensor SET retired_at = NULL WHERE id = $1`, [coolant.id]))
      .rejects.toThrow('ck_sensor_category_live');
    await expect(ds.query(
      `INSERT INTO sensor (sensor_name, slug, category_id) VALUES ('Fuel Level', 'fuel-level', $1)`, [engine.id],
    )).rejects.toThrow('ck_sensor_category_live');
    const [other] = await owner.query(`INSERT INTO sensor_category (name) VALUES ('Fuel') RETURNING id`);
    const [fuel] = await owner.query(
      `INSERT INTO sensor (sensor_name, slug, category_id) VALUES ('Fuel Level', 'fuel-level', $1) RETURNING id`, [other.id],
    );
    await expect(ds.query(`UPDATE sensor SET category_id = $1 WHERE id = $2`, [engine.id, fuel.id]))
      .rejects.toThrow('ck_sensor_category_live');
  });

  it('through the service, the same refusals arrive as readable messages', async () => {
    await catalog.retireSensor(coolant.id, 'u');
    await catalog.retireSensor(oil.id, 'u');
    await catalog.retireCategory(engine.id, 'u');

    await expect(catalog.unretireSensor(coolant.id)).rejects.toThrow('which was retired on');
    await expect(catalog.createSensor({ sensorName: 'Fuel Level', categoryId: engine.id }))
      .rejects.toThrow('Sensor category "Engine" was retired on');
    await expect(catalog.createCategory('Engine')).rejects.toThrow('un-retire it instead');

    await catalog.unretireCategory(engine.id);
    expect((await catalog.unretireSensor(coolant.id)).retiredAt).toBeNull();
  });

  it('an unknown or malformed id is a 404, not a 500', async () => {
    await expect(catalog.retireSensor('00000000-0000-0000-0000-000000000000', 'u')).rejects.toThrow('No sensor');
    await expect(catalog.retireSensor('not-a-uuid', 'u')).rejects.toThrow('No sensor');
    await expect(catalog.retireCategory('not-a-uuid', 'u')).rejects.toThrow('No category');
  });

  /**
   * The race the triggers exist for, made deterministic: one transaction holds its
   * write open while the other is attempted, then commits. Whichever goes second must
   * be refused, or a live sensor ends up filed under a category nobody can see.
   */
  const holdOpen = async (sql: string, params: unknown[], then: () => Promise<unknown>) => {
    const runner = ds.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    try {
      await runner.query(sql, params);
      const attempt = then();
      attempt.catch(() => undefined);
      await new Promise((r) => setTimeout(r, 300)); // long enough to be blocked on the row lock
      await runner.commitTransaction();
      return await Promise.allSettled([attempt]).then(([r]) => r);
    } finally {
      await runner.release();
    }
  };

  it('race: a sensor un-retired while the category is being retired — the category retire is refused', async () => {
    await catalog.retireSensor(coolant.id, 'u');
    await catalog.retireSensor(oil.id, 'u');

    const outcome = await holdOpen(
      `UPDATE sensor SET retired_at = NULL, retired_by = NULL WHERE id = $1`, [coolant.id],
      () => catalog.retireCategory(engine.id, 'u'),
    );
    expect(outcome.status).toBe('rejected');
    expect(String((outcome as PromiseRejectedResult).reason)).toContain('Coolant Temp');
    const [{ retired_at }] = await owner.query(`SELECT retired_at FROM sensor_category WHERE id = $1`, [engine.id]);
    expect(retired_at).toBeNull();
  });

  it('race: a category retired while a sensor in it is being un-retired — the un-retire is refused', async () => {
    await catalog.retireSensor(coolant.id, 'u');
    await catalog.retireSensor(oil.id, 'u');

    const outcome = await holdOpen(
      `UPDATE sensor_category SET retired_at = now(), retired_by = 'u' WHERE id = $1`, [engine.id],
      () => catalog.unretireSensor(coolant.id),
    );
    expect(outcome.status).toBe('rejected');
    expect(String((outcome as PromiseRejectedResult).reason)).toContain('ck_sensor_category_live');
    const [{ retired_at }] = await owner.query(`SELECT retired_at FROM sensor WHERE id = $1`, [coolant.id]);
    expect(retired_at).not.toBeNull();
  });
});
