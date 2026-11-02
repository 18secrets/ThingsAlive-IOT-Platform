import { DataSource } from 'typeorm';
import { RequestScope } from '../src/auth/types/request-scope';
import { SignalBindingService } from '../src/signal-binding/services/signal-binding.service';
import { createAppDataSource, createTestDataSource, describeDb, undoMigrationNamed } from './db';

const SS = 'ta-2.0';
const MIGRATION = 'BindingPeriodFromSiblings1762400000000';
const scope: RequestScope = { tenantId: 'acme', userId: 'u-admin', roles: ['admin'], isPlatformRole: false };
const M1 = { sourceSystem: SS, externalId: 'M-1' };

/**
 * A binding's reporting period, when nobody states one, is the one its logger's other
 * channels on the machine agree on. Found on dev: EX-01's fuel_level, activated from
 * discovery with no period beside six siblings at 600 s, read half covered (the
 * evaluator's 300 s default) and every KPI on it insufficient_coverage.
 */
describeDb('binding reporting period, inherited', () => {
  let owner: DataSource;
  let ds: DataSource;
  let bindings: SignalBindingService;

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    ds = await createAppDataSource();
    bindings = new SignalBindingService(ds);
  }, 60_000);

  afterAll(async () => { await ds?.destroy(); await owner?.destroy(); });

  beforeEach(async () => {
    await owner.query(`DELETE FROM signal_binding_version`);
    await owner.query(`DELETE FROM equipment_profile`);
    for (const ext of ['M-1', 'M-2']) {
      await owner.query(`INSERT INTO equipment_profile (tenant_id, source_system, external_id, tier, readiness, updated_by)
        VALUES ('acme', $1, $2, 'standard', '{}'::jsonb, 'fixture')`, [SS, ext]);
    }
  });

  /** An existing active binding on M-1's logger LOG-1, at the given period. */
  const sibling = (signal: string, period: number | null, ext = 'M-1', imei = 'LOG-1') => owner.query(
    `INSERT INTO signal_binding_version (tenant_id, source_system, external_id, signal_key, measurement_role, component_id,
       origin, imei, canonical_unit, valid_from, valid_to, is_primary, status, expected_period_seconds)
     VALUES ('acme', $1, $2, $3, $3, '', 'physical', $4, 'u', '2026-01-01T00:00:00Z', NULL, true, 'active', $5)`,
    [SS, ext, signal, imei, period]);

  const activate = (signal: string, extra: Record<string, unknown> = {}) => bindings.activate(scope, M1, {
    signalKey: signal, measurementRole: signal, origin: 'physical', imei: 'LOG-1', canonicalUnit: '%',
    validFrom: new Date('2026-10-22T00:00:00Z'), discoveredBy: 'sensor-map', ...extra,
  });

  it('1. activated from discovery with no period, it takes the 600 s its logger\'s siblings agree on', async () => {
    await sibling('engine_coolant_temperature', 600);
    await sibling('engine_oil_pressure', 600);
    expect((await activate('fuel_level')).expectedPeriodSeconds).toBe(600);
  });

  it('2. a period the caller states wins over the siblings\'', async () => {
    await sibling('engine_coolant_temperature', 600);
    expect((await activate('fuel_level', { expectedPeriodSeconds: 60 })).expectedPeriodSeconds).toBe(60);
  });

  it('3. siblings that disagree, or none at all, leave it null rather than guess', async () => {
    await sibling('engine_coolant_temperature', 600);
    await sibling('engine_oil_pressure', 30);
    expect((await activate('fuel_level')).expectedPeriodSeconds).toBeNull();
    await owner.query(`DELETE FROM signal_binding_version`);
    expect((await activate('fuel_level')).expectedPeriodSeconds).toBeNull();
  });

  it('4. another machine\'s bindings on a logger of the same name are not this machine\'s siblings', async () => {
    await sibling('engine_coolant_temperature', 600, 'M-2');
    expect((await activate('fuel_level')).expectedPeriodSeconds).toBeNull();
  });

  it('5. replacing a binding (a new device) keeps the period of the sensor it replaces', async () => {
    await sibling('fuel_level', 120);
    const next = await activate('fuel_level', { imei: 'LOG-2', validFrom: new Date('2026-10-23T00:00:00Z') });
    expect(next.expectedPeriodSeconds).toBe(120);
  });

  it('6. a proposal records the inherited period too, for when it is approved', async () => {
    await sibling('engine_coolant_temperature', 600);
    const p = await bindings.propose(scope, M1, {
      signalKey: 'fuel_level', measurementRole: 'fuel_level', origin: 'physical', imei: 'LOG-1', canonicalUnit: '%',
      validFrom: new Date('2026-10-22T00:00:00Z'), discoveredBy: 'sensor-map',
    });
    expect(p.expectedPeriodSeconds).toBe(600);
  });

  // Last: it takes the schema down a step and puts it back.
  it(`7. ${MIGRATION} fills a row made before the fix from agreeing siblings, and leaves a disagreeing machine's null`, async () => {
    await sibling('engine_coolant_temperature', 600);
    await sibling('fuel_level', null);
    await sibling('engine_coolant_temperature', 600, 'M-2', 'LOG-9');
    await sibling('engine_oil_pressure', 30, 'M-2', 'LOG-9');
    await sibling('fuel_level', null, 'M-2', 'LOG-9');
    await undoMigrationNamed(owner, MIGRATION);
    await owner.runMigrations({ transaction: 'all' });
    const rows = await owner.query(`SELECT external_id, signal_key, expected_period_seconds AS p FROM signal_binding_version
      WHERE signal_key = 'fuel_level' ORDER BY external_id`);
    expect(rows).toEqual([{ external_id: 'M-1', signal_key: 'fuel_level', p: 600 }, { external_id: 'M-2', signal_key: 'fuel_level', p: null }]);
  });
});
