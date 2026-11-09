import { DataSource } from 'typeorm';
import { RequestScope } from '../src/auth/types/request-scope';
import { evaluateRule, WindowReading } from '../src/alert/services/alert-rules';
import { AlertRule } from '../src/alert/entities/alert-rule.entity';
import { AlertRuleTemplate } from '../src/catalog/entities/alert-rule-template.entity';
import { EquipmentClassFormula } from '../src/catalog/entities/equipment-class-formula.entity';
import { EquipmentClassProfile } from '../src/catalog/entities/equipment-class-profile.entity';
import { NamedFormula } from '../src/catalog/entities/named-formula.entity';
import { ScenarioDefinition } from '../src/catalog/entities/scenario-definition.entity';
import { SignalAlias } from '../src/catalog/entities/signal-alias.entity';
import { CatalogAuthoringService } from '../src/catalog/services/catalog-authoring.service';
import { ClientScenario } from '../src/client-catalog/entities/client-scenario.entity';
import { CopyOnGrantService } from '../src/client-catalog/services/copy-on-grant.service';
import { SensorRoleCapability } from '../src/device-catalog/entities/sensor-role-capability.entity';
import { MotorIngestService } from '../src/motor-ingest/motor-ingest.service';
import { withTenantId } from '../src/scope/tenant-session';
import { batches, simulate } from '../scripts/motor-logger-sim';
import { createAppDataSource, createTestDataSource, describeDb, undoMigrationNamed } from './db';

const MIGRATION = 'StartsAllowanceUnit1764400000000';

/**
 * What the Crompton POC's partial tests needed from the platform: current judged only
 * while the motor runs (T3, dry run), starts counted per hour against the maker's
 * allowance (T8), and a way for an account that already holds a class to receive the
 * rules and scenarios published for it since.
 */
describe('POC rules over the new signals', () => {
  const T0 = Date.parse('2026-11-09T10:00:00.000Z');
  const series = (signal: string, unit: string, values: number[]): WindowReading[] => values.map((value, i) => ({
    signal, value, unit, imei: 'MOTOR_001', sourceTimestamp: new Date(T0 + i * 60_000).toISOString(),
  }));
  const ratings = new Map([['rated_current', { value: 5.5, unit: 'A' }], ['max_starts_per_hour', { value: 20, unit: 'starts' }]]);
  const run = (params: Record<string, unknown>, readings: WindowReading[]) =>
    evaluateRule({ trigger: 'signal-threshold', params: params as never, readings, predictions: [], ratings });

  const DRY = { signal: 'running_current', rating: 'rated_current', min: 0.6, lookbackReadings: 3, requiredBreaches: 2 };
  const CYCLING = { signal: 'starts_last_hour', rating: 'max_starts_per_hour', max: 1, lookbackReadings: 1, requiredBreaches: 1 };

  it('dry run: running current under 60% of rated on 2 of the last 3 minutes fires', () => {
    expect(run(DRY, series('running_current', 'A', [4.7, 3.0, 3.1]))?.summary).toMatch(/breached 3\.3 A below/);
  });

  it('dry run: one low minute, or a healthy pump, does not', () => {
    expect(run(DRY, series('running_current', 'A', [4.7, 4.6, 3.0]))).toBeNull();
    expect(run(DRY, series('running_current', 'A', [4.7, 4.6, 4.7]))).toBeNull();
  });

  it('cycling: more starts in an hour than the allowance fires; at the allowance it does not', () => {
    expect(run(CYCLING, series('starts_last_hour', 'starts', [21]))?.summary).toMatch(/breached 20 starts above/);
    expect(run(CYCLING, series('starts_last_hour', 'starts', [20]))).toBeNull();
  });
});

describeDb('POC signals and late-published rules', () => {
  let owner: DataSource;
  let ds: DataSource;

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    await owner.query(`SELECT ensure_telemetry_partition('2026-11-01'::date)`);
    ds = await createAppDataSource();
  }, 30_000);

  afterAll(async () => { await ds?.destroy(); await owner?.destroy(); });

  describe('the motor job', () => {
    const NOW = new Date('2026-11-09T12:00:00.000Z');
    const END = Math.floor(NOW.getTime() / 1000);
    let motors: MotorIngestService;

    const store = async (records: ReturnType<typeof simulate>) => {
      for (const b of batches('MOTOR_001', records, 0)) {
        for (const r of b.records) {
          await owner.query(
            `INSERT INTO motor_sensor_records (device_id, seq, device_ts, voltage_v, current_a, power_factor, temperature_c, rpm, batch_id, received_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT DO NOTHING`,
            [b.device_id, r.seq, r.timestamp, r.voltage, r.current, r.power_factor, r.temperature, r.rpm, b.batch_id,
              new Date((b.records[b.records.length - 1].seq + 1) * 1000)]);
        }
        await owner.query(
          `INSERT INTO motor_upload_log (device_id, batch_id, first_seq, last_seq, record_count, stored_count, boot, lost_total, dropped_total, received_at)
           VALUES ($1, $2, $3, $4, $5, $5, 1, 0, 0, $6)`,
          [b.device_id, b.batch_id, b.first_seq, b.last_seq, b.count, new Date((b.last_seq + 1) * 1000)]);
      }
    };
    const signal = (name: string) => owner.query(
      `SELECT "value"::float8 AS v FROM telemetry_reading WHERE imei = 'MOTOR_001' AND signal = $1 ORDER BY source_timestamp`, [name],
    ).then((rows: { v: number }[]) => rows.map((r) => r.v));

    beforeAll(() => { motors = new MotorIngestService(ds); });
    beforeEach(async () => {
      await owner.query(`TRUNCATE "motor_sensor_records", "motor_upload_log", "telemetry_reading", "device_inventory", "tenant_parameter" CASCADE`);
      await owner.query(`DELETE FROM "equipment_profile"`);
      const [{ id }] = await owner.query(
        `INSERT INTO "equipment_profile" ("tenant_id", "source_system", "external_id", "tier", "readiness")
         VALUES ('motors', 'ta-2.0', 'PUMP-1', 'basic', '{}') RETURNING "id"`);
      await owner.query(`INSERT INTO device_inventory (imei, tenant_id, state, equipment_external_id) VALUES ('MOTOR_001', 'motors', 'assigned', 'PUMP-1')`);
      for (const [name, value, unit] of [['rated_current', 5.5, 'A'], ['rated_voltage', 220, 'V']] as const) {
        await owner.query(
          `INSERT INTO tenant_parameter (tenant_id, scope, scope_ref, name, value, unit, effective_from, created_by)
           VALUES ('motors', 'equipment', $1, $2, $3::jsonb, $4, '2026-01-01', 'test')`, [id, name, JSON.stringify(value), unit]);
      }
    });

    it('running_current is the current while running, and absent for a minute the motor stood still', async () => {
      // Cycling: 90 s on, 30 s off. Every minute has some running, so each has a value,
      // and it is the running current (~4.7 A), not the minute average the stops pull down.
      await store(simulate('cycling', 10 * 60, END, END - 11 * 60));
      await motors.processPending(NOW);
      const running = await signal('running_current');
      expect(running.length).toBeGreaterThan(0);
      expect(Math.min(...running)).toBeGreaterThan(4);
      const plain = await signal('motor_current');
      expect(Math.min(...plain)).toBeLessThan(Math.min(...running));
    });

    it('starts_last_hour counts every start in the hour ending at each minute', async () => {
      await store(simulate('cycling', 20 * 60, END, END - 21 * 60));
      await motors.processPending(NOW);
      const perMinute = await signal('motor_starts');
      const lastHour = await signal('starts_last_hour');
      const total = perMinute.reduce((a, b) => a + b, 0);
      expect(total).toBeGreaterThanOrEqual(8);
      // The newest minute's window covers the whole 20-minute run.
      expect(lastHour[lastHour.length - 1]).toBe(total);
      // And never goes down while the run lasts.
      expect(lastHour).toEqual([...lastHour].sort((a, b) => a - b));
    });
  });

  describe('a re-grant delivers what was published since', () => {
    const scope: RequestScope = { tenantId: '', userId: 'deepak', roles: [], isPlatformRole: true };
    const NOW = new Date('2026-11-09T00:00:00.000Z');
    let authoring: CatalogAuthoringService;
    let copies: CopyOnGrantService;

    beforeAll(() => {
      authoring = new CatalogAuthoringService(
        ds.getRepository(EquipmentClassProfile), ds.getRepository(EquipmentClassFormula),
        ds.getRepository(ScenarioDefinition), ds.getRepository(SignalAlias),
        ds.getRepository(AlertRuleTemplate), ds.getRepository(NamedFormula),
        ds.getRepository(SensorRoleCapability),
      );
      copies = new CopyOnGrantService(ds);
    });

    const mine = async () => withTenantId(ds, 'acme', async (m) => ({
      scenarios: (await m.getRepository(ClientScenario).find({ where: { tenantId: 'acme' }, order: { slug: 'ASC' } })),
      rules: (await m.getRepository(AlertRule).find({ where: { tenantId: 'acme' }, order: { slug: 'ASC' } })),
    }));

    it('adds the new scenario and rule, and leaves the account\'s edited ones as they are', async () => {
      await authoring.createClass(scope, 'pump-x', { name: 'Pump X', expectedSignals: [{ signal: 'motor_current', unit: 'A', required: true }] });
      await authoring.publishClass(scope, 'pump-x');
      await authoring.createScenario(scope, 'pump-x-old', { equipmentClassSlug: 'pump-x', name: 'Old', requiredSignals: ['motor_current'] } as never);
      await authoring.publishScenario(scope, 'pump-x-old');
      await copies.copyForTenant('acme', 'pump-x', 'deepak', NOW);
      await withTenantId(ds, 'acme', (m) => m.getRepository(ClientScenario).update({ tenantId: 'acme', slug: 'pump-x-old' }, { name: 'Ours now' }));

      await authoring.createScenario(scope, 'pump-x-new', { equipmentClassSlug: 'pump-x', name: 'New', requiredSignals: ['motor_current'] } as never);
      await authoring.publishScenario(scope, 'pump-x-new');
      await authoring.createAlertTemplate(scope, 'pump-x-dry', {
        equipmentClassSlug: 'pump-x', name: 'Dry run', trigger: 'signal-threshold', severity: 'critical',
        params: { signal: 'motor_current', max: 1 },
      } as never);
      await authoring.publishAlertTemplate(scope, 'pump-x-dry');

      const result = await copies.copyForTenant('acme', 'pump-x', 'deepak', NOW);
      expect(result).toMatchObject({ alreadyPresent: true, scenariosCopied: 1, alertRulesCopied: 1 });
      const after = await mine();
      expect(after.scenarios.map((s) => [s.slug, s.name])).toEqual([['pump-x-new', 'New'], ['pump-x-old', 'Ours now']]);
      expect(after.rules.map((r) => r.slug)).toEqual(['pump-x-dry']);

      // And again: nothing new, nothing copied.
      expect(await copies.copyForTenant('acme', 'pump-x', 'deepak', NOW)).toMatchObject({ scenariosCopied: 0, alertRulesCopied: 0 });
    });
  });

  describe('the starts allowance has a unit', () => {
    it('is measured in starts, like the count it is compared with', async () => {
      const [{ unit }] = await owner.query(`SELECT unit FROM rating_parameter WHERE name = 'max_starts_per_hour'`);
      expect(unit).toBe('starts');
    });

    it('undoes its own migration, and the chain re-applies', async () => {
      await undoMigrationNamed(owner, MIGRATION);
      expect((await owner.query(`SELECT unit FROM rating_parameter WHERE name = 'max_starts_per_hour'`))[0].unit).toBeNull();
      await owner.runMigrations({ transaction: 'all' });
      expect((await owner.query(`SELECT unit FROM rating_parameter WHERE name = 'max_starts_per_hour'`))[0].unit).toBe('starts');
    });
  });
});
