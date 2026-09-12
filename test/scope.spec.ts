import { DataSource } from 'typeorm';
import { AuditService } from '../src/audit/audit.service';
import { PlatformAccessLog } from '../src/audit/platform-access-log.entity';
import { RequestScope } from '../src/auth/types/request-scope';
import { EquipmentProjection } from '../src/projection/entities/equipment-projection.entity';
import { ScopedRepository } from '../src/scope/scoped-repository';
import { runTenantSpanning } from '../src/scope/tenant-session';
import { createAppDataSource, createTestDataSource, describeDb } from './db';

/**
 * The two layers of tenant isolation (tasks P1-52 and P1-53).
 *
 * Layer one is the repository wrapper: the tenant is not a parameter, so it cannot
 * be the wrong one. Layer two is Postgres: a query that reached the table without a
 * tenant session returns nothing. Both are tested, and the second is tested by
 * deliberately going around the first — a backstop nobody has tried to walk past is
 * an assumption, not a control.
 */
describeDb('tenant scope', () => {
  /** Runs as ta_app, like the service. Every assertion below is made through it. */
  let ds: DataSource;
  /** Runs as the login user. Migrations only — ta_app cannot create a table. */
  let owner: DataSource;
  let repo: ScopedRepository<EquipmentProjection>;
  let audit: AuditService;

  const acme: RequestScope = {
    tenantId: 'acme', userId: 'u-acme', roles: ['admin'], isPlatformRole: false,
  };
  const globex: RequestScope = {
    tenantId: 'globex', userId: 'u-globex', roles: ['admin'], isPlatformRole: false,
  };
  const support: RequestScope = {
    tenantId: 'things-alive', userId: 'u-support', roles: ['platform-support'],
    isPlatformRole: true,
  };

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    ds = await createAppDataSource();
    audit = new AuditService(ds.getRepository(PlatformAccessLog));
    repo = new ScopedRepository<EquipmentProjection>(
      ds, EquipmentProjection, { equipmentColumn: 'externalId' }, audit,
    );
  });

  afterAll(async () => { await ds?.destroy(); await owner?.destroy(); });

  beforeEach(async () => {
    // Fixtures run as the owner: ta_app has no DELETE on the tables it writes, and
    // no privilege at all to clear the access log — which is the property the audit
    // tests depend on.
    await runTenantSpanning(owner, 'test fixture', async (m) => {
      await m.query(`DELETE FROM equipment_projection`);
      await m.query(`DELETE FROM platform_access_log`);
      await m.getRepository(EquipmentProjection).insert([
        row('acme', 'PUMP-1'), row('acme', 'PUMP-2'), row('globex', 'FAN-1'),
      ]);
    });
  });

  const row = (tenantId: string, externalId: string) => ({
    sourceSystem: 'test', externalId, tenantId, payload: {},
    sourceUpdatedAt: null, syncedAt: new Date(), checksum: `c-${externalId}`,
    status: 'live' as const, name: externalId, classId: null,
    plantExternalId: null, category: null,
  });

  it('returns only the caller tenant rows', async () => {
    const rows = await repo.find(acme);
    expect(rows.map((r) => r.externalId).sort()).toEqual(['PUMP-1', 'PUMP-2']);
    expect(await repo.count(globex)).toBe(1);
  });

  it('ignores a tenant a caller tries to smuggle into the filter', async () => {
    // TypeScript removes tenantId from the where type, so this cannot be written by
    // accident. The cast is the test: even forced through, the scope wins.
    const rows = await repo.find(acme, { where: { tenantId: 'globex' } as any });
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.tenantId === 'acme')).toBe(true);
  });

  it('stamps the scope tenant on a write, whatever the body says', async () => {
    const saved = await repo.save(acme, { ...row('globex', 'MIXER-9') } as any);
    expect(saved.tenantId).toBe('acme');
    expect(await repo.count(globex)).toBe(1);
  });

  it('confines an update to the caller tenant', async () => {
    const affected = await repo.update(acme, { externalId: 'FAN-1' } as any, { name: 'renamed' });
    expect(affected).toBe(0);
    const [fan] = await repo.find(globex, { where: { externalId: 'FAN-1' } as any });
    expect(fan.name).toBe('FAN-1');
  });

  it('treats an empty entitlement as nothing, not as everything', async () => {
    // The difference that matters: a user assigned no equipment must see none of it.
    // Reading `[]` as "no filter" is how that user ends up seeing the whole fleet.
    const none = await repo.find({ ...acme, equipmentIds: [] });
    expect(none).toHaveLength(0);

    const some = await repo.find({ ...acme, equipmentIds: ['PUMP-2'] });
    expect(some.map((r) => r.externalId)).toEqual(['PUMP-2']);

    const unrestricted = await repo.find({ ...acme, equipmentIds: undefined });
    expect(unrestricted).toHaveLength(2);
  });

  describe('the database backstop', () => {
    it('returns nothing to a query that never set a tenant session', async () => {
      // Deliberately around the wrapper, the way a hand-written query or a future
      // refactor would reach the table. Row-level security, not the application,
      // is what answers here.
      const rows = await ds.getRepository(EquipmentProjection).find();
      expect(rows).toHaveLength(0);
    });

    it('returns nothing to a session set to another tenant', async () => {
      const rows = await ds.transaction(async (m) => {
        await m.query(`SELECT set_config('ta.tenant_id', 'globex', true)`);
        return m.query(`SELECT * FROM equipment_projection WHERE tenant_id = 'acme'`);
      });
      expect(rows).toHaveLength(0);
    });

    it('refuses a write that claims a tenant the session is not', async () => {
      // WITH CHECK, not just USING: reading is not the only way to cross a boundary.
      await expect(
        ds.transaction(async (m) => {
          await m.query(`SELECT set_config('ta.tenant_id', 'acme', true)`);
          return m.query(
            `INSERT INTO equipment_projection
               (source_system, external_id, tenant_id, checksum)
             VALUES ('test', 'SNEAK-1', 'globex', 'c')`,
          );
        }),
      ).rejects.toThrow(/row-level security/i);
    });
  });

  describe('cross-tenant reads', () => {
    it('refuses a tenant role outright', async () => {
      await expect(repo.acrossTenants(acme, 'curiosity')).rejects.toThrow(/platform role/i);
      expect(await owner.getRepository(PlatformAccessLog).count()).toBe(0);
    });

    it('refuses a platform role that gives no reason', async () => {
      await expect(repo.acrossTenants(support, '   ')).rejects.toThrow(/reason/i);
      expect(await ds.getRepository(PlatformAccessLog).count()).toBe(0);
    });

    it('records the access before returning the rows', async () => {
      const rows = await repo.acrossTenants(support, 'ticket TA-4471: duplicate readings');
      expect(rows).toHaveLength(3);

      const [entry] = await ds.getRepository(PlatformAccessLog).find();
      expect(entry.action).toBe('cross-tenant-read');
      expect(entry.actorUserId).toBe('u-support');
      expect(entry.actorRoles).toEqual(['platform-support']);
      expect(entry.resource).toBe('equipment_projection');
      expect(entry.reason).toBe('ticket TA-4471: duplicate readings');
    });

    it('records the tenants when the read names them', async () => {
      const rows = await repo.acrossTenants(support, 'ticket TA-4471', { tenantIds: ['globex'] });
      expect(rows.map((r) => r.tenantId)).toEqual(['globex']);

      const [entry] = await ds.getRepository(PlatformAccessLog).find();
      expect(entry.tenantIds).toEqual(['globex']);
    });
  });
});
