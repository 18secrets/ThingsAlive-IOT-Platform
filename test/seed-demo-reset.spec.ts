import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { RequestScope } from '../src/auth/types/request-scope';
import {
  countDemoRows, DEMO_CLASS, DEMO_SOURCE, DEMO_TENANT, resetDemo, seedDemo,
} from '../src/database/seeds/seed-demo';
import { KpiEvaluatorService } from '../src/kpi/services/kpi-evaluator.service';
import { createApp } from '../src/main';
import { ParameterService } from '../src/parameters/services/parameter.service';
import { createTestDataSource, describeDb, undoMigrationNamed } from './db';

const MIGRATION = 'SeedDemoParameterReset1759200000000';
/** A Tuesday, 12:30 in Pune: mid-shift. */
const NOW = new Date('2026-10-06T07:00:00.000Z');
/** The Sunday before, 12:30 in Pune: the 24 h before it holds no running hour. */
const SUNDAY = new Date('2026-10-04T07:00:00.000Z');
const ENABLED = { SEED_DEMO_ENABLED: 'true' } as NodeJS.ProcessEnv;
const demo: RequestScope = {
  tenantId: DEMO_TENANT, userId: 'u-demo', roles: ['ceo-manager'], isPlatformRole: false,
  capabilities: ['parameters.read', 'parameters.write'],
};
const ex01 = { sourceSystem: DEMO_SOURCE, externalId: 'EX-01' };

/**
 * Two defects found re-testing phase 1 on Development (2026-10-07):
 *
 * D-006 — EX-01 "Healthy" read below its oil-pressure target, because the KPI averaged
 * parked hours into a target that only means anything for a running engine.
 *
 * D-005 — once a tester had set one parameter in the demo, `seed:demo:reset` could not
 * remove the tenant: `tenant_parameter` refused every DELETE. Asserted by attempting
 * the reset, and by attempting the deletes the exemption must still refuse.
 */
describeDb('seed:demo re-test fixes (D-005, D-006)', () => {
  let owner: DataSource;
  let app: INestApplication;
  let evaluator: KpiEvaluatorService;
  let parameters: ParameterService;

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    process.env.AUTH_JWT_SECRET = 'test-secret-seed-demo-reset';
    process.env.AUTH_JWT_ISSUER = 'things-alive-seed-demo-reset-test';
    process.env.AUTH_TENANT_CLAIM = 'client_id';
    process.env.CORS_ORIGINS = 'http://localhost:3000';
    app = await createApp({ database: true });
    await app.init();
    evaluator = app.get(KpiEvaluatorService);
    parameters = app.get(ParameterService);
    await seedDemo(owner, { now: NOW, env: ENABLED });
  }, 180_000);

  afterAll(async () => { await app?.close(); await owner?.destroy(); });

  /** A session that is the seeder's, the way resetDemo opens one. */
  const asSeeder = <T>(fn: (q: (sql: string, params?: unknown[]) => Promise<T>) => Promise<T>) =>
    owner.transaction(async (m) => {
      await m.query(`SELECT set_config('ta.seed_demo', 'on', true)`);
      return fn((sql, params) => m.query(sql, params));
    });

  // ============================================================== D-006
  it('EX-01 healthy: oil pressure is the running mean and inside its target, as coolant and hydraulic are', async () => {
    const at = async (key: string) => evaluator.evaluateOne(demo, ex01, key, NOW);
    const oil = await at('avg_oil_pressure');
    expect(oil).toMatchObject({ readiness: 'ready', unit: 'kPa' });
    expect(oil.value as number).toBeGreaterThanOrEqual(250);
    // The running model is 390 ± 15 kPa: a running mean, not a day mean.
    expect(oil.value as number).toBeGreaterThan(350);
    expect((await at('avg_coolant_temp')).value as number).toBeLessThanOrEqual(100);
    expect((await at('avg_hydraulic_temp')).value as number).toBeLessThanOrEqual(75);
  });

  it('a day with no running hour has no oil-pressure KPI: undefined_result and null, never 0', async () => {
    const oil = await evaluator.evaluateOne(demo, ex01, 'avg_oil_pressure', SUNDAY);
    expect(oil).toMatchObject({ readiness: 'not_available', reason: 'undefined_result', value: null });
  });

  // ============================================================== D-005: what stays refused
  it('outside the seeder\'s session, a demo parameter still cannot be deleted', async () => {
    await parameters.set(demo, { scope: 'equipment_class', scopeRef: DEMO_CLASS, name: 'fuel_price', value: 100 });
    await expect(owner.query(`DELETE FROM tenant_parameter WHERE tenant_id = $1`, [DEMO_TENANT]))
      .rejects.toThrow(/append-only/);
  });

  it('inside the seeder\'s session, a demo parameter still cannot be changed — the exemption is DELETE only', async () => {
    await expect(asSeeder((q) => q(`UPDATE tenant_parameter SET value = '1'::jsonb WHERE tenant_id = $1`, [DEMO_TENANT])))
      .rejects.toThrow(/append-only/);
  });

  it('inside the seeder\'s session, a real tenant\'s parameter still cannot be deleted', async () => {
    await owner.query(
      `INSERT INTO tenant (tenant_id, name, status, plan, region, provisioned_by) VALUES ('acme', 'Acme', 'active', 'standard', 'IN', 'u-master')`,
    );
    await owner.query(
      `INSERT INTO tenant_parameter (tenant_id, scope, name, value, effective_from, created_by)
         VALUES ('acme', 'client', 'stale_after_seconds', '900'::jsonb, now(), 'u')`,
    );
    await expect(asSeeder((q) => q(`DELETE FROM tenant_parameter WHERE tenant_id = 'acme'`)))
      .rejects.toThrow(/append-only/);
    expect(await owner.query(`SELECT count(*)::int AS n FROM tenant_parameter WHERE tenant_id = 'acme'`)).toEqual([{ n: 1 }]);
  });

  // ============================================================== D-005: the reset
  it('reset removes a demo tenant that has parameters, and only its parameters', async () => {
    const removed = await resetDemo(owner, ENABLED);
    expect(removed.tenant_parameter).toBe(1);
    expect(await countDemoRows(owner)).toEqual({});
    expect(await owner.query(`SELECT count(*)::int AS n FROM tenant_parameter WHERE tenant_id = 'acme'`)).toEqual([{ n: 1 }]);
    const again = await seedDemo(owner, { now: NOW, env: ENABLED });
    expect(again.created).toBe(true);
  }, 180_000);

  // ============================================================== down path
  it(`down path (${MIGRATION}): the trigger refuses every DELETE again, the seeder's included`, async () => {
    await undoMigrationNamed(owner, MIGRATION);
    await parameters.set(demo, { scope: 'equipment_class', scopeRef: DEMO_CLASS, name: 'fuel_price', value: 120 });
    await expect(asSeeder((q) => q(`DELETE FROM tenant_parameter WHERE tenant_id = $1`, [DEMO_TENANT])))
      .rejects.toThrow(/append-only/);
    const [{ secdef }] = await owner.query(`SELECT prosecdef AS secdef FROM pg_proc WHERE proname = 'tenant_parameter_append_only'`);
    expect(secdef).toBe(false);
    await owner.runMigrations({ transaction: 'all' });
  });
});
