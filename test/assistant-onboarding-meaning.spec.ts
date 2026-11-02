import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AssistantTools } from '../src/assistant/assistant-tools';
import { RequestScope } from '../src/auth/types/request-scope';
import { EquipmentClassProfile } from '../src/catalog/entities/equipment-class-profile.entity';
import { CLIENT_SOURCE_SYSTEM, EquipmentProfile } from '../src/equipment/equipment-profile.entity';
import { DeviceInventory } from '../src/inventory/entities/device-inventory.entity';
import { createApp } from '../src/main';
import { createTestDataSource, describeDb } from './db';

/**
 * The setup assistant says what a stuck step means and who can act on it (tester bug
 * TC_131). Its machine type listed no required signals, so mapping was blocked on the
 * library — and the assistant, given only the code `no_requirements`, sent the person
 * to the mapping screen, where there was nothing to map.
 */
describeDb('onboarding assistant: each step says what it is waiting on', () => {
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
    process.env.AUTH_JWT_SECRET = 'test-secret-assistant-meaning';
    process.env.AUTH_JWT_ISSUER = 'things-alive-assistant-meaning-test';
    process.env.AUTH_TENANT_CLAIM = 'client_id';
    process.env.CORS_ORIGINS = 'http://localhost:3000';
    app = await createApp({ database: true });
    await app.init();
    tools = app.get(AssistantTools);

    // A machine type with no required signals, the state TC_131 hit on staging.
    await owner.getRepository(EquipmentClassProfile).save(owner.getRepository(EquipmentClassProfile).create({
      slug: 'test-bus', version: 1, name: 'Test Bus', status: 'published', expectedSignals: [],
    }));
    await owner.getRepository(EquipmentProfile).save(owner.getRepository(EquipmentProfile).create({
      tenantId: 'acme', sourceSystem: CLIENT_SOURCE_SYSTEM, externalId: 'BB-1',
      equipmentClassSlug: 'test-bus', classVersion: 1, name: 'Bus 1',
    }));
    await owner.getRepository(DeviceInventory).save(owner.getRepository(DeviceInventory).create({
      imei: 'IMEI-BUS-1', tenantId: 'acme', state: 'assigned', equipmentExternalId: 'BB-1',
      claimedAt: new Date('2026-10-20T00:00:00.000Z'),
    }));
  }, 60_000);

  afterAll(async () => { await app?.close(); await owner?.destroy(); });

  type Step = { step: string; state: string; reason: string | null; meaning: string | null };
  const steps = async (): Promise<Record<string, Step>> => {
    const result = await tools.run(scope, 'machine_onboarding', { sourceSystem: CLIENT_SOURCE_SYSTEM, code: 'BB-1' }, onboarding);
    return Object.fromEntries((result as { steps: Step[] }).steps.map((s) => [s.step, s]));
  };

  it('TC_131: a machine type with no required signals says the customer cannot fix it, and who can', async () => {
    const { mapping } = await steps();

    expect(mapping).toMatchObject({ state: 'blocked', reason: 'no_requirements' });
    expect(mapping.meaning).toMatch(/nothing to map/);
    expect(mapping.meaning).toMatch(/cannot fix this: Things Alive has to add required signals/);
  });

  it('a step waiting on an earlier one points back to it', async () => {
    const { validation } = await steps();
    expect(validation).toMatchObject({ state: 'blocked', reason: 'blocked_by_step' });
    expect(validation.meaning).toMatch(/earlier step/);
  });

  it('a done step carries no meaning', async () => {
    const { equipment, device } = await steps();
    expect(equipment).toMatchObject({ state: 'done', meaning: null });
    expect(device).toMatchObject({ state: 'done', meaning: null });
  });

  it('the machine is found by its code alone, without the source system', async () => {
    const result = await tools.run(scope, 'machine_onboarding', { code: 'BB-1' }, onboarding) as { machine: { externalId: string } };
    expect(result.machine).toMatchObject({ externalId: 'BB-1', sourceSystem: CLIENT_SOURCE_SYSTEM });
  });

  it('every step that is not done says what it means', async () => {
    const notDone = Object.values(await steps()).filter((s) => s.state !== 'done');
    expect(notDone.length).toBeGreaterThan(0);
    for (const s of notDone) expect({ step: s.step, meaning: s.meaning }).toEqual({ step: s.step, meaning: expect.any(String) });
  });
});
