import { DataSource } from 'typeorm';
import { RequestScope } from '../src/auth/types/request-scope';
import { EquipmentClassProfile } from '../src/catalog/entities/equipment-class-profile.entity';
import { CLIENT_SOURCE_SYSTEM, EquipmentProfile } from '../src/equipment/equipment-profile.entity';
import { DeviceInventory } from '../src/inventory/entities/device-inventory.entity';
import { SensorMapProjection } from '../src/projection/entities/sensor-map-projection.entity';
import { SignalBindingService } from '../src/signal-binding/services/signal-binding.service';
import { createAppDataSource, createTestDataSource, describeDb } from './db';

/**
 * Discovery says which candidates are already bound (tester bug TC_129). Propose and
 * Activate both worked, but the candidate list looked the same afterwards — the same
 * two buttons on the same row — so the tester reported the buttons as broken.
 */
describeDb('signal binding discovery: binding state per candidate', () => {
  let ds: DataSource;
  let owner: DataSource;
  let bindings: SignalBindingService;

  const TENANT = 'acme';
  const IMEI = 'IMEI-STATUS';
  const machine = { sourceSystem: CLIENT_SOURCE_SYSTEM, externalId: 'dg-status' };
  const scope: RequestScope = { tenantId: TENANT, userId: 'u-boss', roles: ['super admin'], isPlatformRole: false };

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    ds = await createAppDataSource();
    bindings = new SignalBindingService(ds);
  }, 30_000);

  afterAll(async () => { await ds?.destroy(); await owner?.destroy(); });

  beforeEach(async () => {
    for (const t of [
      'signal_binding_version', 'device_inventory', 'sensor_map_projection',
      'equipment_profile', 'equipment_class_profile',
    ]) {
      await owner.query(`DELETE FROM "${t}"`);
    }
    await owner.getRepository(EquipmentClassProfile).save(owner.getRepository(EquipmentClassProfile).create({
      slug: 'status-genset', version: 1, name: 'Status Genset', status: 'published', expectedSignals: [],
    }));
    await owner.getRepository(EquipmentProfile).save(owner.getRepository(EquipmentProfile).create({
      tenantId: TENANT, ...machine, equipmentClassSlug: 'status-genset', classVersion: 1, name: 'DG',
    }));
    await owner.getRepository(DeviceInventory).save(owner.getRepository(DeviceInventory).create({
      imei: IMEI, tenantId: TENANT, state: 'assigned', equipmentExternalId: machine.externalId,
    }));
    // Three signals arriving from the logger, none expected by a tool mapping.
    for (const signal of ['coolant_temp_c', 'oil_pressure_kpa', 'fuel_level_pct']) {
      await owner.getRepository(SensorMapProjection).save(owner.getRepository(SensorMapProjection).create({
        sourceSystem: 'iot-platform-1', externalId: `smp-${signal}`, tenantId: TENANT,
        imei: IMEI, signal, sensorName: signal, unit: 'unit', payload: {}, syncedAt: new Date(), checksum: signal,
      }));
    }
  });

  const bind = (action: 'propose' | 'activate', signal: string) =>
    bindings[action](scope, machine, {
      signalKey: signal, measurementRole: signal, origin: 'physical', imei: IMEI,
      canonicalUnit: 'unit', validFrom: new Date('2026-10-01T00:00:00.000Z'),
    });

  const statuses = async () => Object.fromEntries(
    (await bindings.discover(scope, machine)).mappedNotExpected.map((c) => [c.signalKey, c.bindingStatus]),
  );

  it('a proposed binding reads as proposed, an activated one as active, the rest as unbound', async () => {
    await bind('propose', 'coolant_temp_c');
    await bind('activate', 'oil_pressure_kpa');

    expect(await statuses()).toEqual({
      coolant_temp_c: 'proposed',
      oil_pressure_kpa: 'active',
      fuel_level_pct: null,
    });
  });

  it('activating a proposed signal moves it to active', async () => {
    await bind('propose', 'coolant_temp_c');
    await bind('activate', 'coolant_temp_c');

    expect((await statuses()).coolant_temp_c).toBe('active');
  });

  it('a binding on another logger does not mark this logger\'s candidate', async () => {
    await bindings.activate(scope, machine, {
      signalKey: 'fuel_level_pct', measurementRole: 'fuel_level_pct', origin: 'physical', imei: 'IMEI-OTHER',
      canonicalUnit: 'unit', validFrom: new Date('2026-10-01T00:00:00.000Z'),
    });

    expect((await statuses()).fuel_level_pct).toBeNull();
  });
});
