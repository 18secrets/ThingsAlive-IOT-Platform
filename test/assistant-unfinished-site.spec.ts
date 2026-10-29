import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AssistantTools } from '../src/assistant/assistant-tools';
import { RequestScope } from '../src/auth/types/request-scope';
import { CLIENT_SOURCE_SYSTEM } from '../src/equipment/equipment-profile.entity';
import { createApp } from '../src/main';
import { createTestDataSource, describeDb } from './db';

/**
 * unfinished_machines narrows to one site itself. Asked to "complete the tata
 * manfacturing mapping", the onboarding chat read the whole fleet and picked the site's
 * machines out on its own, and on one run in two listed a vizag machine among them.
 */
describeDb('assistant unfinished_machines: one site, filtered by the tool', () => {
  let app: INestApplication;
  let owner: DataSource;
  let tools: AssistantTools;

  const scope: RequestScope = {
    tenantId: 'acme', userId: 'u-acme', roles: ['setup'], isPlatformRole: false,
    capabilities: ['equipment.write', 'catalog.read'],
  };
  const onboarding = { profile: 'onboarding' as const, proposals: [] };

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    process.env.AUTH_JWT_SECRET = 'test-secret-assistant-unfinished-site';
    process.env.AUTH_JWT_ISSUER = 'things-alive-assistant-unfinished-site-test';
    process.env.AUTH_TENANT_CLAIM = 'client_id';
    process.env.CORS_ORIGINS = 'http://localhost:3000';
    app = await createApp({ database: true });
    await app.init();
    tools = app.get(AssistantTools);

    const [tata] = await owner.query(
      `INSERT INTO plant (tenant_id, code, name, status) VALUES ('acme', 'TATA-MFG', 'Tata-manfacturing', 'active') RETURNING id`,
    );
    const [vizag] = await owner.query(
      `INSERT INTO plant (tenant_id, code, name, status) VALUES ('acme', 'VZG', 'vizag', 'active') RETURNING id`,
    );
    await owner.query(
      `INSERT INTO equipment_profile (tenant_id, source_system, external_id, name, plant_id)
       VALUES ('acme', $1, 'EX-1', 'Excavator', $2), ('acme', $1, 'CNC-1', 'CNC', $2), ('acme', $1, 'DG-1', 'Generator', $3)`,
      [CLIENT_SOURCE_SYSTEM, tata.id, vizag.id],
    );
  }, 60_000);

  afterAll(async () => { await app?.close(); await owner?.destroy(); });

  const codes = async (args: Record<string, unknown>) =>
    ((await tools.run(scope, 'unfinished_machines', args, onboarding)) as { code: string }[]).map((r) => r.code).sort();

  it('with no site, every unfinished machine', async () => {
    expect(await codes({})).toEqual(['CNC-1', 'DG-1', 'EX-1']);
  });

  it('a site named the way the person wrote it ("tata manfacturing") gives that site\'s machines only', async () => {
    expect(await codes({ site: 'tata manfacturing' })).toEqual(['CNC-1', 'EX-1']);
  });

  it('a site by its code works too', async () => {
    expect(await codes({ site: 'VZG' })).toEqual(['DG-1']);
  });

  it('a site that matches none says so and names the sites, rather than an empty list that reads as done', async () => {
    const out = await tools.run(scope, 'unfinished_machines', { site: 'Chennai' }, onboarding);
    expect(out).toEqual({ error: 'No site matches "Chennai". The sites are: Tata-manfacturing, vizag.' });
  });

  it('a site the person cannot see is the same as one that does not exist', async () => {
    const tataOnly: RequestScope = { ...scope, plantIds: [] };
    const out = await tools.run(tataOnly, 'unfinished_machines', { site: 'vizag' }, onboarding);
    expect(out).toMatchObject({ error: expect.stringContaining('No site matches "vizag"') });
  });
});
