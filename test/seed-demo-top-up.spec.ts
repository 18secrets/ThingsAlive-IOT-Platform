import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AlertService } from '../src/alert/services/alert.service';
import { RequestScope } from '../src/auth/types/request-scope';
import {
  CADENCE_SECONDS, DEMO_SOURCE, DEMO_TENANT, imeiOf, DEMO_MACHINES, seedDemo, topUpDemo,
} from '../src/database/seeds/seed-demo';
import { KpiEvaluatorService } from '../src/kpi/services/kpi-evaluator.service';
import { KpiEnvelope } from '../src/kpi/types';
import { createApp } from '../src/main';
import { PageService } from '../src/page/page.service';
import { FailureModeRow, ReadinessRow } from '../src/page/page-widgets';
import { createTestDataSource, describeDb } from './db';

/** A Tuesday, 12:30 in Pune — the seed's own test clock. */
const SEEDED = new Date('2026-10-06T07:00:00.000Z');
/** Three hours on, still mid-shift: long past the hour after which an un-topped demo goes stale. */
const LATER = new Date(SEEDED.getTime() + 3 * 3_600_000);
/** Ten days on, a Friday at 12:30: past the point where EX-05 would cross the baseline's coverage threshold. */
const MUCH_LATER = new Date(SEEDED.getTime() + 10 * 86_400_000);
const ENABLED = { SEED_DEMO_ENABLED: 'true' } as NodeJS.ProcessEnv;
const demo: RequestScope = { tenantId: DEMO_TENANT, userId: 'u-demo', roles: ['ceo-manager'], isPlatformRole: false };
const ref = (externalId: string) => ({ sourceSystem: DEMO_SOURCE, externalId });
const machine = (externalId: string) => DEMO_MACHINES.find((m) => m.externalId === externalId)!;

/**
 * D-001, phase 1 manual testing: an hour after seeding every demo machine read stale,
 * so five of the six states were unreadable. The top-up keeps readings arriving. Each
 * state is asserted at a clock the seed alone cannot satisfy, through the producers a
 * tester's screen reads — the evaluator, the page, alerts.
 */
describeDb('seed:demo top-up', () => {
  let owner: DataSource;
  let app: INestApplication;
  let evaluator: KpiEvaluatorService;
  let pages: PageService;
  let alerts: AlertService;

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    process.env.AUTH_JWT_SECRET = 'test-secret-seed-demo-top-up';
    process.env.AUTH_JWT_ISSUER = 'things-alive-seed-demo-top-up-test';
    process.env.AUTH_TENANT_CLAIM = 'client_id';
    process.env.CORS_ORIGINS = 'http://localhost:3000';
    app = await createApp({ database: true });
    await app.init();
    evaluator = app.get(KpiEvaluatorService);
    pages = app.get(PageService);
    alerts = app.get(AlertService);
    await seedDemo(owner, { now: SEEDED, env: ENABLED });
  }, 180_000);

  afterAll(async () => { await app?.close(); await owner?.destroy(); });

  const kpis = async (externalId: string, at: Date) =>
    new Map((await evaluator.evaluateAll(demo, ref(externalId), at)).map((e) => [e.formulaKey, e] as [string, KpiEnvelope]));
  const notReady = async (externalId: string, at: Date) =>
    [...(await kpis(externalId, at)).values()].filter((e) => e.readiness !== 'ready').map((e) => `${e.formulaKey}: ${e.reason}`);
  const readiness = async (externalId: string, at: Date) => {
    const page = await pages.machinePage(demo, ref(externalId), at);
    return new Map(((page.widgets.find((w) => w.widgetKey === 'readiness')!.data ?? []) as ReadinessRow[]).map((r) => [r.signal, r]));
  };
  const openAlertsOn = async (externalId: string) =>
    (await alerts.listEvents(demo, { state: ['open', 'acknowledged'] })).filter((e) => e.externalId === externalId);
  const readingCount = async () => {
    const [{ n }] = await owner.query(`SELECT count(*)::int AS n FROM telemetry_reading WHERE tenant_id = $1`, [DEMO_TENANT]);
    return n as number;
  };

  // ==================================================================== the defect
  it('without a top-up, three hours after seeding even the healthy machine reads stale (D-001 as found)', async () => {
    expect((await kpis('EX-01', LATER)).get('avg_coolant_temp')).toMatchObject({ readiness: 'not_available', reason: 'stale' });
  });

  // ==================================================================== guards
  it('refuses without SEED_DEMO_ENABLED=true, and writes nothing', async () => {
    const before = await readingCount();
    await expect(topUpDemo(owner, { now: LATER, env: {} })).rejects.toThrow(/SEED_DEMO_ENABLED=true/);
    expect(await readingCount()).toBe(before);
  });

  // ==================================================================== idempotence
  it('two top-ups fired together both settle, and every reading is written once', async () => {
    const results = await Promise.allSettled([
      topUpDemo(owner, { now: LATER, env: ENABLED }),
      topUpDemo(owner, { now: LATER, env: ENABLED }),
    ]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    // Three hours at the 10-minute cadence is 18 ticks, for six signals, on the five
    // machines that are not quiet — once, whichever call wrote them. Counted after the
    // seed clock, because EX-05's trim removes the same three hours from its far end.
    const ticks = (LATER.getTime() - SEEDED.getTime()) / (CADENCE_SECONDS * 1000);
    const [{ n }] = await owner.query(
      `SELECT count(*)::int AS n FROM telemetry_reading WHERE tenant_id = $1 AND source_timestamp > $2`,
      [DEMO_TENANT, SEEDED],
    );
    expect(n).toBe(ticks * 6 * 5);
    const [{ dupes }] = await owner.query(
      `SELECT count(*)::int AS dupes FROM (SELECT 1 FROM telemetry_reading WHERE tenant_id = $1
         GROUP BY imei, signal, source_timestamp HAVING count(*) > 1) d`, [DEMO_TENANT],
    );
    expect(dupes).toBe(0);
  });

  it('run again at the same clock, it writes nothing', async () => {
    const before = await readingCount();
    const again = await topUpDemo(owner, { now: LATER, env: ENABLED });
    expect(Object.values(again.written).every((n) => n === 0)).toBe(true);
    expect(await readingCount()).toBe(before);
  });

  // ==================================================================== the six states, three hours on
  it('EX-01 healthy: every KPI ready, no alert', async () => {
    expect(await notReady('EX-01', LATER)).toEqual([]);
    expect(await openAlertsOn('EX-01')).toEqual([]);
  });

  it('EX-02 trending: ready, its new readings still under the 105 °C bound, no alert', async () => {
    expect((await kpis('EX-02', LATER)).get('avg_coolant_temp')!.readiness).toBe('ready');
    const [{ max }] = await owner.query(
      `SELECT max(value) AS max FROM telemetry_reading
        WHERE tenant_id = $1 AND imei = $2 AND signal = 'engine_coolant_temperature' AND source_timestamp > $3`,
      [DEMO_TENANT, imeiOf(machine('EX-02')), SEEDED],
    );
    expect(Number(max)).toBeLessThan(105);
    expect(await openAlertsOn('EX-02')).toEqual([]);
  });

  it('EX-03 breaching: still six of the last ten running readings past 105 °C, one open alert, COOLANT_OVERHEAT active', async () => {
    const last: { value: number }[] = await owner.query(
      `SELECT value FROM telemetry_reading
        WHERE tenant_id = $1 AND imei = $2 AND signal = 'engine_coolant_temperature' AND source_timestamp <= $3
        ORDER BY source_timestamp DESC LIMIT 10`,
      [DEMO_TENANT, imeiOf(machine('EX-03')), LATER],
    );
    expect(last.filter((r) => Number(r.value) > 105)).toHaveLength(6);
    expect((await openAlertsOn('EX-03')).map((e) => [e.severity, e.state])).toEqual([['high', 'open']]);
    const page = await pages.machinePage(demo, ref('EX-03'), LATER);
    const modes = page.widgets.find((w) => w.widgetKey === 'failure_modes')!.data as FailureModeRow[];
    expect(modes.find((f) => f.code === 'COOLANT_OVERHEAT')!.status).toBe('active');
    expect((await kpis('EX-03', LATER)).get('avg_coolant_temp')!.readiness).toBe('ready');
  });

  it('EX-04 gone quiet: not topped up — still stale, not no_readings', async () => {
    const [{ last }] = await owner.query(
      `SELECT max(source_timestamp) AS last FROM telemetry_reading WHERE tenant_id = $1 AND imei = $2`,
      [DEMO_TENANT, imeiOf(machine('EX-04'))],
    );
    expect(new Date(last).getTime()).toBeLessThanOrEqual(SEEDED.getTime() - 3 * 86_400_000);
    const rows = [...(await readiness('EX-04', LATER)).values()];
    expect(rows.every((r) => r.reason === 'stale')).toBe(true);
  });

  it('EX-05 newly commissioned: plain KPIs ready, every baseline KPI baseline_not_established', async () => {
    const envelopes = await kpis('EX-05', LATER);
    expect(envelopes.get('avg_coolant_temp')!.readiness).toBe('ready');
    for (const key of ['coolant_vs_baseline', 'hydraulic_vs_baseline']) {
      expect(envelopes.get(key)).toMatchObject({ readiness: 'not_available', reason: 'baseline_not_established' });
    }
  });

  it('EX-06 partly unbound: the two unbound signals read not_configured / unbound, the rest ready', async () => {
    const rows = await readiness('EX-06', LATER);
    expect(rows.get('hydraulic_oil_temperature')).toMatchObject({ readiness: 'not_configured', reason: 'unbound' });
    expect(rows.get('fuel_level')).toMatchObject({ readiness: 'not_configured', reason: 'unbound' });
    for (const signal of ['engine_running_status', 'engine_coolant_temperature', 'engine_oil_pressure']) {
      expect(rows.get(signal)!.readiness).toBe('ready');
    }
  });

  // ==================================================================== ten days on
  it('ten days on, EX-05 is still newly commissioned: its history is trimmed to nine days, not grown past the baseline threshold', async () => {
    const result = await topUpDemo(owner, { now: MUCH_LATER, env: ENABLED });
    expect(result.trimmed).toBeGreaterThan(0);
    const [{ first }] = await owner.query(
      `SELECT min(source_timestamp) AS first FROM telemetry_reading WHERE tenant_id = $1 AND imei = $2`,
      [DEMO_TENANT, imeiOf(machine('EX-05'))],
    );
    expect(new Date(first).getTime()).toBeGreaterThanOrEqual(MUCH_LATER.getTime() - 9 * 86_400_000);
    const envelopes = await kpis('EX-05', MUCH_LATER);
    expect(envelopes.get('avg_coolant_temp')!.readiness).toBe('ready');
    expect(envelopes.get('coolant_vs_baseline')).toMatchObject({ readiness: 'not_available', reason: 'baseline_not_established' });
    // And the healthy machine is still entirely ready, ten days after it was seeded.
    expect(await notReady('EX-01', MUCH_LATER)).toEqual([]);
  });
});
