import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { RequestScope } from '../src/auth/types/request-scope';
import { RoleService } from '../src/identity/services/role.service';
import { createApp } from '../src/main';
import { WorkOrderService } from '../src/work/services/work-order.service';
import { createTestDataSource, describeDb } from './db';

const NOW = new Date('2026-11-13T10:00:00Z');

/**
 * Testing sheet TC_148: "Created a work order and assigned to client user … in user
 * dashboard work order is empty." The job was on a machine the operator was not given,
 * so their list — rightly — left it out; the fault was that assigning it was allowed.
 *
 * The check existed and its unit specs passed, because they handed the service a scope
 * resolver by hand. The running app never did: WorkModule did not import the module that
 * provides one, the dependency is optional, and the check returned early. So this spec
 * takes the service from the app as it is actually wired, not built for the occasion.
 */
describeDb('a job goes only to somebody who can open its machine (TC_148)', () => {
  let app: INestApplication;
  let owner: DataSource;
  let work: WorkOrderService;
  let ceo: RequestScope;
  let operatorId: string;

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
    work = app.get(WorkOrderService);

    await app.get(RoleService).provisionDefaults('acme', 'u-master', NOW);
    await owner.query(`INSERT INTO "equipment_profile" (tenant_id, source_system, external_id)
      VALUES ('acme', 'ss', 'M-MINE'), ('acme', 'ss', 'M-OTHER')`);
    const seedUser = async (email: string, roleSlug: string) => (await owner.query(
      `INSERT INTO app_user (tenant_id, email, full_name, role_slug, status) VALUES ('acme', $1, $1, $2, 'active') RETURNING id`,
      [email, roleSlug]))[0].id as string;
    const ceoId = await seedUser('ceo@acme.test', 'ceo-manager');
    const caps = (await owner.query(
      `SELECT capabilities FROM tenant_role WHERE tenant_id = 'acme' AND slug = 'ceo-manager'`))[0].capabilities as string[];
    ceo = { tenantId: 'acme', userId: ceoId, roles: ['ceo-manager'], isPlatformRole: false, capabilities: caps };
    // An operator sees the machines they are given, and here that is one.
    operatorId = await seedUser('op@acme.test', 'operator');
    await owner.query(`INSERT INTO user_equipment_access (tenant_id, user_id, source_system, equipment_external_id, granted_by, granted_at)
      VALUES ('acme', $1, 'ss', 'M-MINE', $2, now())`, [operatorId, ceoId]);
  }, 60_000);

  afterAll(async () => { await app?.close(); await owner?.destroy(); });
  beforeEach(async () => { await owner.query(`TRUNCATE "work_order_event", "work_order" RESTART IDENTITY CASCADE`); });

  const jobs = async () => (await owner.query(`SELECT external_id, assigned_to_user_id FROM work_order ORDER BY external_id`));

  it('raising a job for an operator on a machine they were not given is refused, and nothing is written', async () => {
    await expect(work.raise(ceo, { sourceSystem: 'ss', externalId: 'M-OTHER', title: 'Check the radiator', assignedToUserId: operatorId }, NOW))
      .rejects.toThrow(/not assigned to this machine/);
    expect(await jobs()).toEqual([]);
  });

  it('handing an existing job to them is refused, and it stays with nobody', async () => {
    const job = await work.raise(ceo, { sourceSystem: 'ss', externalId: 'M-OTHER', title: 'Check the radiator' }, NOW);
    await expect(work.assign(ceo, job.id, operatorId)).rejects.toThrow(/not assigned to this machine/);
    expect(await jobs()).toEqual([{ external_id: 'M-OTHER', assigned_to_user_id: null }]);
  });

  it('a job on their own machine is theirs, and is on their list', async () => {
    await work.raise(ceo, { sourceSystem: 'ss', externalId: 'M-MINE', title: 'Grease the boom', assignedToUserId: operatorId }, NOW);
    const operator: RequestScope = {
      tenantId: 'acme', userId: operatorId, roles: ['operator'], isPlatformRole: false, equipmentIds: ['M-MINE'],
    };
    expect((await work.list(operator, { status: ['created', 'in-progress'] })).map((o) => o.title)).toEqual(['Grease the boom']);
  });
});
