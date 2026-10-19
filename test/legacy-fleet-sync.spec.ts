import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { RequestScope } from '../src/auth/types/request-scope';
import { dataSourceOptions } from '../src/database/data-source';
import { FleetOnboardingService } from '../src/inventory/services/fleet-onboarding.service';
import { LegacyFleetSyncService, LEGACY_SOURCE_SYSTEM } from '../src/legacy/legacy-fleet-sync.service';
import { readLegacyFleet } from '../src/legacy/legacy-fleet.reader';
import { createLegacyDataSource } from '../src/legacy/legacy-source';
import { TenantMap } from '../src/projection/entities/tenant-map.entity';
import { ProjectionModule } from '../src/projection/projection.module';
import { ProjectionService } from '../src/projection/services/projection.service';
import { runTenantSpanning } from '../src/scope/tenant-session';
import { TEST_DB, createTestDataSource, describeDb } from './db';

/** Where the stand-in for 1.0 lives: its own schema in the test database, dropped and rebuilt here. */
const FIXTURE = 'legacy_fixture';

/**
 * IoT Platform 1.0's fleet tables, with the table and column names its own entities
 * use (`iot_platform_backend/src/equipment/entity/equipment.enity.ts`,
 * `src/device/entity/*.ts`). Only the columns the sync reads, plus one it does not
 * (`manuf_part_no`), so a test can tell a column ignored from a column missing.
 */
const FIXTURE_DDL = `
  CREATE SCHEMA ${FIXTURE};
  CREATE TABLE ${FIXTURE}.equipment_master (
    id serial PRIMARY KEY, equipment varchar(50) NOT NULL, ccl_number varchar(50), manuf_part_no varchar(80),
    description varchar(255), engine_type varchar(80), manufacturer varchar(120), model_number varchar(80),
    manuf_serial_no varchar(80), equipment_category varchar(80), equipment_category_txt varchar(80),
    equipment_type varchar(80), equipment_type_txt varchar(80), license_plate varchar(30), vin varchar(30),
    client_id int, plant_id int, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
  CREATE TABLE ${FIXTURE}.devices (
    id serial PRIMARY KEY, tool_name varchar(100) NOT NULL, imei_number varchar(100), type varchar(50),
    client_id int, equipment_id int, equipment_name varchar(100),
    created_at timestamp DEFAULT now(), updated_at timestamp DEFAULT now());
  CREATE TABLE ${FIXTURE}.sensors (id serial PRIMARY KEY, sensor_name varchar(100), client_id int,
    created_at timestamp DEFAULT now(), updated_at timestamp DEFAULT now());
  CREATE TABLE ${FIXTURE}.sensor_measurements (id serial PRIMARY KEY, name varchar(100) NOT NULL, unit varchar(50) NOT NULL,
    sensor_id int NOT NULL, created_at timestamp DEFAULT now(), updated_at timestamp DEFAULT now());
  CREATE TABLE ${FIXTURE}.device_sensors (id serial PRIMARY KEY, device_id int NOT NULL, sensor_id int NOT NULL,
    created_at timestamp DEFAULT now(), updated_at timestamp DEFAULT now());
  CREATE TABLE ${FIXTURE}.device_sensor_measurements (id serial PRIMARY KEY, device_sensor_id int NOT NULL,
    sensor_measurement_id int NOT NULL, is_kpi boolean DEFAULT false, calibration_offset float,
    threshold_max float, threshold_min float, created_at timestamp DEFAULT now(), updated_at timestamp DEFAULT now());
`;

/**
 * Client 7 is mapped to tenant-7; client 9 is in nobody's tenant map.
 *  101 DG 320, client 7, plant 5       → mirrored
 *  102 client 9's crane                → refused by the tenant map
 *  103 a machine with no client         → fails the contract
 *  201 logger on 101, client 7          → mirrored; 401/402 its two channels
 *  202 logger with no IMEI              → fails the contract
 */
const FIXTURE_ROWS = `
  INSERT INTO ${FIXTURE}.equipment_master (id, equipment, client_id, plant_id, equipment_category_txt, manufacturer, model_number, vin, manuf_part_no)
    VALUES (101, 'DG 320', 7, 5, 'Genset', 'LEROY SOMER', 'LSA46.2', 'VIN1', 'ignored'),
           (102, 'Crane', 9, NULL, NULL, NULL, NULL, NULL, NULL),
           (103, 'Orphan', NULL, NULL, NULL, NULL, NULL, NULL, NULL);
  INSERT INTO ${FIXTURE}.devices (id, tool_name, imei_number, type, client_id, equipment_id)
    VALUES (201, 'OBD CAN logger', '862211074240870', 'CAN', 7, 101),
           (202, 'Broken logger', NULL, 'CAN', 7, 101);
  INSERT INTO ${FIXTURE}.sensors (id, sensor_name) VALUES (1, 'OBD CAN');
  INSERT INTO ${FIXTURE}.sensor_measurements (id, name, unit, sensor_id) VALUES (11, 'coolant_temp_c', 'degC', 1), (12, 'oil_temp_c', 'degC', 1);
  INSERT INTO ${FIXTURE}.device_sensors (id, device_id, sensor_id) VALUES (301, 201, 1);
  INSERT INTO ${FIXTURE}.device_sensor_measurements (id, device_sensor_id, sensor_measurement_id, is_kpi, threshold_max)
    VALUES (401, 301, 11, true, 105), (402, 301, 12, false, NULL);
`;

/**
 * Mirroring the 1.0 fleet (task QSYNC1). The far side is a stand-in built from 1.0's
 * own column names and read over the real read-only connection, so the SQL in
 * `legacy-fleet.reader.ts` is exercised against the shape it claims, and a write on
 * that connection is refused by Postgres, not by this code.
 */
describeDb('legacy fleet sync: 1.0 machines, loggers and sensor map into the mirror', () => {
  let owner: DataSource;
  let ds: DataSource;
  let legacy: DataSource;
  let projections: ProjectionService;
  let sync: LegacyFleetSyncService;

  const staff: RequestScope = { tenantId: '', userId: 'staff-1', roles: ['master-admin'], isPlatformRole: true };
  const SAVED = { ...process.env };

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    await owner.query(`DROP SCHEMA IF EXISTS ${FIXTURE} CASCADE`);
    await owner.query(FIXTURE_DDL);

    const moduleRef = await Test.createTestingModule({
      imports: [TypeOrmModule.forRoot(dataSourceOptions(TEST_DB as any)), ProjectionModule],
    }).compile();
    ds = moduleRef.get(DataSource);
    projections = moduleRef.get(ProjectionService);

    legacy = createLegacyDataSource({
      host: TEST_DB.DB_HOST, port: Number(TEST_DB.DB_PORT), username: TEST_DB.DB_USERNAME,
      password: TEST_DB.DB_PASSWORD, database: TEST_DB.DB_DATABASE, schema: FIXTURE, ssl: false,
    });
    await legacy.initialize();
    Object.assign(process.env, {
      LEGACY_DB_HOST: TEST_DB.DB_HOST, LEGACY_DB_DATABASE: TEST_DB.DB_DATABASE,
      LEGACY_DB_USERNAME: TEST_DB.DB_USERNAME, LEGACY_DB_SCHEMA: FIXTURE,
    });
    sync = new LegacyFleetSyncService(ds, projections, legacy);
  }, 60_000);

  afterAll(async () => {
    process.env = SAVED;
    await legacy?.destroy();
    await owner?.query(`DROP SCHEMA IF EXISTS ${FIXTURE} CASCADE`);
    await ds?.destroy();
    await owner?.destroy();
  });

  beforeEach(async () => {
    await owner.query(`
      TRUNCATE TABLE "equipment_projection", "device_projection", "sensor_map_projection", "projection_rejection",
        "tenant_map", "equipment_profile", "device_inventory", "device_inventory_event" CASCADE`);
    await owner.getRepository(TenantMap).save({ sourceSystem: LEGACY_SOURCE_SYSTEM, externalClientId: '7', tenantId: 'tenant-7' });
    for (const t of ['device_sensor_measurements', 'device_sensors', 'sensor_measurements', 'sensors', 'devices', 'equipment_master']) {
      await owner.query(`TRUNCATE TABLE ${FIXTURE}.${t}`);
    }
    await owner.query(FIXTURE_ROWS);
  });

  const mirror = (sql: string) => runTenantSpanning(ds, 'test read', (m) => m.query(sql));

  it('mirrors 1.0\'s machines, loggers and channels under the mapped account, keyed by 1.0\'s ids', async () => {
    const r = await sync.run();
    expect(r.read).toEqual({ equipment: 3, devices: 2, sensorMap: 2 });

    expect(await mirror(`SELECT external_id, tenant_id, name, category, plant_external_id, payload, status
                           FROM equipment_projection ORDER BY external_id`)).toEqual([{
      external_id: '101', tenant_id: 'tenant-7', name: 'DG 320', category: 'Genset', plant_external_id: '5',
      payload: { manufacturer: 'LEROY SOMER', modelNumber: 'LSA46.2', vin: 'VIN1' }, status: 'live',
    }]);
    expect(await mirror(`SELECT external_id, tenant_id, imei, equipment_external_id, name FROM device_projection`)).toEqual([{
      external_id: '201', tenant_id: 'tenant-7', imei: '862211074240870', equipment_external_id: '101', name: 'OBD CAN logger',
    }]);
    // The channel key is the measurement id, which is what 1.0's telemetry log rows carry.
    expect(await mirror(`SELECT external_id, imei, signal, sensor_name, unit, payload->>'thresholdMax' AS max
                           FROM sensor_map_projection ORDER BY external_id`)).toEqual([
      { external_id: '401', imei: '862211074240870', signal: 'coolant_temp_c', sensor_name: 'OBD CAN', unit: 'degC', max: '105' },
      { external_id: '402', imei: '862211074240870', signal: 'oil_temp_c', sensor_name: 'OBD CAN', unit: 'degC', max: null },
    ]);
  });

  it('refuses rows it cannot place, and says why: no tenant mapping, or failing the contract', async () => {
    const r = await sync.run();
    expect(r.invalid).toEqual({ equipment: 1, devices: 1, sensorMap: 0 });
    expect(r.applied.equipment.rejected).toBe(1);
    const reasons = await mirror(`SELECT kind, external_id, reason FROM projection_rejection ORDER BY kind, external_id`);
    expect(reasons.map((x: { kind: string; external_id: string }) => [x.kind, x.external_id])).toEqual([
      ['device', '202'], ['equipment', '102'], ['equipment', '103'],
    ]);
    expect(reasons.find((x: { external_id: string }) => x.external_id === '102').reason).toMatch(/No tenant mapped for client "9"/);
    expect(reasons.find((x: { external_id: string }) => x.external_id === '202').reason).toMatch(/imei must be 14-17 digits/);
  });

  it('a second pass changes nothing, and does not record the same bad row twice', async () => {
    await sync.run();
    const before = await mirror(`SELECT external_id, checksum, synced_at FROM equipment_projection`);
    const r = await sync.run();
    expect(r.applied.equipment).toMatchObject({ inserted: 0, updated: 0, unchanged: 1 });
    expect(r.applied.devices).toMatchObject({ inserted: 0, updated: 0, unchanged: 1 });
    expect(r.applied.sensorMap).toMatchObject({ inserted: 0, updated: 0, unchanged: 2 });
    expect(await mirror(`SELECT external_id, checksum, synced_at FROM equipment_projection`)).toEqual(before);
    expect(await mirror(`SELECT count(*)::int AS n FROM projection_rejection WHERE reason LIKE 'Fails the snapshot contract%'`))
      .toEqual([{ n: 2 }]);
  });

  it('two passes at once both finish, and each row is written once', async () => {
    const results = await Promise.allSettled([sync.run(), sync.run()]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    expect(await mirror(`SELECT count(*)::int AS n FROM equipment_projection`)).toEqual([{ n: 1 }]);
    expect(await mirror(`SELECT count(*)::int AS n FROM sensor_map_projection`)).toEqual([{ n: 2 }]);
  });

  it('follows 1.0: a renamed machine is updated, a deleted channel is marked missing, not removed', async () => {
    await sync.run();
    await owner.query(`UPDATE ${FIXTURE}.equipment_master SET equipment = 'DG 320 kVA' WHERE id = 101`);
    await owner.query(`DELETE FROM ${FIXTURE}.device_sensor_measurements WHERE id = 402`);
    const r = await sync.run();
    expect(r.applied.equipment).toMatchObject({ updated: 1 });
    expect(r.applied.sensorMap).toMatchObject({ markedMissing: 1 });
    expect(await mirror(`SELECT name FROM equipment_projection WHERE external_id = '101'`)).toEqual([{ name: 'DG 320 kVA' }]);
    expect(await mirror(`SELECT external_id, status FROM sensor_map_projection ORDER BY external_id`)).toEqual([
      { external_id: '401', status: 'live' }, { external_id: '402', status: 'missing' },
    ]);
  });

  it('an empty read over a live mirror is refused rather than marking everything missing', async () => {
    await sync.run();
    await owner.query(`DELETE FROM ${FIXTURE}.device_sensor_measurements`);
    await expect(sync.run()).rejects.toMatchObject({ status: 409 });
    expect(await mirror(`SELECT count(*)::int AS n FROM sensor_map_projection WHERE status = 'live'`)).toEqual([{ n: 2 }]);

    const r = await sync.run({ allowEmpty: true });
    expect(r.applied.sensorMap).toMatchObject({ markedMissing: 2 });
  });

  it('a column 1.0 renames fails the pass loudly, and the mirror is left as it was', async () => {
    await sync.run();
    await owner.query(`ALTER TABLE ${FIXTURE}.equipment_master RENAME COLUMN vin TO vin_number`);
    try {
      await expect(sync.run()).rejects.toThrow(/column "vin" does not exist/);
      expect(await mirror(`SELECT count(*)::int AS n FROM equipment_projection WHERE status = 'live'`)).toEqual([{ n: 1 }]);
    } finally {
      await owner.query(`ALTER TABLE ${FIXTURE}.equipment_master RENAME COLUMN vin_number TO vin`);
    }
  });

  it('reads 1.0 only: the connection it reads through refuses a write', async () => {
    await expect(legacy.query(`INSERT INTO ${FIXTURE}.sensors (sensor_name) VALUES ('x')`))
      .rejects.toThrow(/read-only transaction/);
    await expect(legacy.transaction((m) => m.query(`UPDATE ${FIXTURE}.devices SET tool_name = 'x'`)))
      .rejects.toThrow(/read-only transaction/);
    expect((await readLegacyFleet(legacy, FIXTURE)).devices.map((d) => d.tool_name)).toEqual(['OBD CAN logger', 'Broken logger']);
  });

  it('refuses a schema name that is not a plain identifier, since it is written into the SQL', async () => {
    await expect(readLegacyFleet(legacy, 'public"; DROP TABLE x; --')).rejects.toThrow(/not a plain identifier/);
  });

  it('with no 1.0 connection it says so and changes nothing', async () => {
    const off = new LegacyFleetSyncService(ds, projections, null);
    await expect(off.run()).rejects.toMatchObject({ status: 503 });
    expect(await mirror(`SELECT count(*)::int AS n FROM equipment_projection`)).toEqual([{ n: 0 }]);
  });

  it('what it mirrors is what 1.0 fleet onboarding (QONBOARD1) needs to plan from', async () => {
    await sync.run();
    const plan = await new FleetOnboardingService(ds).plan(staff, 'tenant-7');
    expect(plan.createMachines).toEqual([{ sourceSystem: LEGACY_SOURCE_SYSTEM, externalId: '101', name: 'DG 320' }]);
    expect(plan.registerDevices).toEqual([{ imei: '862211074240870', sourceSystem: LEGACY_SOURCE_SYSTEM, equipmentExternalId: '101' }]);
  });
});
