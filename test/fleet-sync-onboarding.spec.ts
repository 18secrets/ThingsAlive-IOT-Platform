import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { dataSourceOptions } from '../src/database/data-source';
import { DeviceInventory } from '../src/inventory/entities/device-inventory.entity';
import { FLEET_SYNC_ACTOR, FleetOnboardingService } from '../src/inventory/services/fleet-onboarding.service';
import { LegacyFleetSyncService, LEGACY_SOURCE_SYSTEM } from '../src/legacy/legacy-fleet-sync.service';
import { LegacyDeviceRow, LegacyEquipmentRow, LegacyFleet } from '../src/legacy/legacy-fleet.reader';
import { TenantMap } from '../src/projection/entities/tenant-map.entity';
import { ProjectionModule } from '../src/projection/projection.module';
import { ProjectionService } from '../src/projection/services/projection.service';
import { TEST_DB, createTestDataSource, describeDb } from './db';

const TENANT = 'tenant-7';
const IMEI = '862211074240870';
const OTHER_IMEI = '862211074240871';

const machine = (id: number, name: string): LegacyEquipmentRow => ({
  id, client_id: 7, equipment: name, plant_id: null, equipment_category: null, equipment_category_txt: null,
  equipment_type_txt: null, manufacturer: null, model_number: null, manuf_serial_no: null, engine_type: null,
  ccl_number: null, description: null, license_plate: null, vin: null, updated_at: null,
});
const logger = (id: number, imei: string, equipmentId: number | null): LegacyDeviceRow => ({
  id, client_id: 7, imei_number: imei, tool_name: 'OBD CAN logger', type: 'CAN', equipment_id: equipmentId, updated_at: null,
});

/** Two machines in 1.0; one logger mapped to 101, one in 1.0 but on no machine. */
const FLEET: LegacyFleet = {
  equipment: [machine(101, 'DG 320'), machine(102, 'DG 500')],
  devices: [logger(201, IMEI, 101), logger(202, OTHER_IMEI, null)],
  sensorMap: [],
};

/**
 * A device mapped to a machine in 1.0 is mapped in 2.0 too (17 Nov 2026): the fleet sync
 * carries each 1.0 mapping into 2.0's register after every pass, instead of leaving it
 * in the mirror until somebody runs fleet onboarding by hand. Driven through
 * `LegacyFleetSyncService.apply`, the pass the daily tick runs, with the 1.0 rows passed
 * in, so the sync and the onboarding are the real ones and only the far database is not.
 */
describeDb('fleet sync carries 1.0 device-to-machine mappings into 2.0', () => {
  let owner: DataSource;
  let ds: DataSource;
  let sync: LegacyFleetSyncService;
  let onboarding: FleetOnboardingService;

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    const moduleRef = await Test.createTestingModule({
      imports: [TypeOrmModule.forRoot(dataSourceOptions(TEST_DB as any)), ProjectionModule],
    }).compile();
    ds = moduleRef.get(DataSource);
    onboarding = new FleetOnboardingService(ds);
    sync = new LegacyFleetSyncService(ds, moduleRef.get(ProjectionService), null, onboarding);
  }, 60_000);

  afterAll(async () => {
    await ds?.destroy();
    await owner?.destroy();
  });

  beforeEach(async () => {
    await owner.query(`
      TRUNCATE TABLE "equipment_projection", "device_projection", "sensor_map_projection", "projection_rejection",
        "tenant_map", "equipment_profile", "device_inventory", "device_inventory_event" CASCADE`);
    await owner.getRepository(TenantMap).save({ sourceSystem: LEGACY_SOURCE_SYSTEM, externalClientId: '7', tenantId: TENANT });
  });

  const held = (imei: string) => owner.getRepository(DeviceInventory).findOne({ where: { imei } });
  const events = async () => (await owner.query(`SELECT count(*)::int AS n FROM device_inventory_event`))[0].n as number;

  it('a logger mapped in 1.0 is claimed onto the same machine in 2.0 after one pass, by the sync', async () => {
    const r = await sync.apply(FLEET);

    expect(r.onboarded).toEqual({ [TENANT]: { machines: 2, registered: 1, claimed: 0, conflicts: 0 } });
    expect(await held(IMEI)).toMatchObject({
      tenantId: TENANT, state: 'assigned', equipmentExternalId: '101', claimedBy: FLEET_SYNC_ACTOR.userId,
    });
    // Ordered by action, not id: the ids are not sequential, and the three land in one transaction.
    const history = await owner.query(`SELECT action, actor_user_id FROM device_inventory_event WHERE imei = $1 ORDER BY action`, [IMEI]);
    expect(history).toEqual(['assign', 'claim', 'register'].map((action) => ({ action, actor_user_id: FLEET_SYNC_ACTOR.userId })));
  });

  it('a logger 1.0 has on no machine is not registered: unmapped stays unmapped', async () => {
    await sync.apply(FLEET);
    expect(await held(OTHER_IMEI)).toBeNull();
  });

  it('a second pass adds nothing: the mapping and its history are written once', async () => {
    await sync.apply(FLEET);
    const before = await events();
    const again = await sync.apply(FLEET);

    expect(again.onboarded).toEqual({ [TENANT]: { machines: 0, registered: 0, claimed: 0, conflicts: 0 } });
    expect(await events()).toBe(before);
  });

  it('two passes fired together both settle, and the mapping is written once', async () => {
    const results = await Promise.allSettled([sync.apply(FLEET), sync.apply(FLEET)]);

    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    expect(await owner.query(`SELECT count(*)::int AS n FROM device_inventory WHERE imei = $1`, [IMEI])).toEqual([{ n: 1 }]);
    expect(await owner.query(`SELECT count(*)::int AS n FROM device_inventory_event WHERE imei = $1 AND action = 'claim'`, [IMEI]))
      .toEqual([{ n: 1 }]);
  });

  it('a logger 2.0 has on a different machine is not moved: the conflict is reported for a person', async () => {
    await sync.apply(FLEET);
    // Somebody re-mapped it in 2.0 since; 1.0 still says 101.
    await owner.query(`UPDATE device_inventory SET equipment_external_id = '102' WHERE imei = $1`, [IMEI]);

    const r = await sync.apply(FLEET);

    expect(r.onboarded).toEqual({ [TENANT]: { machines: 0, registered: 0, claimed: 0, conflicts: 1 } });
    expect((await held(IMEI))!.equipmentExternalId).toBe('102');
  });

  it('a mapping 1.0 has since deleted is not brought back', async () => {
    // Mirrored without onboarding, as before this change; then 1.0 drops the logger.
    await new LegacyFleetSyncService(ds, (sync as any).projection, null).apply(FLEET);
    await sync.apply({ ...FLEET, devices: [logger(202, OTHER_IMEI, null)] });

    expect(await owner.query(`SELECT status FROM device_projection WHERE imei = $1`, [IMEI])).toEqual([{ status: 'missing' }]);
    expect(await held(IMEI)).toBeNull();
  });

  it('without onboarding wired the pass mirrors and reports nothing onboarded, as it did before', async () => {
    const plain = new LegacyFleetSyncService(ds, (sync as any).projection, null);
    const r = await plain.apply(FLEET);

    expect(r.onboarded).toBeUndefined();
    expect(await held(IMEI)).toBeNull();
  });
});
