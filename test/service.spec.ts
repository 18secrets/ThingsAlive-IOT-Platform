import { BadRequestException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { RequestScope } from '../src/auth/types/request-scope';
import { SIGNALS } from '../src/common/signals';
import { CLIENT_SOURCE_SYSTEM } from '../src/equipment/equipment-profile.entity';
import { EquipmentService } from '../src/equipment/services/equipment.service';
import { PlantService } from '../src/equipment/services/plant.service';
import { runTenantSpanning } from '../src/scope/tenant-session';
import { ServiceForecastService } from '../src/service/services/service-forecast.service';
import { computeDutyCycle } from '../src/utilization/services/duty-cycle';
import { UtilizationService } from '../src/utilization/services/utilization.service';
import { createAppDataSource, createTestDataSource, describeDb } from './db';

/**
 * Service forecasting, end to end (task P4-07).
 *
 * Two things here can only be shown with a database behind them: that the meter's unit
 * is derived from the duty-cycle rows rather than configured, and that a machine
 * missing one of the four inputs says which one instead of disappearing from the list.
 */
describeDb('service forecast', () => {
  let ds: DataSource;
  let owner: DataSource;
  let service: ServiceForecastService;
  let utilization: UtilizationService;
  let plants: PlantService;
  let equipment: EquipmentService;

  const NOW = new Date('2026-09-14T00:00:00Z');
  const boss: RequestScope = {
    tenantId: 'acme', userId: 'u-boss', roles: ['ceo-manager'], isPlatformRole: false,
    capabilities: ['utilization.read', 'equipment.write', 'action.work'],
  };
  const stranger: RequestScope = {
    tenantId: 'globex', userId: 'u-other', roles: ['ceo-manager'], isPlatformRole: false,
    capabilities: ['utilization.read', 'action.work'],
  };

  const ref = (externalId: string) => ({ sourceSystem: CLIENT_SOURCE_SYSTEM, externalId });
  const IMEI = (n: number) => `86012345678900${n}`;

  /**
   * `days` shifts of eight engine hours each, ending yesterday, with the hour meter
   * advancing by the right amount for `meterUnit`. This is the fixture the whole
   * feature rests on: duty cycle and meter describing the same hours.
   */
  const runFleet = async (
    externalId: string,
    days: number,
    opts: { hoursPerDay?: number; meterUnit?: 'hours' | 'minutes' | 'seconds'; meterFrom?: number } = {},
  ) => {
    const hours = opts.hoursPerDay ?? 8;
    const unit = opts.meterUnit ?? 'hours';
    const per = { hours: 1, minutes: 60, seconds: 3600 }[unit];
    let meter = opts.meterFrom ?? 1000;

    for (let d = days; d >= 1; d -= 1) {
      const start = new Date(NOW.getTime() - d * 86400_000);
      const readings = [];
      for (let i = 0; i < hours * 60; i += 1) {
        const at = new Date(start.getTime() + i * 60_000).toISOString();
        readings.push({ signal: SIGNALS.engineRunningStatus, value: 1, unit: null, sourceTimestamp: at });
        readings.push({ signal: SIGNALS.utilizationStatus, value: 1, unit: null, sourceTimestamp: at });
      }
      // Meter samples at each end of the window, advancing by the hours worked.
      readings.push({ signal: SIGNALS.engineRuntime, value: meter, unit, sourceTimestamp: start.toISOString() });
      meter += hours * per;
      readings.push({
        signal: SIGNALS.engineRuntime, value: meter, unit,
        sourceTimestamp: new Date(start.getTime() + hours * 3600_000).toISOString(),
      });

      await utilization.record({
        tenantId: 'acme',
        shiftId: `00000000-0000-0000-0000-${String(d).padStart(12, '0')}`,
        shiftName: 'Day',
        sourceSystem: CLIENT_SOURCE_SYSTEM,
        externalId,
        localDate: start.toISOString().slice(0, 10),
        duty: computeDutyCycle(readings, start, new Date(start.getTime() + hours * 3600_000)),
      });
    }
    return meter;
  };

  /** Put the machine's newest meter reading into telemetry, where the forecast reads it. */
  const setMeter = async (externalId: string, imei: string, value: number, unit: string) => {
    await runTenantSpanning(owner, 'test fixture', async (m) => {
      await m.query(
        `INSERT INTO "sensor_map_projection"
           ("tenant_id","source_system","external_id","checksum","imei","signal","sensor_name",
            "unit","payload","source_updated_at","synced_at","status")
         VALUES ('acme',$1,$2,'c',$3,$4,'Runtime',$5,'{}'::jsonb,$6,$6,'live')
         ON CONFLICT DO NOTHING`,
        [CLIENT_SOURCE_SYSTEM, externalId, imei, SIGNALS.engineRuntime, unit, NOW]);
      await m.query(
        `INSERT INTO "telemetry_reading"
           ("tenant_id","imei","signal","value","unit","source_timestamp","received_at","source")
         VALUES ('acme',$1,$2,$3,$4,$5,$5,'live')
         ON CONFLICT DO NOTHING`,
        [imei, SIGNALS.engineRuntime, value, unit, new Date(NOW.getTime() - 3600_000)]);
    });
  };

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    ds = await createAppDataSource();
    service = new ServiceForecastService(ds);
    utilization = new UtilizationService(ds);
    plants = new PlantService(ds);
    equipment = new EquipmentService(ds);
  }, 40_000);

  afterAll(async () => { await ds?.destroy(); await owner?.destroy(); });

  beforeEach(async () => {
    for (const t of ['equipment_service_record', 'utilization_shift', 'telemetry_reading',
      'sensor_map_projection', 'equipment_placement_event', 'equipment_profile', 'plant',
      'equipment_class_profile']) {
      await owner.query(`DELETE FROM "${t}"`);
    }
    const north = (await plants.create(boss, { code: 'NORTH', name: 'Northern yard' })).id;
    await equipment.create(boss, {
      code: 'DG-1', name: 'Generator 1', plantId: north, serviceIntervalHours: 500,
    });
  });

  it('derives the meter unit from duty cycle rather than being told it', async () => {
    // The whole point of the calibration. Nobody configured "seconds" anywhere; the
    // engine-on seconds and the meter delta describe the same hours, so the ratio says it.
    await runFleet('DG-1', 30, { meterUnit: 'seconds' });
    const c = await service.calibration(boss, NOW);
    expect(c.unit).toBe('seconds');
    expect(c.confidence).toBe('high');
    expect(c.usable).toBeGreaterThanOrEqual(30);
  });

  it('reads a fleet configured in hours just as well', async () => {
    await runFleet('DG-1', 30, { meterUnit: 'hours' });
    expect((await service.calibration(boss, NOW)).unit).toBe('hours');
  });

  it('forecasts a due date from the meter, the interval and the rate', async () => {
    const end = await runFleet('DG-1', 30, { meterUnit: 'hours', meterFrom: 1000 });
    await setMeter('DG-1', IMEI(1), end, 'h');
    await service.recordService(boss, ref('DG-1'), {
      performedAt: new Date(NOW.getTime() - 31 * 86400_000),
      meterReading: 1000, meterUnit: 'hours',
    });

    const { calibration, assets } = await service.fleetForecast(boss, NOW);
    expect(calibration.unit).toBe('hours');
    const [dg] = assets;
    // 30 days at 8 h/day = 240 hours run against a 500-hour interval.
    expect(dg.hoursSinceDatum).toBe(240);
    expect(dg.hoursRemaining).toBe(260);
    expect(dg.hoursPerDay).toBe(8);
    expect(dg.daysRemaining).toBe(32.5);
    expect(dg.status).toBe('ok');
    expect(dg.intervalSource).toBe('equipment');
    expect(dg.missing).toEqual([]);
  });

  it('calls a machine past its interval overdue and sorts it first', async () => {
    await equipment.create(boss, { code: 'DG-2', name: 'Generator 2', serviceIntervalHours: 100 });
    const e1 = await runFleet('DG-1', 30);
    const e2 = await runFleet('DG-2', 30);
    await setMeter('DG-1', IMEI(1), e1, 'h');
    await setMeter('DG-2', IMEI(2), e2, 'h');
    for (const [code, at] of [['DG-1', 1000], ['DG-2', 1000]] as [string, number][]) {
      await service.recordService(boss, ref(code), {
        performedAt: new Date(NOW.getTime() - 31 * 86400_000),
        meterReading: at, meterUnit: 'hours',
      });
    }

    const { assets } = await service.fleetForecast(boss, NOW);
    // DG-2 ran the same 240 hours against a 100-hour interval.
    expect(assets[0].externalId).toBe('DG-2');
    expect(assets[0].status).toBe('overdue');
    expect(assets[0].hoursRemaining).toBe(-140);
    expect(assets[1].status).toBe('ok');
  });

  it('falls back to the class interval, and lets the machine override it', async () => {
    await owner.query(
      `INSERT INTO "equipment_class_profile"
         ("slug","version","name","service_interval_hours","status")
       VALUES ('dg', 1, 'Diesel generator', 250, 'published')`);
    await equipment.create(boss, { code: 'DG-3', name: 'Generator 3' });
    await equipment.update(boss, ref('DG-3'), { equipmentClassSlug: 'dg' });

    const end = await runFleet('DG-3', 30);
    await setMeter('DG-3', IMEI(3), end, 'h');
    await service.recordService(boss, ref('DG-3'), {
      performedAt: new Date(NOW.getTime() - 31 * 86400_000), meterReading: 1000, meterUnit: 'hours',
    });

    const { assets } = await service.fleetForecast(boss, NOW);
    const dg3 = assets.find((a) => a.externalId === 'DG-3')!;
    expect(dg3.intervalSource).toBe('class');
    expect(dg3.intervalHours).toBe(250);
    // DG-1 carries its own 500 and is unaffected by the class default.
    expect(assets.find((a) => a.externalId === 'DG-1')!.intervalHours).toBe(500);
  });

  it('says which input is missing instead of dropping the machine from the list', async () => {
    // No interval, no meter, no service history — the state of every machine on day one.
    await equipment.create(boss, { code: 'DG-9', name: 'Generator 9' });
    const { assets } = await service.fleetForecast(boss, NOW);
    const dg9 = assets.find((a) => a.externalId === 'DG-9')!;
    expect(dg9).toBeDefined();
    expect(dg9.status).toBeNull();
    expect(dg9.missing).toContain('interval');
    expect(dg9.missing).toContain('meter-reading');
  });

  it('uses commissioning as the datum when a machine has never been serviced', async () => {
    await equipment.create(boss, {
      code: 'DG-4', name: 'Generator 4', serviceIntervalHours: 500,
      commissionedAt: new Date(NOW.getTime() - 60 * 86400_000).toISOString(),
    } as any);
    await runFleet('DG-4', 30, { meterFrom: 0 });
    await setMeter('DG-4', IMEI(4), 240, 'h');

    const { assets } = await service.fleetForecast(boss, NOW);
    const dg4 = assets.find((a) => a.externalId === 'DG-4')!;
    expect(dg4.datum).toBe('commissioning');
    expect(dg4.hoursSinceDatum).toBe(240);
  });

  it('flags a machine outrunning its class, and refuses on too few peers', async () => {
    await owner.query(
      `INSERT INTO "equipment_class_profile"
         ("slug","version","name","service_interval_hours","status")
       VALUES ('dg', 1, 'Diesel generator', 500, 'published')`);
    for (const code of ['A1', 'A2', 'A3', 'HOT']) {
      await equipment.create(boss, { code, name: code });
      await equipment.update(boss, ref(code), { equipmentClassSlug: 'dg' });
    }
    for (const code of ['A1', 'A2', 'A3']) await runFleet(code, 30, { hoursPerDay: 4 });
    await runFleet('HOT', 30, { hoursPerDay: 12 });
    // DG-1 runs too, so its comparison is withheld for want of peers rather than for
    // want of a rate of its own — those are different refusals and only one is tested
    // by leaving a machine idle.
    await runFleet('DG-1', 30, { hoursPerDay: 8 });

    const { assets } = await service.fleetForecast(boss, NOW);
    const hot = assets.find((a) => a.externalId === 'HOT')!;
    expect(hot.fleet.outrunning).toBe(true);
    expect(hot.fleet.ratio).toBeGreaterThan(1.5);
    expect(hot.fleet.peers).toBe(4);

    // DG-1 has a rate but no class, so it has no peers: no comparison rather than a
    // false one against the whole yard.
    const dg1 = assets.find((a) => a.externalId === 'DG-1')!;
    expect(dg1.hoursPerDay).toBe(8);
    expect(dg1.fleet.reason).toBe('too-few-peers');
    expect(dg1.fleet.outrunning).toBe(false);
  });

  it('withholds a comparison for a machine with no rate of its own', async () => {
    // Distinct from having no peers: this machine has plenty of peers and has simply
    // not run, and telling somebody it is "not outrunning its class" would be a
    // finding about a machine nobody has watched.
    await owner.query(
      `INSERT INTO "equipment_class_profile"
         ("slug","version","name","service_interval_hours","status")
       VALUES ('dg', 1, 'Diesel generator', 500, 'published')`);
    for (const code of ['B1', 'B2', 'B3', 'IDLE']) {
      await equipment.create(boss, { code, name: code });
      await equipment.update(boss, ref(code), { equipmentClassSlug: 'dg' });
    }
    for (const code of ['B1', 'B2', 'B3']) await runFleet(code, 30, { hoursPerDay: 6 });

    const { assets } = await service.fleetForecast(boss, NOW);
    const idle = assets.find((a) => a.externalId === 'IDLE')!;
    expect(idle.fleet.reason).toBe('no-rate');
    expect(idle.fleet.outrunning).toBe(false);
  });

  it('divides by the days a machine actually reported, not by the calendar', async () => {
    // A machine registered a week ago has a week of history. Dividing its hours by
    // thirty would report it at a third of the rate it is really running.
    await equipment.create(boss, { code: 'NEW', name: 'New arrival', serviceIntervalHours: 500 });
    await runFleet('NEW', 10, { hoursPerDay: 9 });
    const { assets } = await service.fleetForecast(boss, NOW);
    expect(assets.find((a) => a.externalId === 'NEW')!.hoursPerDay).toBe(9);
  });

  describe('recording a service', () => {
    it('stores the meter as it was read, unconverted', async () => {
      const row = await service.recordService(boss, ref('DG-1'), {
        meterReading: 900000, meterUnit: 'seconds', notes: 'Oil and filters.',
      });
      expect(row.meterReading).toBe(900000);
      expect(row.meterUnit).toBe('seconds');
      expect(row.recordedBy).toBe('u-boss');
    });

    it('refuses a reading without its unit, and a unit without a reading', async () => {
      await expect(service.recordService(boss, ref('DG-1'), { meterReading: 1200 }))
        .rejects.toThrow(BadRequestException);
      await expect(service.recordService(boss, ref('DG-1'), { meterUnit: 'hours' }))
        .rejects.toThrow(BadRequestException);
    });

    it('refuses a service against a machine that is not in the register', async () => {
      // A typo in an external id would otherwise make a machine's history silently
      // incomplete while a row sat somewhere nobody reads.
      await expect(service.recordService(boss, ref('NOPE'), {}))
        .rejects.toThrow(/equipment register/);
    });

    it('refuses a service performed in the future', async () => {
      await expect(service.recordService(boss, ref('DG-1'), {
        performedAt: new Date(Date.now() + 86400_000),
      })).rejects.toThrow(/future/);
    });

    it('keeps one account\'s service history out of another\'s', async () => {
      await service.recordService(boss, ref('DG-1'), { notes: 'ours' });
      expect(await service.history(stranger, ref('DG-1'))).toEqual([]);
      expect((await service.fleetForecast(stranger, NOW)).assets).toEqual([]);
    });

    it('shows the newest record first', async () => {
      await service.recordService(boss, ref('DG-1'), {
        performedAt: new Date(NOW.getTime() - 200 * 86400_000), notes: 'older',
      });
      await service.recordService(boss, ref('DG-1'), {
        performedAt: new Date(NOW.getTime() - 10 * 86400_000), notes: 'newer',
      });
      expect((await service.history(boss, ref('DG-1'))).map((r) => r.notes))
        .toEqual(['newer', 'older']);
    });
  });
});
