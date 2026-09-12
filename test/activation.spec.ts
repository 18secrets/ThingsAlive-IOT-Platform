import { BadRequestException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { EquipmentScenario } from '../src/activation/entities/equipment-scenario.entity';
import { ScenarioActivationEvent } from '../src/activation/entities/scenario-activation-event.entity';
import { ActivationHistoryService } from '../src/activation/services/activation-history.service';
import { ActivationService } from '../src/activation/services/activation.service';
import { ACTIVATION_TRANSITIONS, transition } from '../src/activation/services/state-machine';
import { RequestScope } from '../src/auth/types/request-scope';
import { ClientCatalogEntitlement } from '../src/catalog/entities/client-catalog-entitlement.entity';
import { EquipmentClassProfile } from '../src/catalog/entities/equipment-class-profile.entity';
import { ScenarioDefinition } from '../src/catalog/entities/scenario-definition.entity';
import { SignalAlias } from '../src/catalog/entities/signal-alias.entity';
import { CatalogService } from '../src/catalog/services/catalog.service';
import { RecommendationService } from '../src/catalog/services/recommendation.service';
import { ClientEquipmentClass } from '../src/client-catalog/entities/client-equipment-class.entity';
import { ClientScenario } from '../src/client-catalog/entities/client-scenario.entity';
import { EquipmentProfile } from '../src/equipment/equipment-profile.entity';
import { DomainEvent } from '../src/events/domain-event.entity';
import { DeviceProjection } from '../src/projection/entities/device-projection.entity';
import { SensorMapProjection } from '../src/projection/entities/sensor-map-projection.entity';
import { runTenantSpanning } from '../src/scope/tenant-session';
import { createAppDataSource, createTestDataSource, describeDb } from './db';

/**
 * Turning a scenario on for one asset (task P1-09).
 *
 * The transition table is tested without a database, because it is a pure decision
 * and deserves to be readable as one. Everything else needs Postgres: the three
 * writes per transition are only meaningful if they are one transaction.
 */
describe('activation state machine', () => {
  it('refuses every transition the table does not allow, and says what would work', () => {
    // Walked exhaustively rather than sampled. A state machine with one untested
    // edge is a state machine with one edge somebody will find in production.
    const states = ['proposed', 'active', 'paused', 'deactivated'] as const;
    const actions = Object.keys(ACTIVATION_TRANSITIONS) as (keyof typeof ACTIVATION_TRANSITIONS)[];

    for (const action of actions) {
      for (const from of states) {
        const allowed = ACTIVATION_TRANSITIONS[action].from.includes(from);
        const attempt = () => transition(action, from, 'a reason');
        if (allowed) {
          expect(attempt().to).toBe(ACTIVATION_TRANSITIONS[action].to);
        } else {
          expect(attempt).toThrow(new RegExp(`Cannot ${action} a scenario that is "${from}"`));
        }
      }
    }
  });

  it('lets a deactivated scenario be turned back on', () => {
    // Changing your mind is ordinary, and a state machine that treats "off for good"
    // as terminal forces people to delete and recreate, losing the history.
    expect(transition('activate', 'deactivated', null).to).toBe('active');
  });

  it('demands a reason for the transitions somebody will later ask about', () => {
    expect(() => transition('pause', 'active', '  ')).toThrow(/reason is required/);
    expect(() => transition('deactivate', 'active', undefined)).toThrow(/reason is required/);
    // Turning something on needs no excuse.
    expect(() => transition('activate', 'proposed', undefined)).not.toThrow();
  });

  it('explains itself when there is nothing to transition from', () => {
    expect(() => transition('pause', null, 'x'))
      .toThrow(/never been activated on this asset/);
  });
});

describeDb('activation', () => {
  let ds: DataSource;
  let owner: DataSource;
  let activation: ActivationService;
  let history: ActivationHistoryService;

  const SOURCE = 'iot-platform-1';
  const ASSET = 'DG-1';
  const NOW = new Date('2026-09-12T00:00:00.000Z');

  const acme: RequestScope = {
    tenantId: 'acme', userId: 'u-admin', roles: ['admin'], isPlatformRole: false,
  };
  const globex: RequestScope = {
    tenantId: 'globex', userId: 'u-globex', roles: ['admin'], isPlatformRole: false,
  };

  const target = { sourceSystem: SOURCE, externalId: ASSET, clientScenarioSlug: 'dg-coolant-overheat' };

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    ds = await createAppDataSource();

    const catalog = new CatalogService(
      ds.getRepository(EquipmentClassProfile),
      ds.getRepository(ScenarioDefinition),
      ds.getRepository(SignalAlias),
      ds.getRepository(ClientCatalogEntitlement),
    );
    activation = new ActivationService(ds, new RecommendationService(ds, catalog));
    history = new ActivationHistoryService(ds);
  }, 30_000);

  afterAll(async () => { await ds?.destroy(); await owner?.destroy(); });

  beforeEach(async () => {
    for (const t of ['domain_event', 'scenario_activation_event', 'equipment_scenario',
      'sensor_map_projection', 'device_projection', 'equipment_profile',
      'client_scenario', 'client_equipment_class']) {
      await owner.query(`DELETE FROM "${t}"`);
    }

    await runTenantSpanning(owner, 'test fixture', async (m) => {
      await m.getRepository(ClientEquipmentClass).save({
        tenantId: 'acme', slug: 'diesel-generator', name: 'Diesel generator',
        description: null, category: 'power',
        expectedSignals: [{ signal: 'coolant_temp', unit: 'degC', required: true }],
        failureModes: [], defaultThresholds: {}, templateSlug: 'diesel-generator',
        templateVersion: 1, templateChecksum: 'c', copiedAt: NOW,
        status: 'active', updatedBy: 'u-master',
      });
      await m.getRepository(ClientScenario).save([
        scenario('dg-coolant-overheat', ['coolant_temp']),
        scenario('dg-needs-sensor', ['oil_pressure']),
      ]);
      // An asset of the right class, reporting the signal the first scenario needs.
      await m.getRepository(EquipmentProfile).save({
        tenantId: 'acme', sourceSystem: SOURCE, externalId: ASSET,
        equipmentClassSlug: 'diesel-generator', classVersion: 1, tier: 'full',
        commissionedAt: null, serviceIntervalHours: null, readiness: {}, updatedBy: 'u-admin',
      });
      const base = {
        sourceSystem: SOURCE, tenantId: 'acme', payload: {}, sourceUpdatedAt: NOW,
        syncedAt: NOW, status: 'live' as const,
      };
      await m.getRepository(DeviceProjection).save({
        ...base, externalId: 'dev-1', checksum: 'c1', imei: 'imei-1',
        equipmentExternalId: ASSET, name: null,
      });
      await m.getRepository(SensorMapProjection).save({
        ...base, externalId: 'imei-1-coolant_temp', checksum: 'c2', imei: 'imei-1',
        signal: 'coolant_temp', sensorName: 'coolant_temp', unit: null,
      });
    });
  });

  const scenario = (slug: string, requiredSignals: string[]) => ({
    tenantId: 'acme', slug, clientEquipmentClassSlug: 'diesel-generator',
    name: slug, description: null, severity: 'high' as any, tier: 1 as any,
    requiredSignals, minimumHistoryDays: 0,
    parameters: [{ key: 'warnC', label: 'Warning', type: 'number', default: 95 }] as any,
    enabled: true, templateSlug: slug, templateVersion: 1, templateChecksum: 'c',
    copiedAt: NOW, status: 'active' as const, updatedBy: 'u-master',
  });

  it('activates, and writes state, history and an outbox event together', async () => {
    const view = await activation.apply(acme, 'activate', target, {}, NOW);

    expect(view.state).toBe('active');
    expect(view.activatedBy).toBe('u-admin');
    expect(view.blockersAtActivation).toEqual([]);

    const [event] = await history.forAsset(acme, SOURCE, ASSET);
    expect([event.fromState, event.toState]).toEqual([null, 'active']);
    expect(event.actorUserId).toBe('u-admin');

    const [outbox] = await owner.getRepository(DomainEvent).find();
    expect(outbox.eventType).toBe('scenario.activated.v1');
    expect(outbox.deliveryState).toBe('pending');
    expect(outbox.subject).toBe(`${SOURCE}/${ASSET}/dg-coolant-overheat`);
    expect(outbox.occurredAt).toEqual(NOW);
  });

  it('writes nothing at all when the transition is refused', async () => {
    // The three writes are one transaction. A refused transition that left an outbox
    // event behind would tell a downstream system about something that never
    // happened, which is worse than losing an event.
    await expect(activation.apply(acme, 'pause', target, { reason: 'x' }, NOW))
      .rejects.toThrow(/never been activated/);

    expect(await owner.getRepository(EquipmentScenario).count()).toBe(0);
    expect(await owner.getRepository(ScenarioActivationEvent).count()).toBe(0);
    expect(await owner.getRepository(DomainEvent).count()).toBe(0);
  });

  it('keeps one row per asset and scenario across a full lifecycle', async () => {
    await activation.apply(acme, 'activate', target, {}, NOW);
    await activation.apply(acme, 'pause', target, { reason: 'plant shutdown' }, NOW);
    await activation.apply(acme, 'resume', target, {}, NOW);
    const final = await activation.apply(acme, 'deactivate', target, { reason: 'set sold' }, NOW);

    expect(final.state).toBe('deactivated');
    expect(final.stateReason).toBe('set sold');
    expect(await owner.getRepository(EquipmentScenario).count()).toBe(1);

    // The history is the part that survives. Newest first.
    const events = await history.forAsset(acme, SOURCE, ASSET);
    expect(events.map((e) => e.action)).toEqual(['deactivate', 'resume', 'pause', 'activate']);
    expect(events[0].reason).toBe('set sold');
  });

  describe('the gate', () => {
    it('refuses a scenario that could never fire on this asset', async () => {
      // The asset is a generator; this scenario belongs to a class it is not.
      await runTenantSpanning(owner, 'test fixture', (m) =>
        m.getRepository(EquipmentProfile).update(
          { tenantId: 'acme', externalId: ASSET }, { equipmentClassSlug: 'air-compressor' },
        ),
      );
      await expect(activation.apply(acme, 'activate', target, {}, NOW))
        .rejects.toBeInstanceOf(BadRequestException);
      expect(await owner.getRepository(DomainEvent).count()).toBe(0);
    });

    it('allows one that cannot fire yet, and records why', async () => {
      // Turning something on so it starts the day the sensor arrives is reasonable.
      // What would be wrong is letting it look healthy while scoring nothing.
      const view = await activation.apply(
        acme, 'activate', { ...target, clientScenarioSlug: 'dg-needs-sensor' }, {}, NOW,
      );
      expect(view.state).toBe('active');
      expect(view.blockersAtActivation).toEqual([
        { code: 'missing-signals', signals: ['oil_pressure'] },
      ]);

      // And the blocker stays in the history even after the sensor is fitted.
      const [event] = await history.forAsset(acme, SOURCE, ASSET);
      expect(event.blockers).toHaveLength(1);
    });

    it('refuses a scenario this account does not have', async () => {
      await expect(activation.apply(
        acme, 'activate', { ...target, clientScenarioSlug: 'not-ours' }, {}, NOW,
      )).rejects.toThrow(/No scenario "not-ours"/);
    });
  });

  describe('parameters', () => {
    it('reports where each value came from', async () => {
      // "Why is this one 88 when the rest of the fleet is 95" should be answerable
      // from one record rather than by opening two side by side.
      const view = await activation.apply(acme, 'activate', target, {
        parameterOverrides: { warnC: 88 },
      }, NOW);

      expect(view.resolvedParameters).toEqual([
        { key: 'warnC', value: 88, source: 'asset-override' },
      ]);
    });

    it('falls back to the scenario default when nothing is overridden', async () => {
      const view = await activation.apply(acme, 'activate', target, {}, NOW);
      expect(view.resolvedParameters).toEqual([
        { key: 'warnC', value: 95, source: 'scenario-default' },
      ]);
    });

    it('surfaces an override for a parameter the scenario no longer declares', async () => {
      // Dead configuration. Silently dropping it is how a customer believes a
      // threshold has been in force for months after it stopped being.
      await activation.apply(acme, 'activate', target, {
        parameterOverrides: { warnC: 88, retiredKnob: 3 },
      }, NOW);

      const [view] = await activation.list(acme, { externalId: ASSET });
      expect(view.resolvedParameters).toContainEqual(
        { key: 'retiredKnob', value: 3, source: 'asset-override' },
      );
    });

    it('keeps overrides through a pause and resume', async () => {
      await activation.apply(acme, 'activate', target, { parameterOverrides: { warnC: 88 } }, NOW);
      await activation.apply(acme, 'pause', target, { reason: 'maintenance' }, NOW);
      const resumed = await activation.apply(acme, 'resume', target, {}, NOW);

      expect(resumed.resolvedParameters).toEqual([
        { key: 'warnC', value: 88, source: 'asset-override' },
      ]);
    });
  });

  it('cannot be read or written across accounts', async () => {
    await activation.apply(acme, 'activate', target, {}, NOW);

    expect(await activation.list(globex)).toEqual([]);
    expect(await history.forAsset(globex, SOURCE, ASSET)).toEqual([]);
    // And the backstop: no tenant session, no rows.
    expect(await ds.getRepository(EquipmentScenario).find()).toEqual([]);
  });
});
