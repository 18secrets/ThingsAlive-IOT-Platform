import { DataSource } from 'typeorm';
import { RequestScope } from '../src/auth/types/request-scope';
import { Severity } from '../src/common/severity';
import { ClientScenario } from '../src/client-catalog/entities/client-scenario.entity';
import { EquipmentScenario } from '../src/activation/entities/equipment-scenario.entity';
import { PredictionBaseline } from '../src/prediction/entities/prediction-baseline.entity';
import { BaselineService } from '../src/prediction/services/baseline.service';
import { PredictionService } from '../src/prediction/services/prediction.service';
import { DeviceProjection } from '../src/projection/entities/device-projection.entity';
import { TelemetryReading } from '../src/telemetry/telemetry-reading.entity';
import { runTenantSpanning } from '../src/scope/tenant-session';
import { createAppDataSource, createTestDataSource, describeDb } from './db';

/**
 * The prediction runtime against a real Postgres (tasks P1-12, P1-13).
 *
 * Partitioning, an upsert that decides idempotency and a policy that has to reach
 * every partition are all Postgres behaviour. None of them can be demonstrated
 * anywhere else, and each of them fails silently when it is wrong.
 */
describeDb('prediction runtime', () => {
  let ds: DataSource;
  let owner: DataSource;
  let baselines: BaselineService;
  let predictions: PredictionService;

  const SOURCE = 'iot-platform-1';
  const ASSET = 'DG-1';
  const IMEI = 'imei-1';
  const NOW = new Date('2026-09-12T00:00:00.000Z');

  const acme: RequestScope = {
    tenantId: 'acme', userId: 'u-admin', roles: ['admin'], isPlatformRole: false,
  };
  const globex: RequestScope = {
    tenantId: 'globex', userId: 'u-globex', roles: ['admin'], isPlatformRole: false,
  };
  const asset = { sourceSystem: SOURCE, externalId: ASSET };

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    ds = await createAppDataSource();
    baselines = new BaselineService(ds);
    predictions = new PredictionService(ds);
  }, 30_000);

  afterAll(async () => { await ds?.destroy(); await owner?.destroy(); });

  /**
   * Forty readings alternating either side of eighty: a mean of 80 and a standard
   * deviation of about 2, over twenty days. Enough samples to clear the minimum, and
   * a shape simple enough that an expected z-score can be reasoned about rather than
   * taken from the code under test.
   */
  const history = (signal: string, source: 'live' | 'replayed' = 'live') =>
    Array.from({ length: 40 }, (_, i) => ({
      tenantId: 'acme', imei: IMEI, signal,
      value: i % 2 === 0 ? 78 : 82,
      unit: 'degC',
      sourceTimestamp: new Date(NOW.getTime() - (i + 1) * 12 * 3_600_000),
      receivedAt: NOW, source,
    }));

  const scenario = (slug: string, requiredSignals: string[], extra: Record<string, unknown> = {}) => ({
    tenantId: 'acme', slug, clientEquipmentClassSlug: 'diesel-generator',
    name: slug, description: null, severity: Severity.High, tier: 1 as any,
    requiredSignals, minimumHistoryDays: 0, parameters: [] as any,
    enabled: true, templateSlug: slug, templateVersion: 1, templateChecksum: 'c',
    copiedAt: NOW, status: 'active' as const, updatedBy: 'u-master', ...extra,
  });

  const activate = (slug: string, state = 'active', overrides: Record<string, unknown> = {}) => ({
    tenantId: 'acme', sourceSystem: SOURCE, externalId: ASSET, clientScenarioSlug: slug,
    state: state as any, parameterOverrides: overrides, blockersAtActivation: [],
    activatedBy: 'u-admin', activatedAt: NOW, stateChangedBy: 'u-admin',
    stateChangedAt: NOW, stateReason: null, lastEvaluatedAt: null,
  });

  beforeEach(async () => {
    for (const t of ['prediction', 'prediction_baseline', 'telemetry_reading',
      'equipment_scenario', 'device_projection', 'client_scenario']) {
      await owner.query(`DELETE FROM "${t}"`);
    }

    await runTenantSpanning(owner, 'test fixture', async (m) => {
      await m.getRepository(DeviceProjection).save({
        tenantId: 'acme', sourceSystem: SOURCE, externalId: 'dev-1', checksum: 'c1',
        imei: IMEI, equipmentExternalId: ASSET, name: null, payload: {},
        sourceUpdatedAt: NOW, syncedAt: NOW, status: 'live' as const,
      });
      await m.getRepository(ClientScenario).save(scenario('dg-coolant-overheat', ['coolant_temp']));
      await m.getRepository(EquipmentScenario).save(activate('dg-coolant-overheat'));
      await m.getRepository(TelemetryReading).save(history('coolant_temp'));
    });
  });

  const addReading = (value: number, minutesAfter = 60, source: 'live' | 'replayed' = 'live') =>
    runTenantSpanning(owner, 'test fixture', (m) =>
      m.getRepository(TelemetryReading).save({
        tenantId: 'acme', imei: IMEI, signal: 'coolant_temp', value, unit: 'degC',
        sourceTimestamp: new Date(NOW.getTime() + minutesAfter * 60_000),
        receivedAt: NOW, source,
      }));

  describe('the partitioned store', () => {
    it('gives every partition the isolation policy, not just the parent', async () => {
      // A partition read directly answers to its own policies. One created by hand
      // without them works perfectly and is readable by every tenant, which is the
      // failure this schema is shaped to make impossible.
      const parts: { relname: string }[] = await owner.query(
        `SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
          WHERE i.inhparent = 'prediction'::regclass`,
      );
      expect(parts.length).toBeGreaterThan(5);

      const policed: { tablename: string }[] = await owner.query(
        `SELECT tablename FROM pg_policies WHERE policyname = 'tenant_isolation'`,
      );
      const named = new Set(policed.map((p) => p.tablename));
      expect(parts.filter((p) => !named.has(p.relname)).map((p) => p.relname)).toEqual([]);
    });

    it('creates a month on demand, and creating it twice is not an error', async () => {
      const [a] = await owner.query(`SELECT ta_ensure_prediction_partition('2027-03-04'::date) AS n`);
      const [b] = await owner.query(`SELECT ta_ensure_prediction_partition('2027-03-29'::date) AS n`);
      expect(a.n).toBe('prediction_2027_03');
      expect(b.n).toBe('prediction_2027_03');
    });

    it('routes a prediction into the partition for its month, leaving the default empty', async () => {
      await baselines.refresh(acme, asset, 30, NOW);
      await addReading(90);
      await predictions.scoreAsset(acme, asset, NOW);

      const [row] = await owner.query(
        `SELECT tableoid::regclass::text AS part FROM "prediction"`,
      );
      expect(row.part).toBe('prediction_2026_09');

      // The default partition is a safety net and is meant to stay empty. A row in it
      // does more than lose the benefit of partitioning: once it holds a row for a
      // month, the partition for that month can no longer be created, because
      // attaching it would have to move the row. Missed maintenance quietly becomes a
      // repair that needs downtime.
      const [{ count }] = await owner.query(`SELECT count(*)::int FROM "prediction_default"`);
      expect(count).toBe(0);
    });
  });

  describe('baselines', () => {
    it('computes normal from the window, with coverage as well as sample count', async () => {
      const [b] = await baselines.refresh(acme, asset, 30, NOW);

      expect(b.signal).toBe('coolant_temp');
      expect(Number(b.mean)).toBeCloseTo(80, 6);
      expect(Number(b.stddev)).toBeCloseTo(2.025, 2);
      expect(b.sampleCount).toBe(40);
      // Twenty days of readings inside a thirty-day window. Sample count alone cannot
      // say this — a chatty logger running for one afternoon produces more samples
      // than this and covers a single day.
      expect(b.coverageRatio).toBeCloseTo(20 / 30, 2);
      expect(b.source).toBe('live');
    });

    it('recomputing the same window rewrites the row rather than adding one', async () => {
      const [first] = await baselines.refresh(acme, asset, 30, NOW);
      const [again] = await baselines.refresh(acme, asset, 30, NOW);

      expect(again.id).toBe(first.id);
      expect(Number(again.mean)).toBe(Number(first.mean));
      const rows = await owner.getRepository(PredictionBaseline).find();
      expect(rows).toHaveLength(1);
    });

    it('keeps windows of different lengths as separate facts', async () => {
      await baselines.refresh(acme, asset, 30, NOW);
      await baselines.refresh(acme, asset, 7, NOW);
      const rows = await owner.getRepository(PredictionBaseline).find();
      expect(rows.map((r) => r.windowDays).sort((a, b) => a - b)).toEqual([7, 30]);
      // The seven-day window sees fewer of the same readings, so it is a different
      // number — which is the point of keeping both.
      expect(rows.find((r) => r.windowDays === 7)!.sampleCount).toBeLessThan(40);
    });

    it('says when a baseline was built from replayed history', async () => {
      await addReading(80, -30, 'replayed');
      const [b] = await baselines.refresh(acme, asset, 30, NOW);
      // Same arithmetic, different evidence. Anyone looking at a surprising
      // prediction asks where the numbers came from within the first minute.
      expect(b.source).toBe('mixed');
    });

    it('cannot be read from another account', async () => {
      await baselines.refresh(acme, asset, 30, NOW);
      expect(await baselines.forAsset(globex, asset, 30)).toEqual([]);
    });
  });

  describe('scoring', () => {
    it('scores an active scenario and keys the row to the logger clock', async () => {
      await baselines.refresh(acme, asset, 30, NOW);
      await addReading(90, 60);

      const result = await predictions.scoreAsset(acme, asset, NOW);

      expect(result.skipped).toEqual([]);
      expect(result.written).toHaveLength(1);
      const [p] = result.written;
      expect(p.severity).toBe(Severity.Critical);
      expect(p.confidence).toBe('full');
      expect(p.abnormalCount).toBe(1);
      // Not `now`. A replay of this telemetry next year must produce the same key, or
      // it writes a year of duplicate predictions all dated the day of the replay.
      expect(new Date(p.occurredAt).toISOString()).toBe('2026-09-12T01:00:00.000Z');
    });

    it('scoring the same telemetry twice updates one row instead of writing two', async () => {
      await baselines.refresh(acme, asset, 30, NOW);
      await addReading(90);

      const first = await predictions.scoreAsset(acme, asset, NOW);
      const second = await predictions.scoreAsset(acme, asset, NOW);

      expect(second.written[0].id).toBe(first.written[0].id);
      const [{ count }] = await owner.query(`SELECT count(*)::int FROM "prediction"`);
      expect(count).toBe(1);
    });

    it('scores only what is active, and says nothing about the rest', async () => {
      await runTenantSpanning(owner, 'test fixture', async (m) => {
        await m.getRepository(ClientScenario).save(scenario('dg-oil-pressure', ['oil_pressure']));
        await m.getRepository(EquipmentScenario).save(activate('dg-oil-pressure', 'paused'));
      });
      await baselines.refresh(acme, asset, 30, NOW);
      await addReading(90);

      const result = await predictions.scoreAsset(acme, asset, NOW);
      // A paused scenario that kept scoring would make pausing cosmetic, and somebody
      // would eventually rely on it having stopped.
      expect(result.written.map((p) => p.clientScenarioSlug)).toEqual(['dg-coolant-overheat']);
      expect(result.skipped).toEqual([]);
    });

    it('names the reason when an active scenario produces nothing', async () => {
      await runTenantSpanning(owner, 'test fixture', async (m) => {
        await m.getRepository(ClientScenario).save(scenario('dg-vibration', ['vibration_velocity']));
        await m.getRepository(EquipmentScenario).save(activate('dg-vibration'));
        await m.getRepository(ClientScenario).save(scenario('dg-off', ['coolant_temp'], { enabled: false }));
        await m.getRepository(EquipmentScenario).save(activate('dg-off'));
      });
      await baselines.refresh(acme, asset, 30, NOW);

      const result = await predictions.scoreAsset(acme, asset, NOW);
      // An asset that silently produces no predictions is indistinguishable from one
      // whose predictions are all fine.
      expect(result.skipped).toEqual(expect.arrayContaining([
        { clientScenarioSlug: 'dg-vibration', reason: 'no-readings' },
        { clientScenarioSlug: 'dg-off', reason: 'scenario-disabled' },
      ]));
    });

    it('records that it could not tell, rather than that all is well', async () => {
      // Readings, but no baseline to compare them against.
      await addReading(90);
      const result = await predictions.scoreAsset(acme, asset, NOW);

      const [p] = result.written;
      expect(p.severity).toBe(Severity.None);
      expect(p.confidence).toBe('none');
      expect(p.riskScore).toBe(0);
      // The row exists and carries the reason, so a screen can say "not yet scored"
      // instead of showing a machine in the healthy column.
      expect(p.signals[0]).toMatchObject({ signal: 'coolant_temp', reason: 'no-baseline' });
    });

    it('lets an asset override the scenario threshold', async () => {
      await runTenantSpanning(owner, 'test fixture', (m) =>
        m.getRepository(EquipmentScenario).update(
          { tenantId: 'acme', clientScenarioSlug: 'dg-coolant-overheat' },
          { parameterOverrides: { critical_sigma: 10 } },
        ));
      await baselines.refresh(acme, asset, 30, NOW);
      await addReading(90);

      const [p] = (await predictions.scoreAsset(acme, asset, NOW)).written;
      // Five sigma, and this asset says critical starts at ten. Warning, not critical.
      expect(p.severity).not.toBe(Severity.Critical);
      expect(p.signals[0].state).toBe('warning');
    });

    it('keeps a history rather than overwriting the last answer', async () => {
      await baselines.refresh(acme, asset, 30, NOW);
      await addReading(90, 60);
      await predictions.scoreAsset(acme, asset, NOW);
      await addReading(81, 120);
      await predictions.scoreAsset(acme, asset, NOW);

      const rows = await predictions.historyFor(
        acme, { ...asset, clientScenarioSlug: 'dg-coolant-overheat' },
      );
      expect(rows).toHaveLength(2);
      // Newest first, and the newest is the calm one — a machine that recovered.
      expect(rows[0].severity).toBe(Severity.None);
      expect(rows[1].severity).toBe(Severity.Critical);

      const latest = await predictions.latestFor(acme, asset);
      expect(latest).toHaveLength(1);
      expect(latest[0].severity).toBe(Severity.None);
    });

    it('cannot be read from another account', async () => {
      await baselines.refresh(acme, asset, 30, NOW);
      await addReading(90);
      await predictions.scoreAsset(acme, asset, NOW);

      expect(await predictions.latestFor(globex, asset)).toEqual([]);
      // And the other account scores nothing, because it can see neither the
      // activation nor the telemetry.
      const theirs = await predictions.scoreAsset(globex, asset, NOW);
      expect(theirs).toEqual({ written: [], skipped: [] });
    });
  });
});
