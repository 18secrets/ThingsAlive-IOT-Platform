import { DataSource } from 'typeorm';
import { RequestScope } from '../src/auth/types/request-scope';
import { CLASS_CONTENT_INVENTORY } from '../src/client-catalog/services/class-content-inventory';
import { EquipmentClassProfile } from '../src/catalog/entities/equipment-class-profile.entity';
import { EquipmentClassSensorRequirement } from '../src/catalog/entities/equipment-class-sensor-requirement.entity';
import { CLIENT_SOURCE_SYSTEM, EquipmentProfile } from '../src/equipment/equipment-profile.entity';
import { DeviceInventory } from '../src/inventory/entities/device-inventory.entity';
import {
  classifyFreshness, DEFAULT_STALE_AFTER_SECONDS, resolveStaleAfterSeconds,
} from '../src/signal-binding/services/signal-freshness';
import { SignalBindingVersion } from '../src/signal-binding/entities/signal-binding-version.entity';
import { SignalBindingService } from '../src/signal-binding/services/signal-binding.service';
import { TelemetryReading } from '../src/telemetry/telemetry-reading.entity';
import { createAppDataSource, createTestDataSource, describeDb } from './db';

const HOUR = 3_600_000;

/**
 * Telemetry freshness per signal (task Q08S s3) — the difference between "this
 * machine has stopped reporting" (`stale`) and "this signal was never wired"
 * (`no_readings`), which needs a per-signal notion of how old is too old to
 * tell apart reliably.
 */
describe('signal freshness: resolution (pure)', () => {
  it('1. no stale_after_seconds on the requirement resolves to the platform default', () => {
    expect(resolveStaleAfterSeconds({ staleAfterSeconds: null })).toBe(DEFAULT_STALE_AFTER_SECONDS);
    expect(DEFAULT_STALE_AFTER_SECONDS).toBe(900);
  });

  it('2. an explicit value wins over the default', () => {
    expect(resolveStaleAfterSeconds({ staleAfterSeconds: 60 })).toBe(60);
  });

  it('6. exactly at the threshold boundary resolves to ready, not stale — the same half-open '
    + 'convention signal_binding_version\'s own validity window already uses', () => {
    const at = new Date('2026-09-22T12:00:00.000Z');
    const exactlyAtThreshold = new Date(at.getTime() - 900 * 1000);
    expect(classifyFreshness(exactlyAtThreshold, at, 900)).toBe('ready');
    expect(classifyFreshness(new Date(exactlyAtThreshold.getTime() - 1000), at, 900)).toBe('stale');
  });

  it('a signal with no reading at all is no_readings, regardless of threshold', () => {
    expect(classifyFreshness(null, new Date(), 900)).toBe('no_readings');
  });

  it('9. copy-on-grant does not carry equipment_class_sensor_requirement, and should not: '
    + 'the inventory names the reason (version-pinning already gives the guarantee a copy would)', () => {
    const entry = CLASS_CONTENT_INVENTORY.find((e) => e.table === 'equipment_class_sensor_requirement');
    expect(entry?.disposition).toBe('exclude');
    expect(entry?.reason).toMatch(/tenant owns their bindings/);
  });
});

describeDb('signal freshness: coverage() and version-pinning', () => {
  let ds: DataSource;
  let owner: DataSource;
  let bindings: SignalBindingService;

  const TENANT = 'acme';
  const EXTERNAL_ID = 'dg-1';
  const CLASS_SLUG = 'freshness-genset';
  const IMEI_COOLANT = 'IMEI-FRESH-COOLANT';
  const IMEI_OIL = 'IMEI-FRESH-OIL';
  const AT = new Date('2026-09-25T12:00:00.000Z');
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
    for (const t of ['telemetry_reading', 'signal_binding_version', 'device_inventory',
      'equipment_class_sensor_requirement', 'equipment_profile', 'equipment_class_profile']) {
      await owner.query(`DELETE FROM "${t}"`);
    }
    await owner.getRepository(EquipmentClassProfile).save(owner.getRepository(EquipmentClassProfile).create({
      slug: CLASS_SLUG, version: 1, name: 'Freshness Genset', status: 'published',
      expectedSignals: [
        { signal: 'coolant_temp_c', unit: 'degC', required: true },
        { signal: 'oil_pressure_kpa', unit: 'kPa', required: true },
      ],
    }));
    await owner.getRepository(EquipmentClassSensorRequirement).save([
      owner.getRepository(EquipmentClassSensorRequirement).create({
        classSlug: CLASS_SLUG, classVersion: 1, measurementRole: 'coolant_temp_c',
        componentScope: '', criticality: 'required', minCount: 1, enables: [],
        staleAfterSeconds: 300, // explicit override: stale after 5 minutes
      }),
      owner.getRepository(EquipmentClassSensorRequirement).create({
        classSlug: CLASS_SLUG, classVersion: 1, measurementRole: 'oil_pressure_kpa',
        componentScope: '', criticality: 'required', minCount: 1, enables: [],
        staleAfterSeconds: null, // platform default: 900s
      }),
    ]);
    await owner.getRepository(EquipmentProfile).save(owner.getRepository(EquipmentProfile).create({
      tenantId: TENANT, sourceSystem: CLIENT_SOURCE_SYSTEM, externalId: EXTERNAL_ID,
      equipmentClassSlug: CLASS_SLUG, classVersion: 1, name: 'DG-1',
    }));
    await owner.getRepository(DeviceInventory).save([
      owner.getRepository(DeviceInventory).create({ imei: IMEI_COOLANT, tenantId: TENANT, equipmentExternalId: EXTERNAL_ID }),
      owner.getRepository(DeviceInventory).create({ imei: IMEI_OIL, tenantId: TENANT, equipmentExternalId: EXTERNAL_ID }),
    ]);
    await owner.getRepository(SignalBindingVersion).save([
      owner.getRepository(SignalBindingVersion).create({
        tenantId: TENANT, sourceSystem: CLIENT_SOURCE_SYSTEM, externalId: EXTERNAL_ID,
        signalKey: 'coolant_temp_c', measurementRole: 'coolant_temp_c', componentId: '',
        origin: 'physical', imei: IMEI_COOLANT, canonicalUnit: 'degC',
        validFrom: new Date('2026-01-01'), validTo: null, isPrimary: true, status: 'active',
      }),
      owner.getRepository(SignalBindingVersion).create({
        tenantId: TENANT, sourceSystem: CLIENT_SOURCE_SYSTEM, externalId: EXTERNAL_ID,
        signalKey: 'oil_pressure_kpa', measurementRole: 'oil_pressure_kpa', componentId: '',
        origin: 'physical', imei: IMEI_OIL, canonicalUnit: 'kPa',
        validFrom: new Date('2026-01-01'), validTo: null, isPrimary: true, status: 'active',
      }),
    ]);
  });

  it('7. two signals on one machine with different thresholds resolve independently — one stale, '
    + 'one ready, in the same response', async () => {
    await owner.getRepository(TelemetryReading).save([
      // coolant: last reading 10 minutes ago, threshold 300s (5 min) → stale.
      {
        tenantId: TENANT, imei: IMEI_COOLANT, signal: 'coolant_temp_c', value: 80, unit: 'degC',
        sourceTimestamp: new Date(AT.getTime() - 10 * 60 * 1000), receivedAt: AT, source: 'live' as const,
      },
      // oil: last reading 10 minutes ago, threshold defaults to 900s (15 min) → ready.
      {
        tenantId: TENANT, imei: IMEI_OIL, signal: 'oil_pressure_kpa', value: 500, unit: 'kPa',
        sourceTimestamp: new Date(AT.getTime() - 10 * 60 * 1000), receivedAt: AT, source: 'live' as const,
      },
    ]);

    const result = await bindings.coverage(scope, { sourceSystem: CLIENT_SOURCE_SYSTEM, externalId: EXTERNAL_ID }, AT);
    const coolant = result.covered.find((c) => c.measurementRole === 'coolant_temp_c');
    const oil = result.covered.find((c) => c.measurementRole === 'oil_pressure_kpa');

    expect(coolant).toMatchObject({ staleAfterSeconds: 300, secondsSinceLastReading: 600 });
    expect(oil).toMatchObject({ staleAfterSeconds: 900, secondsSinceLastReading: 600 });
    // Annotated, not reclassified (signal-binding.service.ts's own design line):
    // both stay `covered` — a currently-bound-but-quiet signal is a KPI-readiness
    // question (QCE2), not a binding-coverage one.
  });

  it('8. a later platform change does not reach an already-granted tenant — proven by version-pinning, '
    + 'not a tenant copy, since equipment_class_sensor_requirement is never copied (see test above)', async () => {
    // A new class version publishes a different threshold for the same role.
    await owner.getRepository(EquipmentClassProfile).save(owner.getRepository(EquipmentClassProfile).create({
      slug: CLASS_SLUG, version: 2, name: 'Freshness Genset', status: 'published',
      expectedSignals: [{ signal: 'coolant_temp_c', unit: 'degC', required: true }],
    }));
    await owner.getRepository(EquipmentClassSensorRequirement).save(
      owner.getRepository(EquipmentClassSensorRequirement).create({
        classSlug: CLASS_SLUG, classVersion: 2, measurementRole: 'coolant_temp_c',
        componentScope: '', criticality: 'required', minCount: 1, enables: [],
        staleAfterSeconds: 60,
      }),
    );
    // DG-1 is still pinned to class_version 1 (equipment_profile.class_version),
    // exactly as it was before version 2 existed.
    const result = await bindings.coverage(scope, { sourceSystem: CLIENT_SOURCE_SYSTEM, externalId: EXTERNAL_ID }, AT);
    const coolant = result.covered.find((c) => c.measurementRole === 'coolant_temp_c');
    expect(coolant?.staleAfterSeconds).toBe(300); // still v1's value, not v2's 60
  });
});
