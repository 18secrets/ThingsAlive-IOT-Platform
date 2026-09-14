import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { RequestScope } from '../src/auth/types/request-scope';
import { AlertService } from '../src/alert/services/alert.service';
import { evaluateRule, validateParams } from '../src/alert/services/alert-rules';
import { Severity } from '../src/common/severity';
import { CLIENT_SOURCE_SYSTEM } from '../src/equipment/equipment-profile.entity';
import { EquipmentService } from '../src/equipment/services/equipment.service';
import { PlantService } from '../src/equipment/services/plant.service';
import { createAppDataSource, createTestDataSource, describeDb } from './db';

const reading = (signal: string, value: number, at = '2026-09-14T07:00:00.000Z') =>
  ({ signal, value, unit: 'degC', sourceTimestamp: at });

const prediction = (severity: Severity, riskScore = 80, confidence = 'full') => ({
  clientScenarioSlug: 'dg-coolant-overheat', severity, riskScore,
  predictionId: '11111111-1111-1111-1111-111111111111', confidence,
});

describe('what an alert rule watches', () => {
  describe('a prediction reaching a severity', () => {
    const params = { atLeast: Severity.High };

    it('fires at the threshold and above, not below', () => {
      expect(evaluateRule({ trigger: 'prediction-severity', params, readings: [], predictions: [prediction(Severity.High)] })).toBeTruthy();
      expect(evaluateRule({ trigger: 'prediction-severity', params, readings: [], predictions: [prediction(Severity.Critical)] })).toBeTruthy();
      expect(evaluateRule({ trigger: 'prediction-severity', params, readings: [], predictions: [prediction(Severity.Medium)] })).toBeNull();
    });

    it('ignores a scorer that could not score', () => {
      // Confidence 'none' has not said the machine is fine; it has said nothing.
      // Firing on it would train people to ignore the alert.
      expect(evaluateRule({
        trigger: 'prediction-severity', params, readings: [],
        predictions: [prediction(Severity.Critical, 90, 'none')],
      })).toBeNull();
    });

    it('reports the worst scenario when several qualify', () => {
      const firing = evaluateRule({
        trigger: 'prediction-severity', params, readings: [],
        predictions: [
          { ...prediction(Severity.High, 60), clientScenarioSlug: 'mild' },
          { ...prediction(Severity.Critical, 95), clientScenarioSlug: 'bad' },
        ],
      });
      expect(firing!.evidence).toMatchObject({ clientScenarioSlug: 'bad', riskScore: 95 });
    });

    it('can watch one scenario rather than all of them', () => {
      const params2 = { atLeast: Severity.High, clientScenarioSlug: 'something-else' };
      expect(evaluateRule({
        trigger: 'prediction-severity', params: params2, readings: [],
        predictions: [prediction(Severity.Critical)],
      })).toBeNull();
    });

    it('refuses a rule that would fire on every shift of every machine', () => {
      expect(validateParams('prediction-severity', { atLeast: Severity.None }))
        .toMatch(/every shift of every machine/);
    });
  });

  describe('a signal crossing a threshold', () => {
    it('carries the worst breach and how many there were', () => {
      const firing = evaluateRule({
        trigger: 'signal-threshold',
        params: { signal: 'coolant_temp', max: 95 },
        readings: [reading('coolant_temp', 96), reading('coolant_temp', 104), reading('coolant_temp', 80)],
        predictions: [],
      });
      // An alert that says a machine is in trouble and cannot say why is worse than
      // no alert: somebody walks out, finds nothing, and trusts the next one less.
      expect(firing!.evidence).toMatchObject({ worstValue: 104, breaches: 2, readingsInWindow: 3 });
    });

    it('watches a floor as well as a ceiling', () => {
      const firing = evaluateRule({
        trigger: 'signal-threshold',
        params: { signal: 'oil_pressure', min: 2 },
        readings: [{ ...reading('oil_pressure', 1.1), unit: 'bar' }],
        predictions: [],
      });
      expect(firing!.evidence).toMatchObject({ direction: 'below', worstValue: 1.1 });
    });

    it('says nothing about a signal the shift did not report', () => {
      expect(evaluateRule({
        trigger: 'signal-threshold', params: { signal: 'vibration', max: 5 },
        readings: [reading('coolant_temp', 200)], predictions: [],
      })).toBeNull();
    });

    it('refuses bounds that can never both be true', () => {
      expect(validateParams('signal-threshold', { signal: 'x', min: 10, max: 5 }))
        .toMatch(/can never fire/);
      expect(validateParams('signal-threshold', { signal: 'x' })).toMatch(/maximum, a minimum/);
    });
  });

  describe('a machine that said nothing', () => {
    it('fires on an empty shift and stays quiet on a full one', () => {
      // Silence is the one condition a predictive platform cannot predict its way out
      // of, and it looks exactly like everything being fine.
      expect(evaluateRule({ trigger: 'no-telemetry', params: {}, readings: [], predictions: [] })).toBeTruthy();
      expect(evaluateRule({
        trigger: 'no-telemetry', params: {}, readings: [reading('coolant_temp', 80)], predictions: [],
      })).toBeNull();
    });
  });
});

  describe('where a chain says the fault entered', () => {
    /**
     * The trigger that justifies the intelligence layer (task P4-01).
     *
     * A threshold on coolant temperature fires on a machine working hard, because a
     * hard-working machine really is hot. This fires only when a stage is off the curve
     * its own drivers predict — which a hard-working machine is not — and because the
     * chain names the stage, the alert arrives pointing at a component.
     */
    const chain = (over: Record<string, unknown> = {}) => ({
      slug: 'dg-thermal',
      evaluated: true,
      origin: {
        signal: 'engine_oil_temperature',
        label: 'Oil temperature under load',
        severity: 'warning' as const,
        residual: 12.5,
        expected: 60,
        actual: 72.5,
        exceedance: 1.56,
      },
      explainedBy: [{ signal: 'engine_coolant_temperature', because: 'engine_oil_temperature' }],
      ...over,
    });

    const fire = (params: Record<string, unknown>, chains: any[]) => evaluateRule({
      trigger: 'chain-origin', params: params as any, readings: [], predictions: [], chains,
    });

    it('fires on the stage the chain blames, and says what is off its curve', () => {
      const firing = fire({ atLeast: 'warning' }, [chain()]);
      // Not "72.5 degrees", which is true of a healthy machine under load. The number
      // that means something is the gap from what the drivers predict.
      expect(firing!.summary).toMatch(/Oil temperature under load is \+12\.5/);
      expect(firing!.summary).toMatch(/expected 60/);
      expect(firing!.evidence).toMatchObject({
        chainSlug: 'dg-thermal', stage: 'engine_oil_temperature', severity: 'warning',
      });
    });

    it('says the downstream stage is consistent rather than a second fault', () => {
      // The sentence that stops a second engineer being dispatched for the coolant.
      expect(fire({ atLeast: 'warning' }, [chain()])!.summary)
        .toMatch(/engine_coolant_temperature is consistent with that and not a separate fault/);
    });

    it('does not fire on a machine that is merely working hard', () => {
      // The whole point. A chain with no origin means every stage is where its own
      // drivers put it, however hot the raw numbers are.
      expect(fire({ atLeast: 'warning' }, [chain({ origin: undefined })])).toBeNull();
    });

    it('does not fire on a chain nobody could evaluate', () => {
      // Unevaluated has not said the machine is fine; it has said nothing, and firing
      // on it would be an alert about our own plumbing.
      expect(fire({ atLeast: 'warning' }, [{ slug: 'dg-thermal', evaluated: false }]))
        .toBeNull();
    });

    it('does not fire when no chain ran at all', () => {
      expect(evaluateRule({
        trigger: 'chain-origin', params: { atLeast: 'warning' } as any,
        readings: [], predictions: [],
      })).toBeNull();
    });

    it('respects the severity floor', () => {
      expect(fire({ atLeast: 'critical' }, [chain()])).toBeNull();
      expect(fire({ atLeast: 'critical' }, [chain({
        origin: { ...chain().origin, severity: 'critical' },
      })])).toBeTruthy();
    });

    it('can watch one chain, and one stage within it', () => {
      // Routing: a rule on the oil stage goes to the engine fitter, one on the coolant
      // stage to whoever looks after radiators. Without it every chain fault lands in
      // one queue and a human re-does the routing from the summary.
      expect(fire({ atLeast: 'warning', chainSlug: 'other' }, [chain()])).toBeNull();
      expect(fire(
        { atLeast: 'warning', chainSlug: 'dg-thermal', stageSignal: 'engine_coolant_temperature' },
        [chain()],
      )).toBeNull();
      expect(fire(
        { atLeast: 'warning', chainSlug: 'dg-thermal', stageSignal: 'engine_oil_temperature' },
        [chain()],
      )).toBeTruthy();
    });

    it('reports the worst origin when several chains fault at once', () => {
      const mild = chain({ slug: 'mild' });
      const bad = chain({
        slug: 'bad',
        origin: { ...chain().origin, signal: 'engine_oil_pressure', label: undefined, severity: 'critical' },
      });
      expect(fire({ atLeast: 'warning' }, [mild, bad])!.evidence)
        .toMatchObject({ chainSlug: 'bad' });
    });

    it('refuses a rule that names a stage without its chain', () => {
      // Ambiguous the moment a second chain for the class has that stage too, and the
      // rule would quietly widen rather than fail.
      expect(validateParams('chain-origin', { atLeast: 'warning', stageSignal: 'x' } as any))
        .toMatch(/needs the chain it belongs to/);
      expect(validateParams('chain-origin', { atLeast: 'nope' } as any))
        .toMatch(/"warning" or "critical"/);
      expect(validateParams('chain-origin', { atLeast: 'warning' } as any)).toBeNull();
    });
  });

describeDb('alerts', () => {
  let ds: DataSource;
  let owner: DataSource;
  let alerts: AlertService;
  let plants: PlantService;
  let equipment: EquipmentService;

  const NOW = new Date('2026-09-14T09:00:00.000Z');
  const boss: RequestScope = {
    tenantId: 'acme', userId: 'u-boss', roles: ['ceo-manager'], isPlatformRole: false,
    capabilities: ['alert.author', 'prediction.read', 'action.work', 'equipment.write'],
  };
  const other: RequestScope = {
    tenantId: 'globex', userId: 'u-other', roles: ['ceo-manager'], isPlatformRole: false,
    capabilities: ['alert.author', 'prediction.read', 'action.work', 'equipment.write'],
  };

  const ASSET = 'DG-1';
  let north: string;

  const window = (overrides: Record<string, unknown> = {}) => ({
    tenantId: 'acme', sourceSystem: CLIENT_SOURCE_SYSTEM, externalId: ASSET,
    shiftLocalDate: '2026-09-14',
    windowStart: new Date('2026-09-14T00:30:00.000Z'),
    windowEnd: new Date('2026-09-14T08:30:00.000Z'),
    readings: [reading('coolant_temp', 104)],
    predictions: [prediction(Severity.Critical, 92)],
    ...overrides,
  });

  const rule = (overrides: Record<string, unknown> = {}) => ({
    slug: 'coolant-critical', name: 'Coolant critical',
    trigger: 'prediction-severity' as const, params: { atLeast: Severity.High },
    ...overrides,
  });

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    ds = await createAppDataSource();
    alerts = new AlertService(ds);
    plants = new PlantService(ds);
    equipment = new EquipmentService(ds);
  }, 30_000);

  afterAll(async () => { await ds?.destroy(); await owner?.destroy(); });

  beforeEach(async () => {
    for (const t of ['alert_event', 'alert_rule', 'equipment_placement_event',
      'equipment_profile', 'plant']) {
      await owner.query(`DELETE FROM "${t}"`);
    }
    north = (await plants.create(boss, { code: 'NORTH', name: 'Northern yard' })).id;
    await equipment.create(boss, { code: ASSET, name: 'Generator 1', plantId: north });
  });

  describe('writing rules', () => {
    it('refuses a rule pointing at a machine that is not here', async () => {
      // A rule configured against nothing looks configured and never fires, which is
      // the most expensive way for an alert to be wrong.
      await expect(alerts.createRule(boss, rule({
        appliesTo: 'equipment', sourceSystem: CLIENT_SOURCE_SYSTEM, externalId: 'NOPE',
      }))).rejects.toThrow(NotFoundException);
    });

    it('refuses a scoped rule with nothing to scope to', async () => {
      await expect(alerts.createRule(boss, rule({ appliesTo: 'plant' })))
        .rejects.toThrow(/scoped to a site needs the site/);
    });

    it('keeps slugs unique inside the account and nowhere else', async () => {
      await alerts.createRule(boss, rule());
      await expect(alerts.createRule(boss, rule())).rejects.toThrow(ConflictException);
      // Two customers both calling a rule "coolant-critical" is ordinary.
      await expect(alerts.createRule(other, rule())).resolves.toBeTruthy();
    });

    it('cannot see or touch another account\'s rules', async () => {
      const mine = await alerts.createRule(boss, rule());
      expect(await alerts.listRules(other)).toEqual([]);
      await expect(alerts.updateRule(other, mine.id, { name: 'Theirs' }))
        .rejects.toThrow(NotFoundException);
    });
  });

  describe('firing', () => {
    it('raises an alert with the evidence that caused it', async () => {
      await alerts.createRule(boss, rule());
      const [fired] = await alerts.evaluateWindow(window());

      expect(fired).toMatchObject({
        ruleName: 'Coolant critical', state: 'open', externalId: ASSET,
        shiftLocalDate: '2026-09-14',
      });
      expect(fired.evidence).toMatchObject({ severity: 'critical', riskScore: 92 });
      expect(fired.predictionId).toBe('11111111-1111-1111-1111-111111111111');
    });

    it('does not raise the same alert again while it is standing', async () => {
      await alerts.createRule(boss, rule());
      expect(await alerts.evaluateWindow(window())).toHaveLength(1);
      // The same fault on every shift for a week is one thing wrong with one machine.
      // Seven identical rows is a list nobody reads.
      expect(await alerts.evaluateWindow(window())).toHaveLength(0);
    });

    it('still suppresses once somebody has acknowledged but not fixed it', async () => {
      await alerts.createRule(boss, rule());
      const [fired] = await alerts.evaluateWindow(window());
      await alerts.acknowledge(boss, fired.id);
      // Seeing it is not fixing it, and re-raising would punish the person who looked.
      expect(await alerts.evaluateWindow(window())).toHaveLength(0);
    });

    it('raises again once it has been resolved and comes back', async () => {
      await alerts.createRule(boss, rule());
      const [first] = await alerts.evaluateWindow(window());
      await alerts.resolve(boss, first.id, 'replaced the thermostat');

      // The fault returning after somebody signed it off is a new alert. Suppressing
      // that would turn de-duplication into a mute.
      expect(await alerts.evaluateWindow(window())).toHaveLength(1);
    });

    it('lets the database refuse a second standing alert, not just the service', async () => {
      const created = await alerts.createRule(boss, rule());
      await alerts.evaluateWindow(window());
      await expect(owner.query(
        `INSERT INTO "alert_event"
           ("tenant_id","rule_id","rule_name","source_system","external_id","severity","summary")
         VALUES ('acme',$1,'x',$2,$3,'high','again')`,
        [created.id, CLIENT_SOURCE_SYSTEM, ASSET],
      )).rejects.toThrow(/uq_alert_event_standing/);
    });

    it('does not fire a disabled rule', async () => {
      const created = await alerts.createRule(boss, rule());
      await alerts.setEnabled(boss, created.id, false);
      expect(await alerts.evaluateWindow(window())).toHaveLength(0);
    });

    it('applies a site rule only to machines on that site', async () => {
      const south = (await plants.create(boss, { code: 'SOUTH', name: 'Southern yard' })).id;
      await alerts.createRule(boss, rule({ slug: 'north-only', appliesTo: 'plant', plantId: north }));
      await alerts.createRule(boss, rule({ slug: 'south-only', appliesTo: 'plant', plantId: south }));

      const fired = await alerts.evaluateWindow(window());
      expect(fired.map((f) => f.ruleName)).toHaveLength(1);
      expect(fired[0].evidence).toMatchObject({ severity: 'critical' });
    });

    it('tells somebody when a machine said nothing all shift', async () => {
      await alerts.createRule(boss, rule({
        slug: 'went-quiet', name: 'Machine went quiet', trigger: 'no-telemetry', params: {},
      }));
      const fired = await alerts.evaluateWindow(window({ readings: [], predictions: [] }));
      expect(fired).toHaveLength(1);
      expect(fired[0].summary).toMatch(/no telemetry/);
    });
  });

  describe('clearing', () => {
    it('keeps "I have seen this" apart from "this is dealt with"', async () => {
      await alerts.createRule(boss, rule());
      const [fired] = await alerts.evaluateWindow(window());

      const seen = await alerts.acknowledge(boss, fired.id, NOW);
      expect(seen).toMatchObject({ state: 'acknowledged', acknowledgedBy: 'u-boss' });
      expect(seen.resolvedAt).toBeNull();

      const done = await alerts.resolve(boss, fired.id, 'topped up the coolant', NOW);
      expect(done).toMatchObject({ state: 'resolved', resolutionNote: 'topped up the coolant' });
      // The first acknowledgement survives, so "how long before anybody looked" stays
      // answerable.
      expect(done.acknowledgedAt).toEqual(seen.acknowledgedAt);
    });

    it('refuses to resolve without saying what was found', async () => {
      await alerts.createRule(boss, rule());
      const [fired] = await alerts.evaluateWindow(window());
      await expect(alerts.resolve(boss, fired.id, '  ')).rejects.toThrow(BadRequestException);
    });

    it('fills in the acknowledgement for somebody who went straight to fixing it', async () => {
      await alerts.createRule(boss, rule());
      const [fired] = await alerts.evaluateWindow(window());
      const done = await alerts.resolve(boss, fired.id, 'fixed', NOW);
      expect(done.acknowledgedBy).toBe('u-boss');
    });

    it('will not resolve the same alert twice', async () => {
      await alerts.createRule(boss, rule());
      const [fired] = await alerts.evaluateWindow(window());
      await alerts.resolve(boss, fired.id, 'fixed');
      await expect(alerts.resolve(boss, fired.id, 'again')).rejects.toThrow(/already resolved/);
    });
  });

  describe('who sees what', () => {
    it('shows nothing to somebody assigned to no machines', async () => {
      await alerts.createRule(boss, rule());
      await alerts.evaluateWindow(window());
      // The dangerous bug: an empty allow-list read as "no filter".
      expect(await alerts.listEvents({ ...boss, equipmentIds: [] })).toEqual([]);
      expect(await alerts.listEvents({ ...boss, equipmentIds: [ASSET] })).toHaveLength(1);
    });

    it('keeps one account\'s alerts out of another', async () => {
      await alerts.createRule(boss, rule());
      const [fired] = await alerts.evaluateWindow(window());
      expect(await alerts.listEvents(other)).toEqual([]);
      await expect(alerts.acknowledge(other, fired.id)).rejects.toThrow(NotFoundException);
    });
  });
});
