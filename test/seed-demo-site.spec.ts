import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { RequestScope } from '../src/auth/types/request-scope';
import {
  countDemoRows, DEMO_SITE_CLASS, DEMO_SOURCE, DEMO_TENANT, resetDemo, seedDemo,
} from '../src/database/seeds/seed-demo';
import { KpiEvaluatorService } from '../src/kpi/services/kpi-evaluator.service';
import { createApp } from '../src/main';
import { PageService } from '../src/page/page.service';
import { MachineRow, PageWidget, SiteKpiData } from '../src/page/page-widgets';
import { createTestDataSource, describeDb, undoMigrationNamed } from './db';

const MIGRATION = 'SeedOnlySiteClass1759100000000';
/** A Tuesday, 12:30 in Pune — the seed's own test clock. */
const NOW = new Date('2026-10-06T07:00:00.000Z');
const ENABLED = { SEED_DEMO_ENABLED: 'true' } as NodeJS.ProcessEnv;
const demo: RequestScope = { tenantId: DEMO_TENANT, userId: 'u-demo', roles: ['ceo-manager'], isPlatformRole: false };

/**
 * D-004, phase 1 manual testing (T11, T12): the demo's site page used the platform
 * `default` site class, which binds no KPI, so site aggregation could not be seen. The
 * seeder now authors its own seed-only site class. Asserted through the page a tester
 * opens, and by attempting to put a real tenant's plant on that class.
 */
describeDb('seed:demo site pages (D-004)', () => {
  let owner: DataSource;
  let app: INestApplication;
  let pages: PageService;
  let evaluator: KpiEvaluatorService;

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    process.env.AUTH_JWT_SECRET = 'test-secret-seed-demo-site';
    process.env.AUTH_JWT_ISSUER = 'things-alive-seed-demo-site-test';
    process.env.AUTH_TENANT_CLAIM = 'client_id';
    process.env.CORS_ORIGINS = 'http://localhost:3000';
    app = await createApp({ database: true });
    await app.init();
    pages = app.get(PageService);
    evaluator = app.get(KpiEvaluatorService);
    await seedDemo(owner, { now: NOW, env: ENABLED });
  }, 180_000);

  afterAll(async () => { await app?.close(); await owner?.destroy(); });

  const plantId = async (code: string) =>
    (await owner.query(`SELECT id FROM plant WHERE tenant_id = $1 AND code = $2`, [DEMO_TENANT, code]))[0].id as string;
  const widgets = async (code: string) =>
    new Map((await pages.sitePage(demo, await plantId(code), NOW)).widgets.map((w) => [w.widgetKey, w] as [string, PageWidget]));

  // ==================================================================== PUNE-01
  it('PUNE-01 still lists all six machines', async () => {
    const list = (await widgets('PUNE-01')).get('machines')!.data as MachineRow[];
    expect(list.map((m) => m.externalId).sort()).toEqual(['EX-01', 'EX-02', 'EX-03', 'EX-04', 'EX-05', 'EX-06']);
  });

  it('average coolant: five machines included, EX-04 excluded as not ready', async () => {
    const w = (await widgets('PUNE-01')).get('site_avg_coolant')!;
    expect(w.readiness).toBe('ready');
    expect(w.data).toMatchObject({
      aggregate: 'avg', unit: 'degC', machinesIncluded: 5, machinesExcluded: 1, excluded: { notDeclared: 0, notReady: 1 },
    });
    expect(typeof (w.data as SiteKpiData).value).toBe('number');
  });

  it('average fuel: four included — EX-04 stale and EX-06 unbound both excluded', async () => {
    const w = (await widgets('PUNE-01')).get('site_avg_fuel')!;
    expect(w.data).toMatchObject({ machinesIncluded: 4, machinesExcluded: 2, excluded: { notDeclared: 0, notReady: 2 } });
  });

  it('lowest oil pressure is the minimum of the ready machines\' own values, not of all six', async () => {
    const w = (await widgets('PUNE-01')).get('site_min_oil_pressure')!;
    const own = await Promise.all(['EX-01', 'EX-02', 'EX-03', 'EX-05', 'EX-06'].map(async (externalId) =>
      (await evaluator.evaluateOne(demo, { sourceSystem: DEMO_SOURCE, externalId }, 'avg_oil_pressure', NOW)).value as number));
    expect((w.data as SiteKpiData).value).toBeCloseTo(Math.min(...own), 9);
  });

  // ==================================================================== PUNE-02
  it('PUNE-02 has no machines: every site KPI reads no_ready_machines with a null value — never 0', async () => {
    const site = await widgets('PUNE-02');
    expect((site.get('machines')!.data as MachineRow[])).toEqual([]);
    for (const key of ['site_avg_coolant', 'site_min_oil_pressure', 'site_avg_fuel']) {
      expect(site.get(key)).toMatchObject({ readiness: 'not_available', reason: 'no_ready_machines', data: null });
    }
  });

  // ==================================================================== the guard
  it('the database refuses a real tenant\'s new plant on the seed-only site class', async () => {
    await expect(owner.query(
      `INSERT INTO plant (tenant_id, code, name, site_class_slug, site_class_version) VALUES ('acme', 'A-1', 'Acme yard', $1, 1)`,
      [DEMO_SITE_CLASS],
    )).rejects.toThrow(/ck_seed_only_site/);
    expect(await owner.query(`SELECT count(*)::int AS n FROM plant WHERE tenant_id = 'acme'`)).toEqual([{ n: 0 }]);
  });

  it('the database refuses moving an existing plant onto it, and leaves the plant on its class', async () => {
    await owner.query(`INSERT INTO plant (tenant_id, code, name) VALUES ('acme', 'A-2', 'Acme depot')`);
    await expect(owner.query(
      `UPDATE plant SET site_class_slug = $1, site_class_version = 1 WHERE tenant_id = 'acme' AND code = 'A-2'`, [DEMO_SITE_CLASS],
    )).rejects.toThrow(/ck_seed_only_site/);
    expect(await owner.query(`SELECT site_class_slug FROM plant WHERE tenant_id = 'acme' AND code = 'A-2'`))
      .toEqual([{ site_class_slug: null }]);
  });

  it('the platform default site class is untouched: still no KPI on it', async () => {
    expect(await owner.query(
      `SELECT count(*)::int AS n FROM site_class_layout WHERE site_class_slug = 'default' AND bound_to IS NOT NULL`,
    )).toEqual([{ n: 0 }]);
    expect(await owner.query(`SELECT seed_only FROM site_class WHERE slug = 'default'`)).toEqual([{ seed_only: false }]);
  });

  // ==================================================================== reset
  it('reset removes the site class and both plants; another tenant\'s plant stays', async () => {
    const removed = await resetDemo(owner, ENABLED);
    expect(removed).toMatchObject({ plant: 2, site_class: 1, site_class_layout: 6 });
    expect(await countDemoRows(owner)).toEqual({});
    expect(await owner.query(`SELECT count(*)::int AS n FROM plant WHERE tenant_id = 'acme'`)).toEqual([{ n: 1 }]);
  }, 120_000);

  it('reset refuses to remove a site class by that name that is not seed_only', async () => {
    await owner.query(
      `INSERT INTO site_class (slug, version, name, status, seed_only) VALUES ($1, 1, 'A library site class', 'published', false)`,
      [DEMO_SITE_CLASS],
    );
    await expect(resetDemo(owner, ENABLED)).rejects.toThrow(/not seed_only/);
    await owner.query(`DELETE FROM site_class WHERE slug = $1`, [DEMO_SITE_CLASS]);
  });

  // ==================================================================== down path
  it(`down path (${MIGRATION}): the column, the trigger and its function are gone`, async () => {
    await undoMigrationNamed(owner, MIGRATION);
    expect(await owner.query(
      `SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'site_class' AND column_name = 'seed_only'`,
    )).toEqual([{ n: 0 }]);
    expect(await owner.query(`SELECT count(*)::int AS n FROM pg_trigger WHERE tgname = 'trg_seed_only_site'`)).toEqual([{ n: 0 }]);
    expect(await owner.query(`SELECT count(*)::int AS n FROM pg_proc WHERE proname = 'ck_seed_only_site'`)).toEqual([{ n: 0 }]);
    await owner.runMigrations({ transaction: 'all' });
  });
});
