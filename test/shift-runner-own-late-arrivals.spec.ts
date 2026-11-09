import { DataSource } from 'typeorm';
import { AlertService } from '../src/alert/services/alert.service';
import { RequestScope } from '../src/auth/types/request-scope';
import { DeviceHealthService } from '../src/device-health/services/device-health.service';
import { CLIENT_SOURCE_SYSTEM } from '../src/equipment/equipment-profile.entity';
import { EquipmentService } from '../src/equipment/services/equipment.service';
import { ChainService } from '../src/intelligence/services/chain.service';
import { LegacyTelemetryReader } from '../src/legacy/legacy-telemetry.reader';
import { PredictionService } from '../src/prediction/services/prediction.service';
import { runTenantSpanning } from '../src/scope/tenant-session';
import { ShiftRunner } from '../src/shift/services/shift-runner.service';
import { ShiftService } from '../src/shift/services/shift.service';
import { TelemetryService } from '../src/telemetry/telemetry.service';
import { UtilizationService } from '../src/utilization/services/utilization.service';
import { PredictionWorkRaiser } from '../src/work/services/prediction-work-raiser.service';
import { bindProjectedDevice } from './bind-projected-devices';
import { createAppDataSource, createTestDataSource, describeDb } from './db';

const IST = 'Asia/Kolkata';
// 06:00-14:00 IST on the 14th is 00:30-08:30 UTC: closed by NOW.
const NOW = new Date('2026-09-14T09:00:00.000Z');
const LATER = new Date('2026-09-14T11:00:00.000Z');

/**
 * Late readings that reached 2.0 directly (G06: a late reading revises an outcome).
 *
 * A motor logger stores and forwards: after a GSM outage it flushes hours of buffered
 * readings at once, dated in shifts already scored. The late-arrival sweep only asked
 * the existing platform, so with no connection to it (dev today) those shifts were never
 * scored again, and an overload during an outage raised no alert. Found by running the
 * motor library end to end: the overload reached 2.0 after its shift had been scored.
 */
describeDb('the shift runner: late readings that reached 2.0 directly', () => {
  let ds: DataSource;
  let owner: DataSource;
  let runner: ShiftRunner;
  let shifts: ShiftService;
  let equipment: EquipmentService;
  let alerts: AlertService;

  const boss: RequestScope = {
    tenantId: 'acme', userId: 'u-boss', roles: ['ceo-manager'], isPlatformRole: false,
    capabilities: ['equipment.write', 'catalog.read', 'alert.author'],
  };
  const morning = { name: 'A', startMinute: 6 * 60, endMinute: 14 * 60, days: [0, 1, 2, 3, 4, 5, 6] as any, timeZone: IST };
  const REF = { sourceSystem: CLIENT_SOURCE_SYSTEM, externalId: 'PUMP-7' };

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    await owner.query(`SELECT ensure_telemetry_partition('2026-09-01'::date)`);
    ds = await createAppDataSource();
    shifts = new ShiftService(ds);
    equipment = new EquipmentService(ds);
    alerts = new AlertService(ds);
    // No legacy connection, as on dev.
    runner = new ShiftRunner(
      ds, shifts, new LegacyTelemetryReader(ds, null), new TelemetryService(ds),
      new PredictionService(ds, new PredictionWorkRaiser()), alerts,
      new UtilizationService(ds), new DeviceHealthService(ds), new ChainService(ds),
    );
  }, 40_000);

  afterAll(async () => { await ds?.destroy(); await owner?.destroy(); });

  beforeEach(async () => {
    for (const t of ['device_link_health', 'utilization_shift', 'shift_run', 'alert_event', 'alert_rule',
      'telemetry_reading', 'equipment_shift', 'signal_binding_version', 'equipment_placement_event', 'equipment_profile']) {
      await owner.query(`DELETE FROM "${t}"`);
    }
    await equipment.create(boss, { code: 'PUMP-7', name: 'Pump 7' });
    await runTenantSpanning(owner, 'fixture', (m) => bindProjectedDevice(m, {
      tenantId: 'acme', sourceSystem: CLIENT_SOURCE_SYSTEM, externalId: 'PUMP-7', imei: 'MOTOR_007',
    }));
    await alerts.createRule(boss, {
      slug: 'overload', name: 'Overload', trigger: 'signal-threshold', appliesTo: 'account',
      params: { signal: 'coolant_temp', max: 6.6 },
    });
  });

  /** One reading a minute across a span of the 14th's window, arriving at `arrived`. */
  const readings = (fromUtc: string, toUtc: string, value: number, arrived: Date) => owner.query(
    `INSERT INTO telemetry_reading (tenant_id, imei, signal, value, unit, source_timestamp, received_at, source)
     SELECT 'acme', 'MOTOR_007', 'coolant_temp', $3, 'degC', ts, $4, 'live'
       FROM generate_series($1::timestamptz, $2::timestamptz, interval '1 minute') ts`,
    [fromUtc, toUtc, value, arrived]);
  const scoredThrough = async () => {
    const [row] = await owner.query(`SELECT scored_through FROM equipment_shift WHERE external_id = 'PUMP-7'`);
    return row.scored_through ? new Date(row.scored_through).toISOString() : null;
  };
  const alertCount = async () => (await owner.query(`SELECT count(*)::int AS n FROM alert_event`))[0].n as number;

  it('an overload that arrives after its shift was scored re-scores the shift, and raises the alert', async () => {
    await shifts.create(boss, REF, morning);
    // The part of the shift that arrived on time: normal running.
    await readings('2026-09-14T00:31:00Z', '2026-09-14T07:30:00Z', 5.0, new Date('2026-09-14T08:00:00Z'));
    expect(await runner.run(NOW)).toMatchObject({ scored: 1 });
    expect(await scoredThrough()).toBe('2026-09-14T08:30:00.000Z');
    expect(await alertCount()).toBe(0);

    // The logger was offline for the shift's last hour, and flushes it at 10:30 UTC.
    await readings('2026-09-14T07:31:00Z', '2026-09-14T08:29:00Z', 7.4, new Date('2026-09-14T10:30:00Z'));
    const again = await runner.run(LATER);
    expect(again).toMatchObject({ rewound: 1, scored: 1 });
    expect(await scoredThrough()).toBe('2026-09-14T08:30:00.000Z');
    const [event] = await owner.query(`SELECT summary FROM alert_event`);
    expect(event.summary).toMatch(/breached 6\.6/);
  });

  it('readings already seen are not late again: a further pass finds nothing to re-score', async () => {
    await shifts.create(boss, REF, morning);
    await readings('2026-09-14T00:31:00Z', '2026-09-14T08:29:00Z', 5.0, new Date('2026-09-14T08:00:00Z'));
    await runner.run(NOW);
    expect(await runner.run(LATER)).toMatchObject({ rewound: 0, considered: 0 });
  });

  it('a reading late for a window not yet scored owes nothing extra: it is read when that window is', async () => {
    await shifts.create(boss, REF, morning);
    await readings('2026-09-14T00:31:00Z', '2026-09-14T08:29:00Z', 5.0, new Date('2026-09-14T08:45:00Z'));
    expect(await runner.run(NOW)).toMatchObject({ rewound: 0, scored: 1 });
  });
});
