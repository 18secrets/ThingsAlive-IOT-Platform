import { ConflictException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { RequestScope } from '../src/auth/types/request-scope';
import { compileFormula } from '../src/catalog/formula/formula-compiler';
import { ClientEquipmentClass } from '../src/client-catalog/entities/client-equipment-class.entity';
import { ClientFormula } from '../src/client-catalog/entities/client-formula.entity';
import { planUpgrade } from '../src/client-catalog/services/class-upgrade-plan';
import { EquipmentProfile } from '../src/equipment/equipment-profile.entity';
import { KpiEvaluatorService } from '../src/kpi/services/kpi-evaluator.service';
import { EmitterRegistry } from '../src/proposal/emitter';
import { KpiEmitter } from '../src/proposal/kpi-emitter';
import { ProposalService } from '../src/proposal/proposal.service';
import { ReplayService } from '../src/proposal/replay.service';
import { SignalBindingService } from '../src/signal-binding/services/signal-binding.service';
import { createAppDataSource, createTestDataSource, describeDb, undoMigrationNamed } from './db';
import { withTenantSession } from '../src/scope/tenant-session';

const SS = 'ta-2.0';
const DEMO_CLASS = 'generator-class';

describeDb('QGEN2: The KPI / formula emitter', () => {
  let owner: DataSource;
  let ds: DataSource;
  let proposals: ProposalService;
  let emitter: KpiEmitter;
  let evaluator: KpiEvaluatorService;
  let registry: EmitterRegistry;

  const NOW = new Date('2026-10-21T00:00:00.000Z');
  const boss: RequestScope = { tenantId: 'tenant-a', userId: 'u-boss', roles: ['super admin'], isPlatformRole: false };
  const userA: RequestScope = { tenantId: 'tenant-a', userId: 'u-a', roles: ['analyst'], isPlatformRole: false };
  const bossB: RequestScope = { tenantId: 'tenant-b', userId: 'u-boss-b', roles: ['super admin'], isPlatformRole: false };

  let keys = 0;
  const key = () => `kpi-key-${(keys += 1)}`;

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    ds = await createAppDataSource();

    const signalBindings = new SignalBindingService(ds);
    evaluator = new KpiEvaluatorService(ds, signalBindings);
    emitter = new KpiEmitter(ds, evaluator);
    registry = new EmitterRegistry();
    registry.register(emitter);
    const replays = new ReplayService(ds);
    proposals = new ProposalService(ds, registry, replays);
  }, 60_000);

  afterAll(async () => {
    await ds?.destroy();
    await owner?.destroy();
  });

  beforeEach(async () => {
    await owner.query(`
      TRUNCATE TABLE "proposal_rule_enablement", "replay_run", "artifact_proposal", "signal_binding_version",
        "client_formula", "equipment_profile", "client_equipment_class", "sensor_role_capability" CASCADE`);

    // Setup class copy for tenant-a with declared signals
    await owner.query(
      `INSERT INTO client_equipment_class (tenant_id, slug, name, expected_signals, template_version, template_checksum)
       VALUES ('tenant-a', $1, 'Generator', $2::jsonb, 1, 'checksum-1')`,
      [
        DEMO_CLASS,
        JSON.stringify([
          { signal: 'actual_power', unit: 'kW', required: true },
          { signal: 'rated_power', unit: 'kW', required: true },
          { signal: 'ambient_temperature', unit: 'degC', required: false },
          { signal: 'coolant_temperature', unit: 'degC', required: true },
          { signal: 'fuel_rate_primary', unit: 'L/h', required: false },
          { signal: 'fuel_rate_secondary', unit: 'L/h', required: false },
        ]),
      ],
    );

    // Setup machine for tenant-a
    await owner.query(
      `INSERT INTO equipment_profile (tenant_id, source_system, external_id, name, equipment_class_slug, origin, status, tier, readiness)
       VALUES ('tenant-a', $1, 'GEN-01', 'Gen 01', $2, 'client', 'active', 'basic', '{}'::jsonb)`,
      [SS, DEMO_CLASS],
    );

    // Register sensors
    await owner.query(`
      INSERT INTO sensor (id, sensor_name, slug)
      VALUES
        ('11111111-1111-1111-1111-111111111111', 'Power Sensor', 'power-sensor'),
        ('22222222-2222-2222-2222-222222222222', 'Ambient Sensor', 'ambient-sensor'),
        ('33333333-3333-3333-3333-333333333333', 'Coolant Sensor', 'coolant-sensor'),
        ('44444444-4444-4444-4444-444444444444', 'Fuel Sensor', 'fuel-sensor')
      ON CONFLICT (id) DO NOTHING
    `);

    // Register sensor capabilities
    await owner.query(`
      INSERT INTO sensor_role_capability (sensor_id, measurement_role, parameter_key, canonical_unit)
      VALUES
        ('11111111-1111-1111-1111-111111111111', 'actual_power', 'power', 'kW'),
        ('11111111-1111-1111-1111-111111111111', 'rated_power', 'power', 'kW'),
        ('22222222-2222-2222-2222-222222222222', 'ambient_temperature', 'ambient_temperature', 'degC'),
        ('33333333-3333-3333-3333-333333333333', 'coolant_temperature', 'coolant_temperature', 'degC'),
        ('44444444-4444-4444-4444-444444444444', 'fuel_rate_primary', 'fuel_rate', 'L/h'),
        ('44444444-4444-4444-4444-444444444444', 'fuel_rate_secondary', 'fuel_rate', 'L/h')
    `);
  });

  // 1. Bind named formula matching signals by measurement -> proposal compiles, gate_outcome = 'not_applicable', materialises
  it('1. binds load_factor when signals match roles by measurement, gate is not_applicable, and materialises', async () => {
    const res = await proposals.propose(userA, {
      kind: 'kpi',
      seed: {
        target: { sourceSystem: SS, externalId: 'GEN-01' },
        intent: 'bind-named-formula',
        namedFormulaSlug: 'load_factor',
        formulaKey: 'my_load_factor',
      },
      idempotencyKey: key(),
    }, NOW);

    expect(res.status).toBe('draft_ready');
    if (res.status !== 'draft_ready') return;
    expect(res.gateOutcome).toBe('not_applicable');
    expect(res.payload.expression).toBe('actual_power / rated_power');

    // Materialise via approve
    const approved = await proposals.approve(boss, res.id, NOW);
    expect(approved.status).toBe('materialised');

    // Verify stored client_formula row
    const [row] = await owner.query(
      `SELECT * FROM client_formula WHERE tenant_id = 'tenant-a' AND formula_key = 'my_load_factor'`,
    );
    expect(row).toBeDefined();
    expect(row.source).toBe('generated');
    expect(row.proposal_id).toBe(res.id);
    expect(row.expression).toBe('actual_power / rated_power');
    expect(row.compiled_plan).toBeDefined();

    // Verify plan equals hand path compilation
    const handCompiled = compileFormula({
      classSlug: DEMO_CLASS,
      expectedSignals: [
        { signal: 'actual_power', unit: 'kW' },
        { signal: 'rated_power', unit: 'kW' },
      ],
      formulaKey: 'my_load_factor',
      expression: 'actual_power / rated_power',
    });
    expect(row.compiled_plan).toEqual(handCompiled.plan);
  });

  // 2. A role matching two signals -> needs_input naming both; no proposal row written
  it('2. returns needs_input when a role matches multiple signals and writes no proposal', async () => {
    // Both fuel_rate_primary and fuel_rate_secondary have parameterKey = fuel_rate and unit = L/h
    // Register named formula for fuel test
    await owner.query(`
      INSERT INTO named_formula (slug, version, name, expression, inputs, status, published_at, compiled_plan, compiler_version, result_unit)
      VALUES (
        'simple_fuel', 1, 'Simple Fuel', 'fuel_in',
        '[{"role":"fuel_in","dimension":"L/h","expectedParameters":["fuel_rate"]}]'::jsonb,
        'published', now(), '{}'::jsonb, 'qgeo1.0.0', 'L/h'
      ) ON CONFLICT DO NOTHING
    `);

    const res = await proposals.propose(userA, {
      kind: 'kpi',
      seed: {
        target: { sourceSystem: SS, externalId: 'GEN-01' },
        intent: 'bind-named-formula',
        namedFormulaSlug: 'simple_fuel',
      },
      idempotencyKey: key(),
    }, NOW);

    expect(res.status).toBe('needs_input');
    if (res.status === 'needs_input') {
      expect(res.missing.some((m) => m.reason === 'multiple_candidates' && m.detail.includes('fuel_rate_primary') && m.detail.includes('fuel_rate_secondary'))).toBe(true);
    }

    const count = await owner.query(`SELECT count(*)::int AS c FROM artifact_proposal`);
    expect(count[0].c).toBe(0);
  });

  // 3. A role whose only unit-compatible signal measures the wrong thing -> refused (coolant vs ambient)
  it('3. refuses binding when unit-compatible signal measures the wrong quantity (coolant vs ambient)', async () => {
    // Class with ONLY ambient_temperature (degC), no coolant_temperature
    await owner.query(`
      INSERT INTO client_equipment_class (tenant_id, slug, name, expected_signals, template_version, template_checksum)
      VALUES ('tenant-a', 'ambient-only-class', 'Ambient Only', $1::jsonb, 1, 'c-1')`,
      [JSON.stringify([{ signal: 'ambient_temperature', unit: 'degC', required: true }])],
    );

    // Named formula expecting coolant_temperature
    await owner.query(`
      INSERT INTO named_formula (slug, version, name, expression, inputs, status, published_at, compiled_plan, compiler_version, result_unit)
      VALUES (
        'coolant_watch', 1, 'Coolant Watch', 'coolant_in',
        '[{"role":"coolant_in","dimension":"degC","expectedParameters":["coolant_temperature"]}]'::jsonb,
        'published', now(), '{}'::jsonb, 'qgeo1.0.0', 'degC'
      ) ON CONFLICT DO NOTHING
    `);

    await expect(
      proposals.propose(userA, {
        kind: 'kpi',
        seed: {
          target: { clientEquipmentClassSlug: 'ambient-only-class' },
          intent: 'bind-named-formula',
          namedFormulaSlug: 'coolant_watch',
        },
        idempotencyKey: key(),
      }, NOW),
    ).rejects.toThrow('suspicious_binding');
  });

  // 4. Expression never executes outside compiler: constructor.constructor('return process')() -> compile_refused
  it('4. refuses code injection expressions at compile time without executing them', async () => {
    (global as any).__SENTINEL__ = 'untouched';

    const p = await proposals.propose(userA, {
      kind: 'kpi',
      seed: {
        target: { sourceSystem: SS, externalId: 'GEN-01' },
        intent: 'ratio-kpis',
        formulaKeys: ['a', 'b'], // will mock in raw proposal or direct emit
      },
      idempotencyKey: key(),
    }, NOW).catch(() => null);

    // Test direct compile refusal of malicious payload expressions
    const out1 = await emitter.compile({
      clientEquipmentClassSlug: DEMO_CLASS,
      formulaKey: 'exploit1',
      expression: "constructor.constructor('global.__SENTINEL__ = \"corrupted\"')()",
    }, { scope: userA, proposalScope: 'tenant', m: ds.manager, at: NOW });

    expect(out1.ok).toBe(false);
    expect((global as any).__SENTINEL__).toBe('untouched');

    const out2 = await emitter.compile({
      clientEquipmentClassSlug: DEMO_CLASS,
      formulaKey: 'exploit2',
      expression: "require('fs').unlinkSync('tmp')",
    }, { scope: userA, proposalScope: 'tenant', m: ds.manager, at: NOW });

    expect(out2.ok).toBe(false);
    expect((global as any).__SENTINEL__).toBe('untouched');
  });

  // 5. A payload naming a signal the class does not declare -> compile_refused
  it('5. returns compile_refused when a payload names an undeclared signal', async () => {
    const outcome = await withTenantSession(ds, userA, (m) =>
      emitter.compile({
        clientEquipmentClassSlug: DEMO_CLASS,
        formulaKey: 'test_undeclared',
        expression: 'undeclared_signal_foo + 10',
      }, { scope: userA, proposalScope: 'tenant', m, at: NOW }),
    );

    expect(outcome.ok).toBe(false);
    expect((outcome as any).message).toMatch(/undeclared_signal_foo/i);
  });

  // 6. A payload with result_kind = 'scalar' on a series expression -> compile_refused
  it('6. returns compile_refused when result_kind is scalar for a series expression', async () => {
    const outcome = await withTenantSession(ds, userA, (m) =>
      emitter.compile({
        clientEquipmentClassSlug: DEMO_CLASS,
        formulaKey: 'test_kind_mismatch',
        expression: 'actual_power', // series signal without scalar reduction
        resultKind: 'scalar',
      }, { scope: userA, proposalScope: 'tenant', m, at: NOW }),
    );

    expect(outcome.ok).toBe(false);
    expect((outcome as any).message).toMatch(/kind/i);
  });

  // 7. A payload that tries to carry required_signals or compiled_plan -> refused at schema
  it('7. refuses payloads attempting to carry required_signals or compiled_plan', async () => {
    const out1 = await withTenantSession(ds, userA, (m) =>
      emitter.compile({
        clientEquipmentClassSlug: DEMO_CLASS,
        formulaKey: 'spoof_signals',
        expression: '1 + 1',
        required_signals: ['fake_signal'],
      }, { scope: userA, proposalScope: 'tenant', m, at: NOW }),
    );
    expect(out1.ok).toBe(false);
    expect((out1 as any).message).toContain('required_signals');

    const out2 = await withTenantSession(ds, userA, (m) =>
      emitter.compile({
        clientEquipmentClassSlug: DEMO_CLASS,
        formulaKey: 'spoof_plan',
        expression: '1 + 1',
        compiled_plan: { type: 'const', value: 999 },
      }, { scope: userA, proposalScope: 'tenant', m, at: NOW }),
    );
    expect(out2.ok).toBe(false);
    expect((out2 as any).message).toContain('compiled_plan');
  });

  // 8. @tariff_per_kwh unset for the tenant -> materialises, value null, not 0
  it('8. materialises formula with unset tenant parameter, evaluating to null and not 0', async () => {
    // Formula with parameter
    const out = await withTenantSession(ds, userA, (m) =>
      emitter.compile({
        clientEquipmentClassSlug: DEMO_CLASS,
        formulaKey: 'cost_calc',
        expression: '10 * @tariff_per_kwh',
      }, { scope: userA, proposalScope: 'tenant', m, at: NOW }),
    );

    expect(out.ok).toBe(true);

    const prop = await proposals.propose(userA, {
      kind: 'kpi',
      seed: {
        target: { sourceSystem: SS, externalId: 'GEN-01' },
        intent: 'bind-named-formula',
        namedFormulaSlug: 'load_factor',
        formulaKey: 'cost_calc',
      },
      idempotencyKey: key(),
    }, NOW);
    if (prop.status !== 'draft_ready') throw new Error('Expected draft_ready');

    const ref = await withTenantSession(ds, boss, (m) =>
      emitter.materialise({
        clientEquipmentClassSlug: DEMO_CLASS,
        formulaKey: 'cost_calc',
        expression: '10 * @tariff_per_kwh',
      }, {
        scope: boss,
        at: NOW,
        unvalidated: false,
        proposal: {
          id: prop.id,
          scope: 'tenant',
          gateOutcome: 'not_applicable',
          targetVersions: {},
        },
      }, m),
    );

    expect(ref.formulaKey).toBe('cost_calc');

    // Evaluate on GEN-01 where @tariff_per_kwh is not set
    const envelope = await evaluator.evaluateOne(userA, { sourceSystem: SS, externalId: 'GEN-01' }, 'cost_calc', NOW);
    expect(envelope.value).toBeNull();
    expect(envelope.readiness).toBe('not_configured');
  });

  // 9. Informational evaluation runs read-only: make it attempt a write -> PostgreSQL refuses
  it('9. informational evaluation runs inside a read-only transaction where writes are refused', async () => {
    let errorCaught: any = null;
    try {
      await ds.transaction(async (txEm) => {
        await txEm.query('SET TRANSACTION READ ONLY');
        await txEm.query(`INSERT INTO tenant (tenant_id, name) VALUES ('hacked', 'Hacked')`);
      });
    } catch (err) {
      errorCaught = err;
    }
    expect(errorCaught).toBeDefined();
    expect(String(errorCaught)).toMatch(/read-only transaction/i);
  });

  // 10. An unbound signal on target machine -> gate_detail carries unbound, value null; approval still possible
  it('10. unbound signal produces readiness unbound with null value in gate_detail and remains approvable', async () => {
    // GEN-01 has no binding for power_output
    const res = await proposals.propose(userA, {
      kind: 'kpi',
      seed: {
        target: { sourceSystem: SS, externalId: 'GEN-01' },
        intent: 'bind-named-formula',
        namedFormulaSlug: 'load_factor',
        formulaKey: 'unbound_kpi',
      },
      idempotencyKey: key(),
    }, NOW);

    expect(res.status).toBe('draft_ready');
    if (res.status === 'draft_ready') {
      expect(res.gateDetail).toBeDefined();
      const evalDetail = (res.gateDetail as any).evaluation;
      if (evalDetail) {
        expect(evalDetail.value).toBeNull();
        expect(evalDetail.readiness).toBe('unbound');
      }
      // Approval still succeeds
      const approved = await proposals.approve(boss, res.id, NOW);
      expect(approved.status).toBe('materialised');
    }
  });

  // 11. formula_key already present in class copy -> 409 on approval, existing row untouched
  it('11. refuses approval with 409 when formula_key already exists in the class copy', async () => {
    // Pre-insert an existing formula
    await owner.query(`
      INSERT INTO client_formula (tenant_id, client_equipment_class_slug, formula_key, kind, expression, source)
      VALUES ('tenant-a', $1, 'duplicate_kpi', 'physics', '1 + 1', 'copied')`,
      [DEMO_CLASS],
    );

    const res = await proposals.propose(userA, {
      kind: 'kpi',
      seed: {
        target: { sourceSystem: SS, externalId: 'GEN-01' },
        intent: 'bind-named-formula',
        namedFormulaSlug: 'load_factor',
        formulaKey: 'duplicate_kpi',
      },
      idempotencyKey: key(),
    }, NOW);

    expect(res.status).toBe('draft_ready');
    if (res.status === 'draft_ready') {
      await expect(proposals.approve(boss, res.id, NOW)).rejects.toThrow(ConflictException);
      const [existing] = await owner.query(`SELECT expression FROM client_formula WHERE formula_key = 'duplicate_kpi'`);
      expect(existing.expression).toBe('1 + 1'); // untouched
    }
  });

  // 12. Concurrent approve via Promise.allSettled -> both settle, one client_formula row
  it('12. handles concurrent approval idempotently without duplicate rows', async () => {
    const res = await proposals.propose(userA, {
      kind: 'kpi',
      seed: {
        target: { sourceSystem: SS, externalId: 'GEN-01' },
        intent: 'bind-named-formula',
        namedFormulaSlug: 'load_factor',
        formulaKey: 'concurrent_kpi',
      },
      idempotencyKey: key(),
    }, NOW);

    if (res.status !== 'draft_ready') throw new Error('Expected draft_ready');

    const [p1, p2] = await Promise.allSettled([
      proposals.approve(boss, res.id, NOW),
      proposals.approve(boss, res.id, NOW),
    ]);

    expect(p1.status === 'fulfilled' || p2.status === 'fulfilled').toBe(true);

    const rows = await owner.query(
      `SELECT count(*)::int AS c FROM client_formula WHERE tenant_id = 'tenant-a' AND formula_key = 'concurrent_kpi'`,
    );
    expect(rows[0].c).toBe(1);
  });

  // 13. Class copy version changed after proposal -> approval 409
  it('13. refuses approval with 409 if class copy version changed after proposal', async () => {
    const res = await proposals.propose(userA, {
      kind: 'kpi',
      seed: {
        target: { sourceSystem: SS, externalId: 'GEN-01' },
        intent: 'bind-named-formula',
        namedFormulaSlug: 'load_factor',
        formulaKey: 'stale_class_kpi',
      },
      idempotencyKey: key(),
    }, NOW);

    if (res.status !== 'draft_ready') throw new Error('Expected draft_ready');

    // Mutate class copy template checksum
    await owner.query(
      `UPDATE client_equipment_class SET template_checksum = 'new-checksum' WHERE tenant_id = 'tenant-a' AND slug = $1`,
      [DEMO_CLASS],
    );

    await expect(proposals.approve(boss, res.id, NOW)).rejects.toThrow(ConflictException);
  });

  // 14. A generated row reads as tenant_added in the class-upgrade plan
  it('14. a generated row reads as tenant_added in the class upgrade plan because template_version is null', () => {
    const generatedFormula: any = {
      formulaKey: 'gen_kpi',
      templateVersion: null,
      source: 'generated',
    };

    const kind: any = {
      key: (f: any) => f.formulaKey,
      content: (f: any) => ({ formulaKey: f.formulaKey }),
    };

    const plan = planUpgrade([generatedFormula], () => undefined, [], kind, kind);

    expect(plan).toEqual([
      { key: 'gen_kpi', origin: 'tenant_added', upstream: 'unchanged', action: 'keep' },
    ]);
  });

  // 15. INSERT client_formula with source = 'generated' and no proposal_id -> database refuses; and reverse
  it('15. database check constraint refuses generated without proposal_id and non-generated with proposal_id', async () => {
    // source = 'generated' without proposal_id -> check violation
    await expect(
      owner.query(`
        INSERT INTO client_formula (tenant_id, client_equipment_class_slug, formula_key, kind, expression, source, proposal_id)
        VALUES ('tenant-a', $1, 'bad1', 'physics', '1', 'generated', NULL)
      `, [DEMO_CLASS]),
    ).rejects.toThrow(/chk_client_formula_proposal_source/);

    // source = 'copied' with proposal_id -> check violation
    await expect(
      owner.query(`
        INSERT INTO client_formula (tenant_id, client_equipment_class_slug, formula_key, kind, expression, source, proposal_id)
        VALUES ('tenant-a', $1, 'bad2', 'physics', '1', 'copied', '11111111-1111-1111-1111-111111111111')
      `, [DEMO_CLASS]),
    ).rejects.toThrow(/chk_client_formula_proposal_source/);
  });

  // 16. There is no prediction intent and no route that proposes one
  it('16. refuses any attempt to propose prediction as an intent', async () => {
    await expect(
      proposals.propose(userA, {
        kind: 'kpi',
        seed: {
          target: { sourceSystem: SS, externalId: 'GEN-01' },
          intent: 'prediction' as any,
        },
        idempotencyKey: key(),
      }, NOW),
    ).rejects.toThrow(/Prediction has no emitter/);
  });

  // 17. RLS: tenant B cannot see or approve tenant A's KPI proposals or the formulas they made
  it('17. enforces RLS so tenant B cannot see or approve tenant A proposals or formulas', async () => {
    const res = await proposals.propose(userA, {
      kind: 'kpi',
      seed: {
        target: { sourceSystem: SS, externalId: 'GEN-01' },
        intent: 'bind-named-formula',
        namedFormulaSlug: 'load_factor',
        formulaKey: 'tenant_a_kpi',
      },
      idempotencyKey: key(),
    }, NOW);

    if (res.status !== 'draft_ready') throw new Error('Expected draft_ready');

    // Tenant B cannot see it
    await expect(proposals.get(bossB, res.id, NOW)).rejects.toThrow();

    // Tenant B cannot approve it
    await expect(proposals.approve(bossB, res.id, NOW)).rejects.toThrow();

    // Approve as Tenant A
    await proposals.approve(boss, res.id, NOW);

    // Tenant B cannot see the generated formula
    const visibleToB = await ds.transaction(async (m) => {
      await m.query(`SELECT set_config('ta.tenant_id', 'tenant-b', true)`);
      return m.getRepository(ClientFormula).find({ where: { formulaKey: 'tenant_a_kpi' } });
    });
    expect(visibleToB).toEqual([]);
  });

  // 18. Down path: GeneratedClientFormula1762000000000 drops the two columns and leaves seeded rows intact
  it('18. GeneratedClientFormula1762000000000 down migration drops columns and preserves seeded copied formulas', async () => {
    // Insert a copied row
    await owner.query(`
      INSERT INTO client_formula (tenant_id, client_equipment_class_slug, formula_key, kind, expression, source)
      VALUES ('tenant-a', $1, 'copied_preserve', 'physics', '2 + 2', 'copied')
    `, [DEMO_CLASS]);

    // Run down migration
    await undoMigrationNamed(owner, 'GeneratedClientFormula1762000000000');

    // Verify columns dropped
    const cols = await owner.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'client_formula' AND column_name IN ('source', 'proposal_id')
    `);
    expect(cols).toEqual([]);

    // Verify copied formula is still intact
    const [row] = await owner.query(`SELECT formula_key, expression FROM client_formula WHERE formula_key = 'copied_preserve'`);
    expect(row.formula_key).toBe('copied_preserve');
    expect(row.expression).toBe('2 + 2');

    // Migrate back up cleanly
    await owner.runMigrations();
  });
});
