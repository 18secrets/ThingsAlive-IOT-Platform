import { BadRequestException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { RequestScope } from '../src/auth/types/request-scope';
import { compileFormula } from '../src/catalog/formula/formula-compiler';
import { lookupExecutor } from '../src/catalog/formula/executor-registry';
import { insideBoundary, pairPositions, SiteBoundary } from '../src/catalog/formula/geofence';
import { ClientEquipmentClass } from '../src/client-catalog/entities/client-equipment-class.entity';
import { ClientFormula } from '../src/client-catalog/entities/client-formula.entity';
import { EquipmentProfile } from '../src/equipment/equipment-profile.entity';
import { PlantService } from '../src/equipment/services/plant.service';
import { KpiEvaluatorService } from '../src/kpi/services/kpi-evaluator.service';
import { DeviceProjection } from '../src/projection/entities/device-projection.entity';
import { SignalBindingVersion } from '../src/signal-binding/entities/signal-binding-version.entity';
import { SignalBindingService } from '../src/signal-binding/services/signal-binding.service';
import { TelemetryReading } from '../src/telemetry/telemetry-reading.entity';
import { createAppDataSource, createTestDataSource, describeDb, undoMigrationNamed } from './db';

const HOUR = 3_600_000;
const MIGRATION = 'SiteBoundary1758600000000';
// A 1° square, lng 77–78, lat 12–13, with a hole lng 77.4–77.6, lat 12.4–12.6.
const SITE: SiteBoundary = {
  type: 'Polygon',
  coordinates: [
    [[77, 12], [78, 12], [78, 13], [77, 13], [77, 12]],
    [[77.4, 12.4], [77.6, 12.4], [77.6, 12.6], [77.4, 12.6], [77.4, 12.4]],
  ],
};
const SIGNALS = [
  { signal: 'latitude', unit: 'deg' }, { signal: 'longitude', unit: 'deg' }, { signal: 'coolant_temp_c', unit: 'degC' },
];
const compile = (expression: string) => compileFormula({ formulaKey: 'f', expression, classSlug: 'genset', expectedSignals: SIGNALS });

/** Site boundaries and inside/outside (task QGEO1). */
describe('QGEO1: geometry', () => {
  it('inside the outer ring and in no hole is inside; in a hole or beyond the ring is not', () => {
    expect(insideBoundary(SITE, 77.2, 12.2)).toBe(true);
    expect(insideBoundary(SITE, 77.5, 12.5)).toBe(false); // the hole
    expect(insideBoundary(SITE, 78.5, 12.5)).toBe(false);
  });

  it('a point on the boundary is inside — on the outer edge and on a hole\'s edge alike', () => {
    expect(insideBoundary(SITE, 78, 12.5)).toBe(true);
    expect(insideBoundary(SITE, 77, 12)).toBe(true);
    expect(insideBoundary(SITE, 77.4, 12.5)).toBe(true);
  });

  it('pairs each latitude with the latest longitude at or before it, within five minutes, and drops the rest', () => {
    const t = (min: number) => new Date(Date.UTC(2026, 8, 22, 0, min));
    const positions = pairPositions(
      [{ at: t(0), value: 12.1 }, { at: t(10), value: 12.2 }, { at: t(30), value: 12.3 }],
      [{ at: t(0), value: 77.1 }, { at: t(8), value: 77.2 }],
    );
    expect(positions.map((p) => [p.lat, p.lng])).toEqual([[12.1, 77.1], [12.2, 77.2]]); // t30's longitude is 22 min stale
  });
});

describe('QGEO1: compiling', () => {
  it('compiles both operators to dimensionless scalars', () => {
    expect(compile('outside_site(latitude, longitude)')).toMatchObject({ resultKind: 'scalar', resultUnit: 'dimensionless' });
    expect(compile('fraction_outside_site(latitude, longitude)')).toMatchObject({ resultKind: 'scalar', resultUnit: 'dimensionless' });
  });

  it('refuses a pair that is not one position — two different units', () => {
    expect(() => compile('outside_site(latitude, coolant_temp_c)')).toThrow(/latitude and longitude share a unit/);
  });

  it('refuses a computed series as either half', () => {
    expect(() => compile('outside_site(latitude * 2, longitude)')).toThrow(/must be a signal by name/);
  });
});

describe('QGEO1: executors', () => {
  const from = new Date('2026-09-22T00:00:00Z');
  const ctx = { windowFrom: from, windowTo: new Date(from.getTime() + 10 * HOUR), history: [], excludedRanges: [], siteBoundary: SITE };
  const at = (h: number, value: number) => ({ at: new Date(from.getTime() + h * HOUR), value });
  // Inside for 0–4h, outside 4–6h, inside 6–10h.
  const lat = [at(0, 12.2), at(4, 14), at(6, 12.2)];
  const lng = [at(0, 77.2), at(4, 77.2), at(6, 77.2)];

  it('outside_site reads the latest position', () => {
    expect(lookupExecutor('outside_site')!.run([lat, lng], [], [], ctx)).toEqual({ ok: true, value: 0 });
    expect(lookupExecutor('outside_site')!.run([lat.slice(0, 2), lng.slice(0, 2)], [], [], ctx)).toEqual({ ok: true, value: 1 });
  });

  it('fraction_outside_site weighs time, each position holding until the next', () => {
    expect(lookupExecutor('fraction_outside_site')!.run([lat, lng], [], [], ctx)).toEqual({ ok: true, value: 0.2 });
  });

  it('no positions is no_readings, never "inside"', () => {
    expect(lookupExecutor('outside_site')!.run([[], []], [], [], ctx)).toEqual({ ok: false, reason: 'no_readings' });
  });
});

describeDb('QGEO1: boundaries and evaluation', () => {
  let owner: DataSource;
  let ds: DataSource;
  let plants: PlantService;
  let evaluator: KpiEvaluatorService;
  let plantId: string;

  const boss: RequestScope = { tenantId: 'acme', userId: 'u-boss', roles: ['super admin'], isPlatformRole: false };
  const EQUIPMENT = { sourceSystem: 'iot-platform-1', externalId: 'DG-G' };
  const IMEI = 'imei-dg-g';
  const NOW = new Date('2026-09-22T12:00:00.000Z');

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    ds = await createAppDataSource();
    plants = new PlantService(ds);
    evaluator = new KpiEvaluatorService(ds, new SignalBindingService(ds));
    [{ id: plantId }] = await owner.query(`INSERT INTO plant (tenant_id, code, name) VALUES ('acme', 'P-G', 'Yard') RETURNING id`);
  }, 30_000);

  afterAll(async () => { await ds?.destroy(); await owner?.destroy(); });

  describe('the database refuses a boundary it would misread', () => {
    const setRaw = (b: unknown) => owner.query(`UPDATE plant SET boundary = $1::jsonb WHERE id = $2`, [JSON.stringify(b), plantId]);

    it.each([
      ['not a Polygon', { type: 'Point', coordinates: [77, 12] }],
      ['an open ring', { type: 'Polygon', coordinates: [[[77, 12], [78, 12], [78, 13], [77, 13]]] }],
      ['latitude in the longitude slot (a site at longitude 100, swapped)', { type: 'Polygon', coordinates: [[[12, 100], [12, 101], [13, 101], [12, 100]]] }],
      ['too few positions', { type: 'Polygon', coordinates: [[[77, 12], [78, 12], [77, 12]]] }],
      ['a position that is not two numbers', { type: 'Polygon', coordinates: [[[77, 12, 5], [78, 12], [78, 13], [77, 12]]] }],
    ])('refuses %s', async (_name, b) => {
      await expect(setRaw(b)).rejects.toThrow(/ck_plant_boundary/);
    });

    it('the service says what is wrong, in words', async () => {
      const attempt = plants.setBoundary(boss, plantId, { type: 'Polygon', coordinates: [[[77, 12], [78, 12], [78, 13], [77, 13]]] });
      await expect(attempt).rejects.toBeInstanceOf(BadRequestException);
      await expect(attempt).rejects.toThrow(/closed: its last position repeats its first/);
    });

    it('sets a valid boundary, and null removes it', async () => {
      expect((await plants.setBoundary(boss, plantId, SITE)).boundary).toEqual(SITE);
      expect((await plants.setBoundary(boss, plantId, null)).boundary).toBeNull();
    });
  });

  describe('evaluation', () => {
    const seed = async (withPlant: boolean) => {
      for (const t of ['telemetry_reading', 'signal_binding_version', 'device_projection', 'equipment_profile', 'client_formula', 'client_equipment_class']) {
        await owner.query(`DELETE FROM "${t}"`);
      }
      await owner.getRepository(ClientEquipmentClass).save({
        tenantId: 'acme', slug: 'geo-genset', name: 'Genset', description: null, category: 'power',
        expectedSignals: [], failureModes: [], defaultThresholds: {}, templateSlug: 'geo-genset', templateVersion: 1,
        templateChecksum: 'c', copiedAt: NOW, status: 'active', updatedBy: 'u-master',
      });
      await owner.getRepository(EquipmentProfile).save({
        tenantId: 'acme', sourceSystem: EQUIPMENT.sourceSystem, externalId: EQUIPMENT.externalId,
        equipmentClassSlug: 'geo-genset', classVersion: 1, plantId: withPlant ? plantId : null, tier: 'standard',
        commissionedAt: null, serviceIntervalHours: null, readiness: {}, updatedBy: 'u-boss',
      });
      await owner.getRepository(DeviceProjection).save({
        sourceSystem: EQUIPMENT.sourceSystem, externalId: 'dev-g', tenantId: 'acme', payload: {}, sourceUpdatedAt: null,
        syncedAt: NOW, checksum: 'c', status: 'live', imei: IMEI, equipmentExternalId: EQUIPMENT.externalId, name: null,
      });
      for (const signal of ['latitude', 'longitude']) {
        await owner.getRepository(SignalBindingVersion).save({
          tenantId: 'acme', sourceSystem: EQUIPMENT.sourceSystem, externalId: EQUIPMENT.externalId,
          signalKey: signal, measurementRole: signal, componentId: '', origin: 'physical', imei: IMEI, channel: signal,
          sensorInstanceId: null, canonicalUnit: 'deg', sourceUnit: null, validFrom: new Date('2026-01-01'), validTo: null,
          expectedPeriodSeconds: 3600, isPrimary: true, status: 'active',
          discoveredFrom: null, discoveredBy: 'manual', approvedBy: 'u-master', approvedAt: NOW,
        });
      }
      for (const key of ['outside_site', 'fraction_outside_site']) {
        const c = compile(`${key}(latitude, longitude)`);
        await owner.getRepository(ClientFormula).save({
          tenantId: 'acme', clientEquipmentClassSlug: 'geo-genset', formulaKey: key, kind: 'empirical',
          expression: `${key}(latitude, longitude)`, compiledPlan: c.plan as any, compiledAt: NOW,
          compilerVersion: c.compilerVersion, resultUnit: c.resultUnit, requiredSignals: c.requiredSignals,
          requiredParameters: [], bindings: [], resultKind: c.resultKind, displayUnit: null, displayFormat: 'number:2',
          targetValue: null, targetMin: null, targetMax: null, targetDirection: 'none', comparisonBasis: 'none',
          aggregationWindow: '24h', chartType: 'none', templateVersion: 1, copiedAt: NOW, status: 'active', updatedBy: 'u-master',
        });
      }
      // Hourly positions for 20h, newest 0.1h old: inside for 15h, then outside.
      const readings = Array.from({ length: 20 }, (_, i) => ({ hoursAgo: 19.1 - i, outside: i >= 15 }));
      await owner.getRepository(TelemetryReading).save(readings.flatMap((r) => (['latitude', 'longitude'] as const).map((signal) => ({
        tenantId: 'acme', imei: IMEI, signal, unit: 'deg', receivedAt: NOW, source: 'live' as const,
        value: signal === 'latitude' ? (r.outside ? 14 : 12.2) : 77.2,
        sourceTimestamp: new Date(NOW.getTime() - r.hoursAgo * HOUR),
      }))));
    };

    it('a fenced site: the machine has left, for the last 4.1 of 19.1 known hours', async () => {
      await plants.setBoundary(boss, plantId, SITE);
      await seed(true);
      const latest = await evaluator.evaluateOne(boss, EQUIPMENT, 'outside_site', NOW);
      expect({ readiness: latest.readiness, reason: latest.reason, value: latest.value }).toEqual({ readiness: 'ready', reason: undefined, value: 1 });
      const share = await evaluator.evaluateOne(boss, EQUIPMENT, 'fraction_outside_site', NOW);
      expect(share.readiness).toBe('ready');
      expect(share.value).toBeCloseTo(4.1 / 19.1, 5);
    });

    it('an unfenced site is not_configured, never "inside"', async () => {
      await plants.setBoundary(boss, plantId, null);
      await seed(true);
      expect(await evaluator.evaluateOne(boss, EQUIPMENT, 'outside_site', NOW))
        .toMatchObject({ value: null, readiness: 'not_configured', reason: 'site_boundary_not_set' });
    });

    it('a machine with no site at all is not_configured too', async () => {
      await plants.setBoundary(boss, plantId, SITE);
      await seed(false);
      expect(await evaluator.evaluateOne(boss, EQUIPMENT, 'fraction_outside_site', NOW))
        .toMatchObject({ value: null, readiness: 'not_configured', reason: 'site_boundary_not_set' });
    });
  });

  it(`${MIGRATION} runs down and up again`, async () => {
    await undoMigrationNamed(owner, MIGRATION);
    const [{ n }] = await owner.query(
      `SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'plant' AND column_name = 'boundary'`,
    );
    expect(n).toBe(0);
    await owner.runMigrations({ transaction: 'all' });
  });
});
