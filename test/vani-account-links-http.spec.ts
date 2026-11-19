import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { createApp } from '../src/main';
import { mintPlatformToken } from '../src/platform/platform-token';
import { createTestDataSource, describeDb } from './db';

const SECRET = 'test-secret-for-signing';
const ISSUER = 'things-alive-platform-test';
const SRC = 'ta-2.0';

/**
 * Staff linking a tenant to its Vani account and its machines to Vani machine ids
 * (`src/vani/vani-links.controller.ts`).
 *
 * Over HTTP, through the real guard, validation pipe and tenant session, because a
 * link that reaches the wrong tenant or the wrong role is the failure that matters and
 * neither shows below the controller. Each refusal is attempted, not inferred from a
 * constraint existing. Both PUTs are documented idempotent, so each is fired twice at
 * once and must land once.
 */
describeDb('vani account links over HTTP', () => {
  let owner: DataSource;
  let app: INestApplication;

  const tokenFor = (role: 'master-admin' | 'platform-support') => mintPlatformToken(
    { role, subject: `${role}@things-alive.io` }, { secret: SECRET, issuer: ISSUER },
  ).token;
  const admin = tokenFor('master-admin');
  const http = () => request(app.getHttpServer());
  const as = (r: request.Test, token = admin) => r.set('Authorization', `Bearer ${token}`);
  const base = '/api/v1/platform/vani/accounts';

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });

    process.env.AUTH_JWT_SECRET = SECRET;
    process.env.AUTH_JWT_ISSUER = ISSUER;
    process.env.CORS_ORIGINS = 'http://localhost:3000';
    app = await createApp({ database: true });
    await app.init();

    for (const t of ['usa-test', 'globex']) {
      await owner.query(`INSERT INTO tenant (tenant_id, name) VALUES ($1, $1)`, [t]);
      for (const ext of ['DG-01', 'DG-02']) {
        await owner.query(
          `INSERT INTO equipment_profile (tenant_id, source_system, external_id, name, origin, status, tier, readiness)
             VALUES ($1, $2, $3, $3, 'client', 'active', 'basic', '{}'::jsonb)`,
          [t, SRC, ext],
        );
      }
    }
  }, 60_000);

  afterAll(async () => { await app?.close(); await owner?.destroy(); });

  beforeEach(async () => {
    await owner.query(`DELETE FROM vani_account_link`);
  });

  const linkUsa = () => as(http().put(`${base}/usa-test`)).send({
    vaniAccountId: 'usa-test-01', customerPhone: '+12012031340',
    callbackUrl: 'https://api.example.test/api/v1/vani/outcome-callback',
  });

  describe('who may link', () => {
    it('refuses a caller with no token, and staff who are not master admin', async () => {
      expect((await http().put(`${base}/usa-test`).send({ vaniAccountId: 'usa-test-01' })).status).toBe(401);
      const support = await as(http().put(`${base}/usa-test`), tokenFor('platform-support')).send({ vaniAccountId: 'usa-test-01' });
      expect(support.status).toBe(403);
      const [{ n }] = await owner.query(`SELECT count(*)::int AS n FROM vani_account_link`);
      expect(n).toBe(0);
    });
  });

  describe('the account link', () => {
    it('links a tenant and reads it back', async () => {
      const put = await linkUsa();
      expect(put.status).toBe(200);
      expect(put.body).toMatchObject({ tenantId: 'usa-test', vaniAccountId: 'usa-test-01', enabled: true, machines: [] });

      const got = await as(http().get(`${base}/usa-test`));
      expect(got.status).toBe(200);
      expect(got.body.customerPhone).toBe('+12012031340');
    });

    it('lands once when the same PUT is fired twice at once', async () => {
      const results = await Promise.allSettled([linkUsa(), linkUsa()]);
      for (const r of results) {
        expect(r.status).toBe('fulfilled');
        expect((r as PromiseFulfilledResult<request.Response>).value.status).toBe(200);
      }
      const [{ n }] = await owner.query(`SELECT count(*)::int AS n FROM vani_account_link`);
      expect(n).toBe(1);
    });

    it('clears what a replacing PUT leaves out', async () => {
      await linkUsa();
      const put = await as(http().put(`${base}/usa-test`)).send({ vaniAccountId: 'usa-test-01', enabled: false });
      expect(put.body).toMatchObject({ customerPhone: null, callbackUrl: null, enabled: false });
    });

    it('refuses a second tenant claiming an account another holds, and says so', async () => {
      await linkUsa();
      const claim = await as(http().put(`${base}/globex`)).send({ vaniAccountId: 'usa-test-01' });
      expect(claim.status).toBe(409);
      expect(claim.body.error.message).toMatch(/already linked to another tenant/);
      const rows = await owner.query(`SELECT tenant_id FROM vani_account_link WHERE vani_account_id = 'usa-test-01'`);
      expect(rows).toEqual([{ tenant_id: 'usa-test' }]);
    });

    it('refuses a phone Vani would not accept, a plain-http callback and an unknown tenant', async () => {
      const phone = await as(http().put(`${base}/usa-test`)).send({ vaniAccountId: 'usa-test-01', customerPhone: '201-203-1340' });
      expect(phone.status).toBe(400);
      const cb = await as(http().put(`${base}/usa-test`)).send({ vaniAccountId: 'usa-test-01', callbackUrl: 'http://x.test/cb' });
      expect(cb.status).toBe(400);
      const nobody = await as(http().put(`${base}/no-such-tenant`)).send({ vaniAccountId: 'nobody-01' });
      expect(nobody.status).toBe(404);
      const [{ n }] = await owner.query(`SELECT count(*)::int AS n FROM vani_account_link`);
      expect(n).toBe(0);
    });

    it('forgets the last pushed snapshot when the account changes, and only then', async () => {
      // A snapshot the old account accepted is news to a new one; resending the same
      // account id must not cause a push nobody asked for.
      await linkUsa();
      await owner.query(`UPDATE vani_account_link SET snapshot_hash = 'h1', snapshot_refused_hash = 'r1'`);
      await linkUsa();
      expect((await owner.query(`SELECT snapshot_hash FROM vani_account_link`))[0].snapshot_hash).toBe('h1');

      await as(http().put(`${base}/usa-test`)).send({ vaniAccountId: 'usa-test-02' });
      const [row] = await owner.query(`SELECT snapshot_hash, snapshot_refused_hash FROM vani_account_link`);
      expect(row).toEqual({ snapshot_hash: null, snapshot_refused_hash: null });
    });

    it('unlinks with its machines, and says when there was nothing to unlink', async () => {
      await linkUsa();
      await as(http().put(`${base}/usa-test/machines/${SRC}/DG-01`)).send({ machineId: 'dg-01', spokenName: 'Diesel Generator DG-01' });
      const del = await as(http().delete(`${base}/usa-test`));
      expect(del.status).toBe(200);
      expect(del.body).toEqual({ removed: true, machinesRemoved: 1 });
      expect((await owner.query(`SELECT count(*)::int AS n FROM vani_machine_link`))[0].n).toBe(0);
      expect((await as(http().delete(`${base}/usa-test`))).status).toBe(404);
      expect((await as(http().get(`${base}/usa-test`))).status).toBe(404);
    });
  });

  describe('machine links', () => {
    const linkDg01 = () => as(http().put(`${base}/usa-test/machines/${SRC}/DG-01`))
      .send({ machineId: 'dg-01', spokenName: 'Diesel Generator DG-01' });

    it('refuses a machine before its account is linked', async () => {
      const res = await linkDg01();
      expect(res.status).toBe(404);
      expect(res.body.error.message).toMatch(/Link the account first/);
    });

    it('links a machine, lands once when fired twice at once, and shows on the account', async () => {
      await linkUsa();
      const results = await Promise.allSettled([linkDg01(), linkDg01()]);
      for (const r of results) {
        expect(r.status).toBe('fulfilled');
        expect((r as PromiseFulfilledResult<request.Response>).value.status).toBe(200);
      }
      expect((await owner.query(`SELECT count(*)::int AS n FROM vani_machine_link`))[0].n).toBe(1);
      const got = await as(http().get(`${base}/usa-test`));
      expect(got.body.machines).toEqual([
        { sourceSystem: SRC, externalId: 'DG-01', machineId: 'dg-01', spokenName: 'Diesel Generator DG-01' },
      ]);
    });

    it('refuses one Vani machine id on two of our machines', async () => {
      await linkUsa();
      await linkDg01();
      const res = await as(http().put(`${base}/usa-test/machines/${SRC}/DG-02`))
        .send({ machineId: 'dg-01', spokenName: 'Diesel Generator DG-02' });
      expect(res.status).toBe(409);
      expect(res.body.error.message).toMatch(/already linked to another machine/);
    });

    it('refuses a machine the tenant does not have, including another tenant\'s', async () => {
      await linkUsa();
      const missing = await as(http().put(`${base}/usa-test/machines/${SRC}/DG-99`))
        .send({ machineId: 'dg-99', spokenName: 'Diesel Generator DG-99' });
      expect(missing.status).toBe(404);
      // globex has a DG-01 of its own; linking it under usa-test's path must not reach it.
      await as(http().put(`${base}/usa-test/machines/${SRC}/DG-01`)).send({ machineId: 'dg-01', spokenName: 'Diesel Generator DG-01' });
      const rows = await owner.query(`SELECT tenant_id FROM vani_machine_link`);
      expect(rows).toEqual([{ tenant_id: 'usa-test' }]);
    });

    it('refuses a blank spoken name, and unlinks one machine', async () => {
      await linkUsa();
      const blank = await as(http().put(`${base}/usa-test/machines/${SRC}/DG-01`)).send({ machineId: 'dg-01', spokenName: '   ' });
      expect(blank.status).toBe(400);
      await linkDg01();
      expect((await as(http().delete(`${base}/usa-test/machines/${SRC}/DG-01`))).status).toBe(200);
      expect((await as(http().delete(`${base}/usa-test/machines/${SRC}/DG-01`))).status).toBe(404);
    });
  });
});
