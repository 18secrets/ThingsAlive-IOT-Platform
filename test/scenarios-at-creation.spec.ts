import { DataSource } from 'typeorm';
import { ActivationService } from '../src/activation/services/activation.service';
import { RequestScope } from '../src/auth/types/request-scope';
import { ClientCatalogEntitlement } from '../src/catalog/entities/client-catalog-entitlement.entity';
import { EquipmentClassProfile } from '../src/catalog/entities/equipment-class-profile.entity';
import { ScenarioDefinition } from '../src/catalog/entities/scenario-definition.entity';
import { SignalAlias } from '../src/catalog/entities/signal-alias.entity';
import { CatalogService } from '../src/catalog/services/catalog.service';
import { RecommendationService } from '../src/catalog/services/recommendation.service';
import { ClientEquipmentClass } from '../src/client-catalog/entities/client-equipment-class.entity';
import { ClientScenario } from '../src/client-catalog/entities/client-scenario.entity';
import { CLIENT_SOURCE_SYSTEM } from '../src/equipment/equipment-profile.entity';
import { EquipmentService } from '../src/equipment/services/equipment.service';
import { runTenantSpanning } from '../src/scope/tenant-session';
import { createAppDataSource, createTestDataSource, describeDb } from './db';

const NOW = new Date('2026-11-09T00:00:00.000Z');

/**
 * A machine given a class adopts the class's scenarios (test report OB-1b). A new
 * machine used to say "No scenarios adopted", and onboarding sat at "no active scenario"
 * until somebody activated each one by hand.
 */
describeDb('scenarios adopted when a machine gets its class', () => {
  let owner: DataSource;
  let ds: DataSource;
  let activation: ActivationService;
  let equipment: EquipmentService;

  const acme: RequestScope = { tenantId: 'acme', userId: 'u-admin', roles: ['admin'], isPlatformRole: false };
  const staff: RequestScope = { tenantId: '', userId: 'u-staff', roles: ['master-admin'], isPlatformRole: true };

  const states = (code: string) => owner.query(
    `SELECT client_scenario_slug AS slug, state, jsonb_array_length(blockers_at_activation) AS blockers
       FROM equipment_scenario WHERE external_id = $1 ORDER BY 1`, [code]);

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    ds = await createAppDataSource();
    const catalog = new CatalogService(
      ds.getRepository(EquipmentClassProfile), ds.getRepository(ScenarioDefinition),
      ds.getRepository(SignalAlias), ds.getRepository(ClientCatalogEntitlement),
    );
    activation = new ActivationService(ds, new RecommendationService(ds, catalog));
    equipment = new EquipmentService(ds, activation);
  }, 30_000);

  afterAll(async () => { await ds?.destroy(); await owner?.destroy(); });

  beforeEach(async () => {
    for (const t of ['domain_event', 'scenario_activation_event', 'equipment_scenario', 'equipment_placement_event',
      'equipment_profile', 'client_scenario', 'client_equipment_class']) {
      await owner.query(`DELETE FROM "${t}"`);
    }
    await runTenantSpanning(owner, 'fixture', async (m) => {
      for (const slug of ['pump', 'motor']) {
        await m.getRepository(ClientEquipmentClass).save({
          tenantId: 'acme', slug, name: slug, description: null, category: 'pump',
          expectedSignals: [{ signal: 'motor_current', unit: 'A', required: true }],
          failureModes: [], defaultThresholds: {}, templateSlug: slug, templateVersion: 1, templateChecksum: 'c',
          copiedAt: NOW, status: 'active', updatedBy: 'u-master',
        });
      }
      await m.getRepository(ClientScenario).save([
        scenario('pump-bearing-drag', 'pump'),
        scenario('pump-dry-run', 'pump'),
        { ...scenario('pump-switched-off', 'pump'), enabled: false },
        scenario('motor-overload', 'motor'),
      ]);
    });
  });

  const scenario = (slug: string, cls: string) => ({
    tenantId: 'acme', slug, clientEquipmentClassSlug: cls, name: slug, description: null,
    severity: 'high' as any, tier: 1 as any, requiredSignals: ['motor_current'], minimumHistoryDays: 0,
    parameters: [] as any, enabled: true, templateSlug: slug, templateVersion: 1, templateChecksum: 'c',
    copiedAt: NOW, status: 'active' as const, updatedBy: 'u-master',
  });

  it('a machine created with a class has its scenarios active, with what still blocks them recorded, not hidden', async () => {
    await equipment.create(acme, { code: 'PUMP-1', name: 'Pump 1', equipmentClassSlug: 'pump' });
    const rows = await states('PUMP-1');
    expect(rows.map((r: { slug: string; state: string }) => [r.slug, r.state])).toEqual([
      ['pump-bearing-drag', 'active'], ['pump-dry-run', 'active'],
    ]);
    // No logger is bound yet: activation says so on the row (G04), it does not pretend.
    expect(rows.every((r: { blockers: number }) => r.blockers > 0)).toBe(true);
    const [{ n }] = await owner.query(`SELECT count(*)::int AS n FROM scenario_activation_event WHERE reason = 'Adopted with the equipment class'`);
    expect(n).toBe(2);
  });

  it('a scenario the account switched off for the class is not adopted', async () => {
    await equipment.create(acme, { code: 'PUMP-1', name: 'Pump 1', equipmentClassSlug: 'pump' });
    expect((await states('PUMP-1')).map((r: { slug: string }) => r.slug)).not.toContain('pump-switched-off');
  });

  it('a machine created without a class adopts nothing until it is given one', async () => {
    await equipment.create(acme, { code: 'PUMP-2', name: 'Pump 2' });
    expect(await states('PUMP-2')).toEqual([]);
    await equipment.update(acme, { sourceSystem: CLIENT_SOURCE_SYSTEM, externalId: 'PUMP-2' }, { equipmentClassSlug: 'motor' });
    expect((await states('PUMP-2')).map((r: { slug: string; state: string }) => [r.slug, r.state])).toEqual([['motor-overload', 'active']]);
  });

  it('a decision somebody made stays made: a deactivated scenario is not switched back on by a class change', async () => {
    const ref = { sourceSystem: CLIENT_SOURCE_SYSTEM, externalId: 'PUMP-3' };
    await equipment.create(acme, { code: 'PUMP-3', name: 'Pump 3', equipmentClassSlug: 'pump' });
    await activation.apply(acme, 'deactivate', { ...ref, clientScenarioSlug: 'pump-dry-run' }, { reason: 'No level sensor on this site' });
    await equipment.update(acme, ref, { equipmentClassSlug: 'motor' });
    await equipment.update(acme, ref, { equipmentClassSlug: 'pump' });
    const dryRun = (await states('PUMP-3')).find((r: { slug: string }) => r.slug === 'pump-dry-run');
    expect(dryRun.state).toBe('deactivated');
  });

  it('staff creating a machine for an account adopt its scenarios in that account', async () => {
    await equipment.create(staff, { code: 'PUMP-4', name: 'Pump 4', equipmentClassSlug: 'pump' }, 'acme');
    expect((await states('PUMP-4')).length).toBe(2);
  });

  it('without the activation service (a register on its own), creating a machine is exactly as it was', async () => {
    await new EquipmentService(ds).create(acme, { code: 'PUMP-5', name: 'Pump 5', equipmentClassSlug: 'pump' });
    expect(await states('PUMP-5')).toEqual([]);
  });
});
