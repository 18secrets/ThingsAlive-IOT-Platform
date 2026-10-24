import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AssistantProposalService } from '../src/assistant/assistant-proposal.service';
import { RequestScope } from '../src/auth/types/request-scope';
import { createApp } from '../src/main';
import { createTestDataSource, describeDb } from './db';

/**
 * The setup assistant's new-machine proposal carries every field the Add Equipment
 * form does (tester bug TC_128). With only code, name, site, maker and model it
 * created machines with no serial, tier, dates or interval — and the person had no
 * way to give them through the chat. What is checked here is the proposal itself:
 * what the person approves, what confirming writes, and what is refused before then.
 */
describeDb('onboarding assistant: the new-machine proposal takes every field', () => {
  let app: INestApplication;
  let owner: DataSource;
  let proposals: AssistantProposalService;

  const acme: RequestScope = { tenantId: 'acme', userId: 'u-acme', roles: ['admin'], isPlatformRole: false };

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    process.env.AUTH_JWT_SECRET = 'test-secret-assistant-fields';
    process.env.AUTH_JWT_ISSUER = 'things-alive-assistant-fields-test';
    process.env.AUTH_TENANT_CLAIM = 'client_id';
    process.env.CORS_ORIGINS = 'http://localhost:3000';
    app = await createApp({ database: true });
    await app.init();
    proposals = app.get(AssistantProposalService);
  }, 60_000);

  afterAll(async () => { await app?.close(); await owner?.destroy(); });

  beforeEach(async () => {
    await owner.query(
      `TRUNCATE TABLE "assistant_proposal", "equipment_placement_event", "equipment_profile", "plant" CASCADE`,
    );
    await owner.query(`INSERT INTO plant (tenant_id, code, name, status) VALUES ('acme', 'NORTH', 'North yard', 'active')`);
  });

  const all = {
    code: 'GEN-7', name: 'Generator 7', siteCode: 'NORTH', manufacturer: 'Cummins', modelNumber: 'C320',
    serialNumber: 'SN-0042', description: 'Standby set', tier: 'advanced', commissionedAt: '2025-03-15',
    serviceIntervalHours: 250,
  };

  it('the sentence the person approves names every field that will be written', async () => {
    const p = await proposals.propose(acme, 'create_equipment', all);

    expect(p.summary).toBe(
      'Add the machine "Generator 7" (code GEN-7), Cummins C320, serial SN-0042, advanced tier, '
      + 'commissioned 2025-03-15, service every 250 h at site NORTH.',
    );
  });

  it('confirming writes the optional fields through the ordinary service', async () => {
    const p = await proposals.propose(acme, 'create_equipment', all);
    expect(await proposals.confirm(acme, p.id)).toMatchObject({ status: 'applied' });

    expect(await owner.query(
      `SELECT serial_number, description, tier, to_char(commissioned_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS commissioned,
              service_interval_hours, manufacturer, model_number
         FROM equipment_profile WHERE external_id = 'GEN-7'`,
    )).toEqual([{
      serial_number: 'SN-0042', description: 'Standby set', tier: 'advanced', commissioned: '2025-03-15',
      service_interval_hours: 250, manufacturer: 'Cummins', model_number: 'C320',
    }]);
  });

  it('leaving the optional fields out still proposes, and the machine takes the defaults', async () => {
    const p = await proposals.propose(acme, 'create_equipment', { code: 'GEN-8', name: 'Generator 8' });
    expect(await proposals.confirm(acme, p.id)).toMatchObject({ status: 'applied' });

    expect(await owner.query(
      `SELECT serial_number, tier, commissioned_at, service_interval_hours FROM equipment_profile WHERE external_id = 'GEN-8'`,
    )).toEqual([{ serial_number: null, tier: 'basic', commissioned_at: null, service_interval_hours: null }]);
  });

  it.each([
    ['a tier that does not exist', { tier: 'gold' }, /tier must be one of/],
    ['a date not written YYYY-MM-DD', { commissionedAt: '15/03/2025' }, /YYYY-MM-DD/],
    ['an interval that is not a whole number of hours', { serviceIntervalHours: 12.5 }, /whole number/],
    ['an interval of zero', { serviceIntervalHours: 0 }, /whole number/],
  ])('refuses %s before anything is stored', async (_label, bad, message) => {
    await expect(proposals.propose(acme, 'create_equipment', { code: 'GEN-9', name: 'Generator 9', ...bad }))
      .rejects.toThrow(message);
    expect((await owner.query(`SELECT count(*)::int AS n FROM assistant_proposal`))[0].n).toBe(0);
  });
});
