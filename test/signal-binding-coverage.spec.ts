import { NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { RequestScope } from '../src/auth/types/request-scope';
import { EquipmentClassProfile } from '../src/catalog/entities/equipment-class-profile.entity';
import { EquipmentClassSensorRequirement } from '../src/catalog/entities/equipment-class-sensor-requirement.entity';
import { Sensor } from '../src/device-catalog/entities/sensor.entity';
import { SensorRoleCapability } from '../src/device-catalog/entities/sensor-role-capability.entity';
import { ToolMapping } from '../src/device-catalog/entities/tool-mapping.entity';
import { CLIENT_SOURCE_SYSTEM, EquipmentProfile } from '../src/equipment/equipment-profile.entity';
import { DeviceInventory } from '../src/inventory/entities/device-inventory.entity';
import { SensorMapProjection } from '../src/projection/entities/sensor-map-projection.entity';
import { SignalBindingVersion } from '../src/signal-binding/entities/signal-binding-version.entity';
import { SignalBindingService } from '../src/signal-binding/services/signal-binding.service';
import { createAppDataSource, createTestDataSource, describeDb } from './db';

/**
 * Task Q08S slice 2 — coverage, discovery and resolve-at-event-time.
 *
 * Fixtures are written through the owner connection (a superuser bypasses RLS
 * regardless of FORCE — see test/db.ts), so every table can be seeded with exact
 * control; the service under test always runs through `ds`, the app-role
 * connection, the same way the running service does.
 */
describeDb('signal binding: coverage, discovery, resolve', () => {
  let ds: DataSource;
  let owner: DataSource;
  let bindings: SignalBindingService;

  const TENANT = 'acme';
  const OTHER_TENANT = 'globex';
  const EXTERNAL_ID = 'dg-1';
  const CLASS_SLUG = 'dual-probe-genset';
  const AT = new Date('2026-09-25T12:00:00.000Z');

  const scope: RequestScope = { tenantId: TENANT, userId: 'u-boss', roles: ['super admin'], isPlatformRole: false };
  const otherScope: RequestScope = { tenantId: OTHER_TENANT, userId: 'u-other', roles: ['super admin'], isPlatformRole: false };

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
      'equipment_class_sensor_requirement', 'equipment_profile', 'equipment_class_profile',
      'sensor_role_capability', 'tool_mapping', 'sensor',
    ]) {
      await owner.query(`DELETE FROM "${t}"`);
    }

    await owner.getRepository(EquipmentClassProfile).save(owner.getRepository(EquipmentClassProfile).create({
      slug: CLASS_SLUG, version: 1, name: 'Dual Probe Genset', status: 'published',
      expectedSignals: [
        { signal: 'coolant_temp_c', unit: 'degC', required: true },
        { signal: 'oil_pressure_kpa', unit: 'kPa', required: true },
        { signal: 'vibration_mm_s', unit: 'mm/s', required: true },
        { signal: 'fuel_level_pct', unit: '%', required: true },
      ],
    }));

    const req = (over: Partial<EquipmentClassSensorRequirement>) =>
      owner.getRepository(EquipmentClassSensorRequirement).save(
        owner.getRepository(EquipmentClassSensorRequirement).create({
          classSlug: CLASS_SLUG, classVersion: 1, componentScope: '', criticality: 'required', minCount: 1,
          enables: ['physics_calculation'],
          ...over,
        }),
      );
    // R1: whole-machine, satisfied.
    await req({ measurementRole: 'coolant_temp_c' });
    // R2/R3: same role, two components — one bound, one not.
    await req({ measurementRole: 'oil_pressure_kpa', componentScope: 'left' });
    await req({ measurementRole: 'oil_pressure_kpa', componentScope: 'right' });
    // R4: min_count 2, only one binding will exist.
    await req({ measurementRole: 'vibration_mm_s', minCount: 2, enables: ['statistical_anomaly'] });
    // R5: an active primary binding whose window has closed by `AT`.
    await req({ measurementRole: 'fuel_level_pct', enables: ['data_quality'] });

    await owner.getRepository(EquipmentProfile).save(owner.getRepository(EquipmentProfile).create({
      tenantId: TENANT, sourceSystem: CLIENT_SOURCE_SYSTEM, externalId: EXTERNAL_ID,
      equipmentClassSlug: CLASS_SLUG, classVersion: 1, name: 'DG-1',
    }));

    const bind = (over: Partial<SignalBindingVersion>) =>
      owner.getRepository(SignalBindingVersion).save(owner.getRepository(SignalBindingVersion).create({
        tenantId: TENANT, sourceSystem: CLIENT_SOURCE_SYSTEM, externalId: EXTERNAL_ID,
        componentId: '', origin: 'physical', imei: 'IMEI-COOLANT', canonicalUnit: 'degC',
        validFrom: new Date('2026-01-01T00:00:00.000Z'), validTo: null,
        isPrimary: true, status: 'active',
        ...over,
      }));
    // Satisfies R1.
    await bind({ signalKey: 'coolant_temp_c', measurementRole: 'coolant_temp_c' });
    // Satisfies R2 (left); R3 (right) is left with no binding at all — unbound.
    await bind({ signalKey: 'oil_pressure_kpa', measurementRole: 'oil_pressure_kpa', componentId: 'left', imei: 'IMEI-OIL-L' });
    // One of two needed for R4.
    await bind({ signalKey: 'vibration_mm_s', measurementRole: 'vibration_mm_s', imei: 'IMEI-VIB', canonicalUnit: 'mm/s' });
    // R5: was active, but its window closed well before `AT`.
    await bind({
      signalKey: 'fuel_level_pct', measurementRole: 'fuel_level_pct', imei: 'IMEI-FUEL', canonicalUnit: '%',
      validFrom: new Date('2026-01-01T00:00:00.000Z'), validTo: new Date('2026-06-01T00:00:00.000Z'),
    });
  });

  describe('coverage', () => {
    it('reports a whole-machine requirement as covered', async () => {
      const result = await bindings.coverage(scope, { sourceSystem: CLIENT_SOURCE_SYSTEM, externalId: EXTERNAL_ID }, AT);
      const covered = result.covered.find((c) => c.measurementRole === 'coolant_temp_c');
      expect(covered).toMatchObject({ componentScope: '', minCount: 1, activeCount: 1 });
    });

    it('reports the same role covered on one component and missing (unbound) on the other', async () => {
      const result = await bindings.coverage(scope, { sourceSystem: CLIENT_SOURCE_SYSTEM, externalId: EXTERNAL_ID }, AT);
      const left = result.covered.find((c) => c.measurementRole === 'oil_pressure_kpa' && c.componentScope === 'left');
      const right = result.missing.find((c) => c.measurementRole === 'oil_pressure_kpa' && c.componentScope === 'right');
      expect(left).toMatchObject({ activeCount: 1 });
      expect(right).toMatchObject({ activeCount: 0, reason: 'unbound' });
    });

    it('reports min_count 2 satisfied by only one binding as missing, mapping_required', async () => {
      const result = await bindings.coverage(scope, { sourceSystem: CLIENT_SOURCE_SYSTEM, externalId: EXTERNAL_ID }, AT);
      const vibration = result.missing.find((c) => c.measurementRole === 'vibration_mm_s');
      expect(vibration).toMatchObject({ minCount: 2, activeCount: 1, reason: 'mapping_required' });
      expect(result.covered.find((c) => c.measurementRole === 'vibration_mm_s')).toBeUndefined();
    });

    it('a binding whose window has closed counts as unmet, unbound — not stale, which means bound but silent', async () => {
      const result = await bindings.coverage(scope, { sourceSystem: CLIENT_SOURCE_SYSTEM, externalId: EXTERNAL_ID }, AT);
      const fuel = result.missing.find((c) => c.measurementRole === 'fuel_level_pct');
      expect(fuel).toMatchObject({ activeCount: 0, reason: 'unbound' });
    });

    it('names the intelligence layers a missing requirement blocks, from its enables array', async () => {
      const result = await bindings.coverage(scope, { sourceSystem: CLIENT_SOURCE_SYSTEM, externalId: EXTERNAL_ID }, AT);
      const statisticalAnomaly = result.blockedLayers.find((l) => l.layer === 'statistical_anomaly');
      expect(statisticalAnomaly?.missingInputs).toContain('vibration_mm_s');
      const dataQuality = result.blockedLayers.find((l) => l.layer === 'data_quality');
      expect(dataQuality?.missingInputs).toContain('fuel_level_pct');
      // physics_calculation is blocked by the unbound "right" oil_pressure_kpa component.
      const physics = result.blockedLayers.find((l) => l.layer === 'physics_calculation');
      expect(physics?.missingInputs).toContain('oil_pressure_kpa');
    });

    it('a coverage query for another tenant\'s machine returns nothing, not someone else\'s answer', async () => {
      await expect(
        bindings.coverage(otherScope, { sourceSystem: CLIENT_SOURCE_SYSTEM, externalId: EXTERNAL_ID }, AT),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('resolveBinding', () => {
    const FROM = new Date('2026-03-01T00:00:00.000Z');
    const TO = new Date('2026-04-01T00:00:00.000Z');

    beforeEach(async () => {
      await owner.getRepository(SignalBindingVersion).save(owner.getRepository(SignalBindingVersion).create({
        tenantId: TENANT, sourceSystem: CLIENT_SOURCE_SYSTEM, externalId: EXTERNAL_ID,
        signalKey: 'boundary_test_signal', measurementRole: 'boundary_test_signal', componentId: '',
        origin: 'physical', imei: 'IMEI-BOUNDARY', canonicalUnit: 'unit',
        validFrom: FROM, validTo: TO, isPrimary: true, status: 'active',
      }));
    });

    const resolve = (at: Date) => bindings.resolveBinding(
      TENANT, { sourceSystem: CLIENT_SOURCE_SYSTEM, externalId: EXTERNAL_ID }, 'boundary_test_signal', '', at,
    );

    it('resolves strictly inside the window', async () => {
      expect(await resolve(new Date('2026-03-15T00:00:00.000Z'))).not.toBeNull();
    });

    it('resolves exactly at valid_from — the window is inclusive on the lower bound', async () => {
      expect(await resolve(FROM)).not.toBeNull();
    });

    it('does not resolve exactly at valid_to — the window is exclusive on the upper bound', async () => {
      expect(await resolve(TO)).toBeNull();
    });

    it('does not resolve before valid_from', async () => {
      expect(await resolve(new Date('2026-02-28T23:59:59.999Z'))).toBeNull();
    });

    it('does not resolve at or after valid_to', async () => {
      expect(await resolve(new Date('2026-04-01T00:00:00.001Z'))).toBeNull();
    });
  });

  describe('discovery', () => {
    it('returns matched, expected-not-mapped and mapped-not-expected as three distinct sets', async () => {
      const coolant = await owner.getRepository(Sensor).save(owner.getRepository(Sensor).create({
        sensorName: 'Coolant Probe',
        parameterSpecs: [{ parameter: 'temperature', unit: 'degC', min: -20, max: 150, normalRange: '70-100' }],
      }));
      const oil = await owner.getRepository(Sensor).save(owner.getRepository(Sensor).create({
        sensorName: 'Oil Pressure Probe',
        parameterSpecs: [{ parameter: 'pressure', unit: 'kPa', min: 0, max: 700, normalRange: '250-450' }],
      }));
      await owner.getRepository(SensorRoleCapability).save(owner.getRepository(SensorRoleCapability).create({
        sensorId: coolant.id, measurementRole: 'coolant_temp_c', parameterKey: 'temperature', canonicalUnit: 'degC',
      }));
      await owner.getRepository(SensorRoleCapability).save(owner.getRepository(SensorRoleCapability).create({
        sensorId: oil.id, measurementRole: 'oil_pressure_kpa', parameterKey: 'pressure', canonicalUnit: 'kPa',
      }));
      const mapping = await owner.getRepository(ToolMapping).save(owner.getRepository(ToolMapping).create({
        toolName: 'Genset Kit',
        mappedSensors: [
          { sensorId: coolant.id, parameters: ['temperature'] },
          { sensorId: oil.id, parameters: ['pressure'] },
        ],
      }));
      await owner.getRepository(DeviceInventory).save(owner.getRepository(DeviceInventory).create({
        imei: 'IMEI-DISCOVER', tenantId: TENANT, state: 'assigned',
        toolMappingId: mapping.id, equipmentExternalId: EXTERNAL_ID,
      }));

      const smp = (signal: string) => owner.getRepository(SensorMapProjection).create({
        sourceSystem: 'iot-platform-1', externalId: `smp-${signal}`, tenantId: TENANT,
        imei: 'IMEI-DISCOVER', signal, sensorName: signal, unit: 'unit',
        payload: {}, syncedAt: new Date(), checksum: signal,
      });
      // Agrees with tool_mapping's coolant_temp_c expectation.
      await owner.getRepository(SensorMapProjection).save(smp('coolant_temp_c'));
      // Actually arriving, but tool_mapping never expected it.
      await owner.getRepository(SensorMapProjection).save(smp('vibration_mm_s'));
      // oil_pressure_kpa is expected by tool_mapping but never appears here.

      const result = await bindings.discover(scope, { sourceSystem: CLIENT_SOURCE_SYSTEM, externalId: EXTERNAL_ID });

      expect(result.matched.map((c) => c.signalKey)).toEqual(['coolant_temp_c']);
      expect(result.expectedNotMapped.map((c) => c.signalKey)).toEqual(['oil_pressure_kpa']);
      expect(result.mappedNotExpected.map((c) => c.signalKey)).toEqual(['vibration_mm_s']);
    });
  });

  describe('validation', () => {
    it('refuses a backwards validity window, naming the equipment, the signal and both timestamps', async () => {
      const validFrom = new Date('2026-05-01T00:00:00.000Z');
      const validTo = new Date('2026-04-01T00:00:00.000Z');
      await expect(bindings.activate(scope, { sourceSystem: CLIENT_SOURCE_SYSTEM, externalId: EXTERNAL_ID }, {
        signalKey: 'backwards_signal', measurementRole: 'backwards_signal', origin: 'virtual',
        canonicalUnit: 'unit', validFrom, validTo,
      })).rejects.toThrow(
        new RegExp(
          `${CLIENT_SOURCE_SYSTEM}/${EXTERNAL_ID}.*"backwards_signal".*`
            + `${validTo.toISOString()}.*${validFrom.toISOString()}`,
        ),
      );
    });
  });

  describe('propose and activate', () => {
    it('propose never lands as active', async () => {
      const proposed = await bindings.propose(scope, { sourceSystem: CLIENT_SOURCE_SYSTEM, externalId: EXTERNAL_ID }, {
        signalKey: 'new_signal', measurementRole: 'new_signal', origin: 'virtual',
        canonicalUnit: 'unit', validFrom: new Date('2026-01-01T00:00:00.000Z'),
      });
      expect(proposed.status).not.toBe('active');
      expect(proposed.isPrimary).toBe(false);
    });

    it('activating records who and when, and the binding becomes resolvable', async () => {
      const activated = await bindings.activate(scope, { sourceSystem: CLIENT_SOURCE_SYSTEM, externalId: EXTERNAL_ID }, {
        signalKey: 'activated_signal', measurementRole: 'activated_signal', origin: 'virtual',
        canonicalUnit: 'unit', validFrom: new Date('2026-01-01T00:00:00.000Z'),
      });
      expect(activated.status).toBe('active');
      expect(activated.isPrimary).toBe(true);
      expect(activated.approvedBy).toBe('u-boss');
      expect(activated.approvedAt).not.toBeNull();

      const resolved = await bindings.resolveBinding(
        TENANT, { sourceSystem: CLIENT_SOURCE_SYSTEM, externalId: EXTERNAL_ID }, 'activated_signal', '', AT,
      );
      expect(resolved?.id).toBe(activated.id);
    });
  });
});
