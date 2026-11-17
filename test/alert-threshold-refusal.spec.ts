import { BadRequestException, INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AlertService } from '../src/alert/services/alert.service';
import { RequestScope } from '../src/auth/types/request-scope';
import { createApp } from '../src/main';
import { createTestDataSource, describeDb } from './db';

/**
 * Test report MAJ-4a: "Create Alert: Min 100 > Max 10, negatives, and 'abc'/'xyz' all leave
 * Create enabled." The 30 Oct fix checked the bounds in the form and in `validateParams`,
 * whose spec calls that function directly. This drives the service the API calls — create
 * and edit — with the forbidden bounds, and expects the refusal and no row written.
 */
describeDb('the alert service refuses bounds that cannot both hold (MAJ-4a)', () => {
  let app: INestApplication;
  let owner: DataSource;
  let alerts: AlertService;
  const acme: RequestScope = { tenantId: 'acme', userId: 'u-acme', roles: ['ceo-manager'], isPlatformRole: false };
  const rule = (params: Record<string, unknown>, slug = 'coolant-band') => ({
    slug, name: 'Coolant band', trigger: 'signal-threshold', params: { signal: 'coolant_temp', ...params },
    appliesTo: 'account', severity: 'high',
  }) as Parameters<AlertService['createRule']>[1];
  const rows = async () => (await owner.query(`SELECT "slug", "params" FROM "alert_rule" WHERE "tenant_id" = 'acme'`));

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    await owner.query(`INSERT INTO "tenant" ("tenant_id", "name") VALUES ('acme', 'Acme')`);
    process.env.AUTH_JWT_SECRET = 'test-secret';
    process.env.CORS_ORIGINS = 'http://localhost:3000';
    process.env.AUTH_JWT_ISSUER = '';
    app = await createApp({ database: true });
    await app.init();
    alerts = app.get(AlertService);
  }, 60_000);

  afterAll(async () => { await app?.close(); await owner?.destroy(); });
  beforeEach(async () => { await owner.query(`DELETE FROM "alert_rule"`); });

  it('Min 100 above Max 10: refused at create, and nothing is written', async () => {
    await expect(alerts.createRule(acme, rule({ min: 100, max: 10 }))).rejects.toThrow(BadRequestException);
    expect(await rows()).toEqual([]);
  });

  it('a bound that is not a number ("abc") is refused at create', async () => {
    await expect(alerts.createRule(acme, rule({ min: 'abc', max: 10 }))).rejects.toThrow(BadRequestException);
    expect(await rows()).toEqual([]);
  });

  it('a valid band is accepted; editing it to Min above Max is refused and the stored band is unchanged', async () => {
    const created = await alerts.createRule(acme, rule({ min: 10, max: 100 }));
    await expect(alerts.updateRule(acme, created.id, { params: { signal: 'coolant_temp', min: 100, max: 10 } } as never))
      .rejects.toThrow(BadRequestException);
    expect(await rows()).toEqual([{ slug: 'coolant-band', params: expect.objectContaining({ min: 10, max: 100 }) }]);
  });

  it('a negative bound is allowed on purpose: temperatures go below zero', async () => {
    await expect(alerts.createRule(acme, rule({ min: -20, max: 40 }))).resolves.toMatchObject({ slug: 'coolant-band' });
  });
});
