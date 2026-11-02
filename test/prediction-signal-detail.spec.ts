import { BadRequestException, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { RequestScope } from '../src/auth/types/request-scope';
import { Severity } from '../src/common/severity';
import { ClientScenario } from '../src/client-catalog/entities/client-scenario.entity';
import { EquipmentScenario } from '../src/activation/entities/equipment-scenario.entity';
import { BaselineService } from '../src/prediction/services/baseline.service';
import { PredictionService } from '../src/prediction/services/prediction.service';
import { DeviceProjection } from '../src/projection/entities/device-projection.entity';
import { TelemetryReading } from '../src/telemetry/telemetry-reading.entity';
import { runTenantSpanning } from '../src/scope/tenant-session';
import { createAppDataSource, createTestDataSource, describeDb } from './db';
import { bindProjectedDevice } from './bind-projected-devices';

/**
 * Opening one signal of a scenario card: its readings, and the lines it was judged
 * against.
 *
 * The thresholds come back computed rather than left to the page, because a page that
 * rebuilt them would have to know every override the scorer honours, and the day it
 * missed one the chart would show a line the verdict was never measured against.
 */
describeDb('prediction signal detail', () => {
  let ds: DataSource;
  let owner: DataSource;
  let baselines: BaselineService;
  let predictions: PredictionService;

  const SOURCE = 'iot-platform-1';
  const ASSET = 'DG-1';
  const IMEI = 'imei-1';
  const NOW = new Date('2026-09-12T00:00:00.000Z');
  const SLUG = 'dg-coolant-overheat';

  const acme: RequestScope = { tenantId: 'acme', userId: 'u-admin', roles: ['admin'], isPlatformRole: false };
  const globex: RequestScope = { tenantId: 'globex', userId: 'u-globex', roles: ['admin'], isPlatformRole: false };
  const asset = { sourceSystem: SOURCE, externalId: ASSET };
  const card = { ...asset, clientScenarioSlug: SLUG };

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    ds = await createAppDataSource();
    baselines = new BaselineService(ds);
    predictions = new PredictionService(ds);
  }, 30_000);

  afterAll(async () => { await ds?.destroy(); await owner?.destroy(); });

  const reading = (signal: string, value: number, at: Date) => ({
    tenantId: 'acme', imei: IMEI, signal, value, unit: 'degC', sourceTimestamp: at, receivedAt: NOW, source: 'live' as const,
  });

  /** Mean 80, sample deviation about 2.025: the same history the scorer's own suite uses. */
  const history = () => Array.from({ length: 40 }, (_, i) =>
    reading('coolant_temp', i % 2 === 0 ? 78 : 82, new Date(NOW.getTime() - (i + 1) * 12 * 3_600_000)));

  const add = (...rows: [number, number][]) => runTenantSpanning(owner, 'test fixture', (m) =>
    m.getRepository(TelemetryReading).save(rows.map(([value, secondsAfter]) =>
      reading('coolant_temp', value, new Date(NOW.getTime() + secondsAfter * 1000)))));

  beforeEach(async () => {
    for (const t of ['work_order_event', 'work_order', 'work_order_counter', 'prediction', 'prediction_baseline',
      'telemetry_reading', 'equipment_scenario', 'device_projection', 'client_scenario']) {
      await owner.query(`DELETE FROM "${t}"`);
    }
    await runTenantSpanning(owner, 'test fixture', async (m) => {
      await m.getRepository(DeviceProjection).save({
        tenantId: 'acme', sourceSystem: SOURCE, externalId: 'dev-1', checksum: 'c1',
        imei: IMEI, equipmentExternalId: ASSET, name: null, payload: {},
        sourceUpdatedAt: NOW, syncedAt: NOW, status: 'live' as const,
      });
      await bindProjectedDevice(m, { tenantId: 'acme', sourceSystem: SOURCE, externalId: ASSET, imei: IMEI });
      await m.getRepository(ClientScenario).save({
        tenantId: 'acme', slug: SLUG, clientEquipmentClassSlug: 'diesel-generator',
        name: SLUG, description: null, severity: Severity.High, tier: 1 as any,
        requiredSignals: ['coolant_temp'], minimumHistoryDays: 0, parameters: [] as any,
        enabled: true, templateSlug: SLUG, templateVersion: 1, templateChecksum: 'c',
        copiedAt: NOW, status: 'active' as const, updatedBy: 'u-master',
      });
      await m.getRepository(EquipmentScenario).save({
        tenantId: 'acme', sourceSystem: SOURCE, externalId: ASSET, clientScenarioSlug: SLUG,
        state: 'active' as any, parameterOverrides: {}, blockersAtActivation: [],
        activatedBy: 'u-admin', activatedAt: NOW, stateChangedBy: 'u-admin',
        stateChangedAt: NOW, stateReason: null, lastEvaluatedAt: null,
      });
      await m.getRepository(TelemetryReading).save(history());
    });
    await baselines.refresh(acme, asset, 30, NOW);
  });

  it('charts the window ending at the verdict, with the bands it was judged against', async () => {
    await add([90, 3600]);
    const [p] = (await predictions.scoreAsset(acme, asset, NOW)).written;

    const d = await predictions.signalDetail(acme, card, 'coolant_temp');

    expect(d.predictionId).toBe(p.id);
    expect(d.occurredAt).toBe('2026-09-12T01:00:00.000Z');
    expect(d.window.to).toBe(d.occurredAt);
    expect(d.window.from).toBe('2026-09-09T01:00:00.000Z');
    expect(d.verdict).toMatchObject({ signal: 'coolant_temp', state: 'critical', value: 90 });

    // 80 ± 1.5σ and 80 ± 2.5σ, σ ≈ 2.025: worked out here, not read back from the code.
    expect(d.baseline!.mean).toBeCloseTo(80, 6);
    expect(d.baseline!.warning.hi).toBeCloseTo(80 + 1.5 * 2.025, 2);
    expect(d.baseline!.warning.lo).toBeCloseTo(80 - 1.5 * 2.025, 2);
    expect(d.baseline!.critical.hi).toBeCloseTo(80 + 2.5 * 2.025, 2);
    expect(d.baseline!.windowDays).toBe(30);

    // Five history readings fall in the 72 hours before the verdict, plus the hot one.
    expect(d.readings.map((r) => r.avg)).toEqual([78, 82, 78, 82, 78, 90]);
    expect(d.readings.every((r) => r.at >= d.window.from && r.at <= d.window.to)).toBe(true);
  });

  it('keeps a spike that bucketing would otherwise average away', async () => {
    await add([90, 3600], [99, 3601], [90, 3602]);
    await predictions.scoreAsset(acme, asset, NOW);

    const d = await predictions.signalDetail(acme, card, 'coolant_temp');

    const last = d.readings[d.readings.length - 1];
    // Dated by its newest reading, which is the one the verdict was scored on.
    expect(last.at).toBe(d.occurredAt);
    expect(last.count).toBe(3);
    expect(last.avg).toBeCloseTo(93, 6);
    expect(last.max).toBe(99);
    expect(last.min).toBe(90);
  });

  it('draws the bands at the thresholds this machine overrides, not the defaults', async () => {
    await runTenantSpanning(owner, 'test fixture', (m) =>
      m.getRepository(EquipmentScenario).update(
        { tenantId: 'acme', clientScenarioSlug: SLUG }, { parameterOverrides: { warning_sigma: 2, critical_sigma: 4 } }));
    await add([90, 3600]);
    await predictions.scoreAsset(acme, asset, NOW);

    const d = await predictions.signalDetail(acme, card, 'coolant_temp');

    expect(d.baseline!.warningSigma).toBe(2);
    expect(d.baseline!.critical.hi).toBeCloseTo(80 + 4 * 2.025, 2);
  });

  it('answers before the first score, saying there is no verdict yet', async () => {
    const d = await predictions.signalDetail(acme, card, 'coolant_temp');

    expect(d.predictionId).toBeNull();
    expect(d.occurredAt).toBeNull();
    expect(d.verdict).toBeNull();
    expect(d.baseline!.mean).toBeCloseTo(80, 6);
  });

  it('refuses a signal the scenario does not watch', async () => {
    await add([90, 3600]);
    await predictions.scoreAsset(acme, asset, NOW);
    await expect(predictions.signalDetail(acme, card, 'fuel_level')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('refuses a scenario that is not on this machine', async () => {
    await expect(predictions.signalDetail(acme, { ...card, externalId: 'DG-2' }, 'coolant_temp'))
      .rejects.toBeInstanceOf(NotFoundException);
  });

  it('refuses a window it would not draw honestly', async () => {
    for (const hours of [0, 721, 1.5, Number.NaN]) {
      await expect(predictions.signalDetail(acme, card, 'coolant_temp', hours)).rejects.toBeInstanceOf(BadRequestException);
    }
  });

  it('cannot be read from another account', async () => {
    await add([90, 3600]);
    await predictions.scoreAsset(acme, asset, NOW);
    // Row-level security hides the activation, so to globex the card does not exist.
    await expect(predictions.signalDetail(globex, card, 'coolant_temp')).rejects.toBeInstanceOf(NotFoundException);
  });
});
