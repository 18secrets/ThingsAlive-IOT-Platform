import 'reflect-metadata';

import { DataSource, EntityManager } from 'typeorm';
import { ClientCatalogEntitlement } from '../../catalog/entities/client-catalog-entitlement.entity';
import { EquipmentProfile, ServiceTier } from '../../equipment/equipment-profile.entity';
import { DeviceProjection } from '../../projection/entities/device-projection.entity';
import { EquipmentProjection } from '../../projection/entities/equipment-projection.entity';
import { SensorMapProjection } from '../../projection/entities/sensor-map-projection.entity';
import { TenantMap } from '../../projection/entities/tenant-map.entity';
import { TelemetryReading } from '../../telemetry/telemetry-reading.entity';
import { runTenantSpanning } from '../../scope/tenant-session';
import dataSource from '../data-source';

/**
 * A fleet shaped to exercise every answer the recommendation engine can give.
 *
 * Not a realistic customer — a deliberate spread. One asset per interesting state,
 * so that a single call to the recommendations endpoint returns availableNow,
 * availableLater with each blocker code, and notApplicable, and anybody reviewing
 * the work can see all of it without constructing a scenario by hand.
 *
 *   npx ts-node src/database/seeds/seed-demo-fleet.ts
 *
 * Assumes the catalog is already seeded and published.
 */

const SOURCE = 'iot-platform-1';
const TENANT = 'demo-tenant';

/**
 * The signals the OBD-CAN genset frame actually carries, under their wire names.
 * Seeded as aliases resolve them, so the recommendation engine is exercised through
 * the alias table rather than around it.
 */
const GENSET_WIRE_SIGNALS = [
  'engine_rpm', 'engine_on_time', 'coolant_temp_c', 'oil_temp_c',
  'fuel_temp_c', 'oil_pressure_scaled', 'battery_voltage_v', 'fuel_level_pct',
];

interface AssetSpec {
  externalId: string;
  name: string;
  classSlug: string | null;
  tier: ServiceTier;
  signals: string[] | null;
  firstReadingDaysAgo: number | null;
  note: string;
}

export const DEMO_FLEET: AssetSpec[] = [
  {
    externalId: 'DG-KOEL-125-001', name: 'KOEL 125 kVA — Plant A main',
    classSlug: 'diesel-generator', tier: 'advanced',
    signals: GENSET_WIRE_SIGNALS, firstReadingDaysAgo: 400,
    note: 'The healthy case. Full OBD-CAN frame, thirteen months of history, advanced tier — every tier 1 and 2 genset scenario should be available now.',
  },
  {
    externalId: 'DG-KOEL-125-002', name: 'KOEL 125 kVA — Plant A standby',
    classSlug: 'diesel-generator', tier: 'basic',
    signals: GENSET_WIRE_SIGNALS, firstReadingDaysAgo: 400,
    note: 'Same hardware, basic tier. Everything needing tier 2 or 3 reports tier-too-low, which is a commercial blocker rather than an engineering one and should read differently on screen.',
  },
  {
    externalId: 'DG-CUMMINS-62-003', name: 'Cummins 62.5 kVA — Plant B',
    classSlug: 'diesel-generator', tier: 'standard',
    signals: GENSET_WIRE_SIGNALS, firstReadingDaysAgo: 9,
    note: 'Commissioned nine days ago. Scenarios needing 14, 21 or 30 days of baseline report insufficient-history with a date, because time alone will clear it.',
  },
  {
    externalId: 'DG-MAHINDRA-40-004', name: 'Mahindra 40 kVA — Site C',
    classSlug: 'diesel-generator', tier: 'standard',
    signals: ['engine_rpm', 'engine_on_time', 'fuel_level_pct'],
    firstReadingDaysAgo: 200,
    note: 'An older logger sending speed, hours and fuel but no engine parameters. Temperature and pressure scenarios report missing-signals by name, so somebody can quote for the upgrade.',
  },
  {
    externalId: 'DG-KOEL-30-005', name: 'KOEL 30 kVA — Site D',
    classSlug: 'diesel-generator', tier: 'full',
    signals: GENSET_WIRE_SIGNALS, firstReadingDaysAgo: null,
    note: 'Device fitted and mapped, nothing received yet. History scenarios report blocked with no date — there is no first reading to count from, and a date invented here would be a promise nothing is working towards.',
  },
  {
    externalId: 'DG-UNKNOWN-006', name: 'Unclassified set — Site E',
    classSlug: null, tier: 'standard',
    signals: GENSET_WIRE_SIGNALS, firstReadingDaysAgo: 100,
    note: 'Reporting well, nobody has said what it is. The ordinary day-one state: every scenario blocked by unclassified, with the fix being one field on a form.',
  },
  {
    externalId: 'DG-NODEVICE-007', name: 'Set awaiting a logger — Site F',
    classSlug: 'diesel-generator', tier: 'standard',
    signals: null, firstReadingDaysAgo: null,
    note: 'Classified, entitled, and no device fitted. Reports no-device rather than a list of missing signals, because the signals are not the problem.',
  },
  {
    externalId: 'DG-RETIRED-CLASS-009', name: 'Air compressor — Plant A utilities',
    classSlug: 'air-compressor', tier: 'standard',
    signals: GENSET_WIRE_SIGNALS, firstReadingDaysAgo: 300,
    note: 'Classified as a class this catalog does not publish. Nothing about the asset will change that, so its scenarios are notApplicable rather than blocked — the distinction between "wait" and "there is nothing to wait for".',
  },
  {
    externalId: 'CNC-JYOTI-VMC-008', name: 'Jyoti VMC — Toolroom',
    classSlug: 'cnc-machining-centre', tier: 'full',
    signals: null, firstReadingDaysAgo: null,
    note: 'The honest case. A machining centre on the highest tier, and not one of the signals its class needs is collectable by the current fleet — no control interface, no accelerometer. Every scenario blocked, each naming what it wants.',
  },
];

export async function seedDemoFleet(ds: DataSource, now = new Date()): Promise<number> {
  return runTenantSpanning(ds, 'demo fleet fixture', async (m: EntityManager) => {
    // Re-runnable: a seeder that only works on an empty database is a seeder people
    // stop using the second time they need it.
    const tenants = m.getRepository(TenantMap);
    const mapped = await tenants.findOne({
      where: { sourceSystem: SOURCE, externalClientId: 'demo-client' },
    });
    await tenants.save(tenants.create({
      ...(mapped ?? {}),
      sourceSystem: SOURCE, externalClientId: 'demo-client', tenantId: TENANT,
      displayName: 'Demo tenant',
    }));

    for (const slug of ['diesel-generator', 'cnc-machining-centre']) {
      const repo = m.getRepository(ClientCatalogEntitlement);
      const existing = await repo.findOne({ where: { tenantId: TENANT, equipmentClassSlug: slug } });
      if (!existing) {
        await repo.save(repo.create({
          tenantId: TENANT, equipmentClassSlug: slug, grantedBy: 'seed-demo-fleet',
          note: 'Granted by the demo seeder so the whole catalog is visible.',
        }));
      }
    }

    for (const asset of DEMO_FLEET) {
      await upsertAsset(m, asset, now);
    }
    return DEMO_FLEET.length;
  });
}

async function upsertAsset(m: EntityManager, asset: AssetSpec, now: Date): Promise<void> {
  const base = {
    sourceSystem: SOURCE, tenantId: TENANT, payload: { note: asset.note },
    sourceUpdatedAt: now, syncedAt: now, status: 'live' as const,
  };

  const equipment = m.getRepository(EquipmentProjection);
  const existingEquipment = await equipment.findOne({
    where: { sourceSystem: SOURCE, externalId: asset.externalId },
  });
  await equipment.save(equipment.create({
    ...(existingEquipment ?? {}),
    ...base, externalId: asset.externalId, checksum: `demo-${asset.externalId}`,
    name: asset.name, classId: asset.classSlug, plantExternalId: null, category: null,
  }));

  const profiles = m.getRepository(EquipmentProfile);
  const existingProfile = await profiles.findOne({
    where: { sourceSystem: SOURCE, externalId: asset.externalId },
  });
  await profiles.save(profiles.create({
    ...(existingProfile ?? {}),
    tenantId: TENANT, sourceSystem: SOURCE, externalId: asset.externalId,
    equipmentClassSlug: asset.classSlug, classVersion: asset.classSlug ? 1 : null,
    tier: asset.tier, commissionedAt: null, serviceIntervalHours: 250,
    readiness: {}, updatedBy: 'seed-demo-fleet',
  }));

  if (!asset.signals) return; // no device fitted

  const imei = `86221107424${asset.externalId.slice(-4)}`;
  const devices = m.getRepository(DeviceProjection);
  const existingDevice = await devices.findOne({
    where: { sourceSystem: SOURCE, externalId: `dev-${asset.externalId}` },
  });
  await devices.save(devices.create({
    ...(existingDevice ?? {}),
    ...base, externalId: `dev-${asset.externalId}`, checksum: `demo-dev-${asset.externalId}`,
    imei, equipmentExternalId: asset.externalId, name: `Logger on ${asset.name}`,
  }));

  const sensors = m.getRepository(SensorMapProjection);
  for (const signal of asset.signals) {
    const existingSensor = await sensors.findOne({
      where: { sourceSystem: SOURCE, externalId: `${imei}-${signal}` },
    });
    await sensors.save(sensors.create({
      ...(existingSensor ?? {}),
      ...base, externalId: `${imei}-${signal}`, checksum: `demo-${imei}-${signal}`,
      imei, signal, sensorName: signal, unit: null,
    }));
  }

  if (asset.firstReadingDaysAgo === null) return; // mapped, nothing received

  // One reading at the far end of the window. Enough to establish when data began,
  // which is all the recommendation engine reads — it counts history, not samples.
  const at = new Date(now.getTime() - asset.firstReadingDaysAgo * 86_400_000);
  const readings = m.getRepository(TelemetryReading);
  const existing = await readings.findOne({
    where: { imei, signal: 'fuel_level_pct', sourceTimestamp: at },
  });
  if (!existing) {
    await readings.save(readings.create({
      tenantId: TENANT, imei, signal: 'fuel_level_pct', value: 72, unit: '%',
      sourceTimestamp: at, receivedAt: at, source: 'simulated',
    }));
  }
}

async function main() {
  const ds = await dataSource.initialize();
  try {
    const count = await seedDemoFleet(ds);
    // eslint-disable-next-line no-console
    console.log(`${count} demo assets seeded for tenant "${TENANT}".`);
  } finally {
    await ds.destroy();
  }
}

if (require.main === module) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
