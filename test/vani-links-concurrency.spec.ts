import { DataSource } from 'typeorm';
import { VaniLinksService } from '../src/vani/vani-links.service';
import { createAppDataSource, createTestDataSource, describeDb } from './db';

/**
 * Identical link writes fired together land once, without a refusal
 * (`src/vani/vani-links.service.ts`, `lockLinks`).
 *
 * Each link table has two unique keys and the upsert's ON CONFLICT names one, so two
 * identical PUTs could collide on the other and the second be refused as a conflict
 * with itself. The two-call test in `vani-account-links-http.spec.ts` caught it about
 * one run in six; ten calls at once, ten rounds over, makes the race the usual case
 * rather than the rare one, so this fails reliably without the lock.
 */
describeDb('vani links: identical writes at once', () => {
  let owner: DataSource;
  let app: DataSource;
  let links: VaniLinksService;
  const SRC = 'ta-2.0';
  const ROUNDS = 10;
  const AT_ONCE = 10;

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    app = await createAppDataSource();
    links = new VaniLinksService(app);
    await owner.query(`INSERT INTO tenant (tenant_id, name) VALUES ('usa-test', 'usa-test')`);
    await owner.query(
      `INSERT INTO equipment_profile (tenant_id, source_system, external_id, name, origin, status, tier, readiness)
         VALUES ('usa-test', $1, 'DG-01', 'DG-01', 'client', 'active', 'basic', '{}'::jsonb)`, [SRC]);
  }, 60_000);

  afterAll(async () => { await app?.destroy(); await owner?.destroy(); });

  const together = <T>(fn: () => Promise<T>) => Promise.allSettled(Array.from({ length: AT_ONCE }, fn));
  const refusals = (results: PromiseSettledResult<unknown>[]) =>
    results.filter((r): r is PromiseRejectedResult => r.status === 'rejected').map((r) => String(r.reason?.message ?? r.reason));

  it('links an account once, however many identical PUTs arrive together', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      await owner.query(`DELETE FROM vani_account_link`);
      const results = await together(() => links.putAccount('usa-test', { vaniAccountId: 'usa-test-01' }));
      expect(refusals(results)).toEqual([]);
      expect((await owner.query(`SELECT count(*)::int AS n FROM vani_account_link`))[0].n).toBe(1);
    }
  });

  it('links a machine once, however many identical PUTs arrive together', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      await owner.query(`DELETE FROM vani_account_link`);
      await links.putAccount('usa-test', { vaniAccountId: 'usa-test-01' });
      const results = await together(() =>
        links.putMachine('usa-test', SRC, 'DG-01', { machineId: 'dg-01', spokenName: 'Diesel Generator DG-01' }));
      expect(refusals(results)).toEqual([]);
      expect((await owner.query(`SELECT count(*)::int AS n FROM vani_machine_link`))[0].n).toBe(1);
    }
  });
});
