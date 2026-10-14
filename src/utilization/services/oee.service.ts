import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager, IsNull } from 'typeorm';
import { RequestScope } from '../../auth/types/request-scope';
import { EquipmentClassProfile } from '../../catalog/entities/equipment-class-profile.entity';
import { SIGNALS } from '../../common/signals';
import { EquipmentProfile } from '../../equipment/equipment-profile.entity';
import { TelemetryWindowReader } from '../../kpi/services/telemetry-window-reader';
import { chainForEquipment, resolveParameters } from '../../parameters/services/parameter-resolution';
import { DeviceProjection } from '../../projection/entities/device-projection.entity';
import { withTenantSession } from '../../scope/tenant-session';
import { EquipmentShift } from '../../shift/entities/equipment-shift.entity';
import { SignalBindingVersion } from '../../signal-binding/entities/signal-binding-version.entity';
import { bindingSegments, overlapping } from '../../signal-binding/services/signal-binding.service';
import { BreakdownEvent } from '../entities/breakdown-event.entity';
import { computeAvailability, Interval, operatingIntervals, scheduledIntervals } from './availability';
import { readEngineState } from './availability.service';
import {
  detectBreakdowns, FactorState, fuelBurned, oeeOf, overlapMinutes, performanceOf, qualityOf, Readiness,
  Sample, subtract,
} from './oee';

export type OeeWindow = 'day' | 'week' | 'month';
export const OEE_WINDOWS: readonly OeeWindow[] = ['day', 'week', 'month'];
export type ParameterSource = 'equipment' | 'class' | 'site' | 'client' | 'oem';

/** The rate signal actual fuel is measured from. Compared with the nominal in the same
 * unit or not at all — this platform converts nothing. */
export const FUEL_RATE_SIGNAL = SIGNALS.fuelConsumption;

const MINUTE = 60_000;
const DAY = 86_400_000;
/** A shift is under 48 hours, so detection starting this far back always starts outside
 * the run it might be inside — the same start, whatever window asked. */
const DETECTION_LEAD_MS = 2 * DAY;

export interface OeeResult {
  window: OeeWindow;
  from: string;
  to: string;
  daysCovered: number;
  availability: FactorState & { scheduledMinutes: number; availableMinutes: number | null };
  performance: FactorState & {
    breakdownMinutes: number; breakdownCount: number; openBreakdown: boolean;
    thresholdMinutes: number | null; parameterSource: ParameterSource | null; warning?: string;
  };
  quality: FactorState & {
    nominalFuel: number | null; actualFuel: number | null; unit: string | null;
    wasteFraction: number | null; wasteLitres: number | null; parameterSource: ParameterSource | null;
  };
  oee: FactorState;
}

export interface SiteOee {
  window: OeeWindow;
  from: string;
  to: string;
  daysCovered: number;
  availability: number | null;
  performance: number | null;
  quality: number | null;
  oee: number | null;
  machinesIncluded: number;
  /** Left out because their own OEE is not ready, by reason. */
  machinesExcluded: Record<string, number>;
  machines: (OeeResult & { sourceSystem: string; externalId: string })[];
}

/** UTC calendar day, ISO week (Monday) or month containing `at`, cut at `now`. */
export function windowBounds(window: OeeWindow, at: Date, now: Date): { from: Date; to: Date; daysCovered: number } {
  const day = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate());
  let from: number;
  let end: number;
  if (window === 'day') {
    from = day; end = day + DAY;
  } else if (window === 'week') {
    from = day - ((new Date(day).getUTCDay() + 6) % 7) * DAY; end = from + 7 * DAY;
  } else {
    from = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1);
    end = Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1);
  }
  const to = Math.min(end, now.getTime());
  if (to <= from) throw new BadRequestException('That window has not started yet.');
  // A partial window reports what it covers and does not extrapolate (§5).
  return { from: new Date(from), to: new Date(to), daysCovered: Math.ceil((to - from) / DAY) };
}

const SCOPE_NAME: Record<string, ParameterSource> = {
  equipment: 'equipment', equipment_class: 'class', site: 'site', client: 'client',
};

/**
 * OEE for a machine or a site (task QOEE1): Availability × Performance × Quality, each
 * factor dividing the one above it's numerator.
 *
 * Availability is Availability, unchanged: the same engine-state read and the same
 * `computeAvailability`. Breakdowns are detected here, written to `breakdown_event`,
 * and counted from those rows — so a threshold changed tomorrow changes no row already
 * written. Every factor sums its own numerator and denominator over the whole window;
 * nothing averages a daily ratio.
 */
@Injectable()
export class OeeService {
  private readonly reader = new TelemetryWindowReader();

  constructor(private readonly ds: DataSource) {}

  async forEquipment(
    scope: RequestScope, ref: { sourceSystem: string; externalId: string },
    window: OeeWindow, at: Date, now: Date = new Date(),
  ): Promise<OeeResult> {
    if (scope.equipmentIds !== undefined && !scope.equipmentIds.includes(ref.externalId)) {
      throw new NotFoundException('No such equipment in this account.');
    }
    const bounds = windowBounds(window, at, now);
    return withTenantSession(this.ds, scope, async (m) => {
      const profile = await this.profile(m, scope.tenantId, ref);
      return this.measure(m, scope.tenantId, profile, window, bounds, now);
    });
  }

  async breakdowns(
    scope: RequestScope, ref: { sourceSystem: string; externalId: string }, from: Date, to: Date,
    now: Date = new Date(),
  ): Promise<BreakdownEvent[]> {
    if (scope.equipmentIds !== undefined && !scope.equipmentIds.includes(ref.externalId)) {
      throw new NotFoundException('No such equipment in this account.');
    }
    return withTenantSession(this.ds, scope, async (m) => {
      const profile = await this.profile(m, scope.tenantId, ref);
      await this.detect(m, scope.tenantId, profile, from, now);
      return this.eventsIn(m, scope.tenantId, profile, from, to);
    });
  }

  /**
   * A site: the machines whose own OEE is ready, summed in minutes and litres — never an
   * average of per-machine ratios, the same rule as the window (§5) and as QPAGE1's
   * site rollup. The rest are counted by reason, so the number says what it covers.
   */
  async forSite(scope: RequestScope, plantId: string, window: OeeWindow, at: Date, now: Date = new Date()): Promise<SiteOee> {
    const bounds = windowBounds(window, at, now);
    return withTenantSession(this.ds, scope, async (m) => {
      const qb = m.getRepository(EquipmentProfile).createQueryBuilder('e')
        .where('e.tenant_id = :tenantId', { tenantId: scope.tenantId })
        .andWhere('e.plant_id = :plantId', { plantId })
        .andWhere(`e.status = 'active'`);
      if (scope.equipmentIds !== undefined) qb.andWhere('e.external_id = ANY(:ids)', { ids: [...scope.equipmentIds] });
      const profiles = await qb.orderBy('e.external_id', 'ASC').getMany();

      const machines: SiteOee['machines'] = [];
      for (const p of profiles) {
        const result = await this.measure(m, scope.tenantId, p, window, bounds, now);
        machines.push({ sourceSystem: p.sourceSystem, externalId: p.externalId, ...result });
      }
      const ready = machines.filter((x) => x.oee.readiness === 'ready');
      const excluded: Record<string, number> = {};
      for (const x of machines.filter((y) => y.oee.readiness !== 'ready')) {
        const reason = x.oee.reason ?? x.oee.readiness;
        excluded[reason] = (excluded[reason] ?? 0) + 1;
      }
      const sum = (pick: (x: OeeResult) => number | null) => ready.reduce((s, x) => s + (pick(x) ?? 0), 0);
      const scheduled = sum((x) => x.availability.scheduledMinutes);
      const available = sum((x) => x.availability.availableMinutes);
      const breakdown = sum((x) => x.performance.breakdownMinutes);
      const nominal = sum((x) => x.quality.nominalFuel);
      const actual = sum((x) => x.quality.actualFuel);
      const r4 = (v: number) => Math.round(v * 10_000) / 10_000;
      const availability = ready.length && scheduled > 0 ? r4(available / scheduled) : null;
      const performance = ready.length && available > 0 ? r4(Math.max(0, 1 - breakdown / available)) : null;
      const quality = ready.length && actual > 0 ? r4(Math.min(1, nominal / actual)) : null;
      return {
        window, from: bounds.from.toISOString(), to: bounds.to.toISOString(), daysCovered: bounds.daysCovered,
        availability, performance, quality,
        oee: availability !== null && performance !== null && quality !== null
          ? r4(availability * performance * quality) : null,
        machinesIncluded: ready.length, machinesExcluded: excluded, machines,
      };
    });
  }

  // ------------------------------------------------------------------------- inside

  private async profile(m: EntityManager, tenantId: string, ref: { sourceSystem: string; externalId: string }) {
    const profile = await m.getRepository(EquipmentProfile).findOne({
      where: { tenantId, sourceSystem: ref.sourceSystem, externalId: ref.externalId },
    });
    if (!profile) throw new NotFoundException('No such equipment in this account.');
    return profile;
  }

  private async measure(
    m: EntityManager, tenantId: string, profile: EquipmentProfile, window: OeeWindow,
    bounds: { from: Date; to: Date; daysCovered: number }, now: Date,
  ): Promise<OeeResult> {
    const period = { from: bounds.from, to: bounds.to };
    const head = {
      window, from: bounds.from.toISOString(), to: bounds.to.toISOString(), daysCovered: bounds.daysCovered,
    };
    const config = await this.configuration(m, tenantId, profile, bounds.to);
    const shifts = await this.shifts(m, tenantId, profile);
    const emptyPerformance = {
      breakdownMinutes: 0, breakdownCount: 0, openBreakdown: false,
      thresholdMinutes: config.threshold.value, parameterSource: config.threshold.source,
    };
    const emptyQuality = {
      nominalFuel: null, actualFuel: null, unit: config.nominal?.unit ?? null, wasteFraction: null, wasteLitres: null,
      parameterSource: config.nominal?.source ?? null,
    };
    const refuse = (readiness: Readiness, reason: string): FactorState => ({ value: null, readiness, reason });

    if (!shifts.length) {
      const none = refuse('not_configured', 'no_shift_schedule');
      return {
        ...head,
        availability: { ...none, scheduledMinutes: 0, availableMinutes: null },
        performance: { ...none, ...emptyPerformance },
        quality: { ...none, ...emptyQuality },
        oee: none,
      };
    }

    // ------------------------------------------------------------- availability
    const imeis = await this.projectionImeis(m, tenantId, profile);
    const engine = await readEngineState(this.reader, m, tenantId, imeis, period);
    const avail = computeAvailability(shifts, engine, period);
    const scheduledMinutes = avail.scheduledHours * 60;
    const availableMinutes = avail.uptimeHours === null ? null : avail.uptimeHours * 60;
    const availability: OeeResult['availability'] = {
      value: avail.availability,
      readiness: avail.readiness === 'ready' ? 'ready' : avail.readiness,
      ...(avail.reason ? { reason: avail.reason } : {}),
      scheduledMinutes, availableMinutes,
    };
    if (avail.readiness !== 'ready') {
      const blocked = refuse(availability.readiness, avail.reason ?? 'no_readings');
      return {
        ...head, availability,
        performance: { ...blocked, ...emptyPerformance },
        quality: { ...blocked, ...emptyQuality },
        oee: oeeOf([availability]),
      };
    }

    // -------------------------------------------------------------- performance
    let performance: OeeResult['performance'];
    let breakdownIntervals: Interval[] = [];
    let breakdownMinutes = 0;
    if (!config.runningSignal || !config.availabilitySignal) {
      performance = { ...refuse('not_configured', 'parameter_not_set'), ...emptyPerformance };
    } else if (scheduledMinutes < config.threshold.value) {
      performance = { ...refuse('blocked', 'insufficient_coverage'), ...emptyPerformance };
    } else {
      const bound = await this.boundSignals(m, tenantId, profile, [config.runningSignal, config.availabilitySignal], period);
      if (!bound.has(config.runningSignal) || !bound.has(config.availabilitySignal)) {
        performance = { ...refuse('not_configured', 'unbound'), ...emptyPerformance };
      } else {
        await this.detect(m, tenantId, profile, bounds.from, now, config, shifts);
        const events = await this.eventsIn(m, tenantId, profile, bounds.from, bounds.to);
        const windowSpan = { start: bounds.from.getTime(), end: bounds.to.getTime() };
        breakdownIntervals = events.map((e) => ({
          start: Math.max(e.startedAt.getTime(), windowSpan.start),
          end: Math.min((e.endedAt ?? bounds.to).getTime(), windowSpan.end),
        })).filter((i) => i.end > i.start);
        breakdownMinutes = events.reduce((s, e) => s + overlapMinutes(
          { start: e.startedAt.getTime(), end: (e.endedAt ?? now).getTime() }, windowSpan,
        ), 0);
        performance = {
          ...performanceOf(breakdownMinutes, availableMinutes ?? 0),
          breakdownMinutes: Math.round(breakdownMinutes * 100) / 100,
          breakdownCount: events.length,
          openBreakdown: events.some((e) => e.endedAt === null),
          thresholdMinutes: config.threshold.value, parameterSource: config.threshold.source,
        };
      }
    }

    // ------------------------------------------------------------------ quality
    let quality: OeeResult['quality'];
    if (!config.nominal) {
      quality = { ...refuse('not_configured', 'parameter_not_set'), ...emptyQuality };
    } else if (performance.value === null) {
      // Nominal is per productive hour, Performance's numerator: without it there is
      // nothing to multiply the nominal by.
      quality = { ...refuse(performance.readiness, performance.reason ?? 'not_available'), ...emptyQuality };
    } else {
      const fuel = await this.fuelBinding(m, tenantId, profile, period);
      if (!fuel) {
        quality = { ...refuse('not_configured', 'unbound'), ...emptyQuality };
      } else if (fuel.unit !== config.nominal.unit) {
        quality = {
          ...refuse('not_configured', 'unit_mismatch'), ...emptyQuality,
          unit: `nominal ${config.nominal.unit}, ${FUEL_RATE_SIGNAL} ${fuel.unit ?? 'no unit'}`,
        };
      } else {
        const rate = await this.readSamples(m, tenantId, profile, FUEL_RATE_SIGNAL, period.from, period.to);
        if (!rate.length) {
          quality = { ...refuse('blocked', 'stale'), ...emptyQuality };
        } else {
          const productive = subtract(operatingIntervals(shifts, engine, period), breakdownIntervals);
          const productiveMinutes = Math.max(0, (availableMinutes ?? 0) - breakdownMinutes);
          const actual = fuelBurned(rate, productive);
          const q = qualityOf(config.nominal.value, productiveMinutes, actual);
          quality = {
            ...q, actualFuel: Math.round(actual * 1000) / 1000, unit: config.nominal.unit.replace(/\/h$/, ''),
            parameterSource: config.nominal.source,
          };
        }
      }
    }

    return { ...head, availability, performance, quality, oee: oeeOf([availability, performance, quality]) };
  }

  /**
   * Per figure, most specific wins: equipment → class → site → client (QPARAM1's own
   * order) → the library class's OEM figure, read at the class version the machine is
   * on. The signals are the library's alone; a client does not rename its sensors.
   */
  private async configuration(m: EntityManager, tenantId: string, profile: EquipmentProfile, at: Date) {
    const oem = profile.equipmentClassSlug && profile.classVersion
      ? await m.getRepository(EquipmentClassProfile).findOne({
          where: { slug: profile.equipmentClassSlug, version: profile.classVersion },
        })
      : null;
    const resolved = await resolveParameters(
      m, tenantId, chainForEquipment(profile), ['nominal_fuel_per_hour', 'idle_breakdown_threshold_minutes'], at,
    );
    const pick = (name: string) => {
      const r = resolved.get(name);
      return r && typeof r.value === 'number'
        ? { value: r.value, unit: r.unit, source: SCOPE_NAME[r.source.scope] }
        : null;
    };
    const nominalParam = pick('nominal_fuel_per_hour');
    const thresholdParam = pick('idle_breakdown_threshold_minutes');
    const nominal = nominalParam
      ? { value: nominalParam.value, unit: nominalParam.unit ?? 'L/h', source: nominalParam.source }
      : oem?.nominalFuelPerHour != null
        ? { value: oem.nominalFuelPerHour, unit: oem.nominalFuelUnit!, source: 'oem' as ParameterSource }
        : null;
    const threshold = thresholdParam
      ? { value: thresholdParam.value, source: thresholdParam.source }
      : { value: oem?.idleBreakdownThresholdMinutes ?? 30, source: 'oem' as ParameterSource };
    return {
      nominal, threshold,
      runningSignal: oem?.runningSignal ?? null,
      idleBound: oem?.runningIdleBound ?? null,
      availabilitySignal: oem?.availabilitySignal ?? null,
    };
  }

  private shifts(m: EntityManager, tenantId: string, profile: EquipmentProfile) {
    return m.getRepository(EquipmentShift).find({
      where: { tenantId, sourceSystem: profile.sourceSystem, externalId: profile.externalId, status: 'active' },
    });
  }

  /** Availability's own device lookup, unchanged (QFIX-DEVICES-2 moves both together). */
  private async projectionImeis(m: EntityManager, tenantId: string, profile: EquipmentProfile): Promise<string[]> {
    const devices = await m.getRepository(DeviceProjection).find({
      where: { tenantId, equipmentExternalId: profile.externalId, sourceSystem: profile.sourceSystem },
    });
    return [...new Set(devices.map((d) => d.imei))];
  }

  private async boundSignals(
    m: EntityManager, tenantId: string, profile: EquipmentProfile, signals: string[], period: { from: Date; to: Date },
  ): Promise<Set<string>> {
    const segments = await bindingSegments(m, tenantId, profile, signals, { by: 'signalKey', componentId: '' });
    return new Set(overlapping(segments, period.from, period.to).map((s) => s.signal));
  }

  private async fuelBinding(
    m: EntityManager, tenantId: string, profile: EquipmentProfile, period: { from: Date; to: Date },
  ): Promise<{ unit: string | null } | null> {
    const rows = await m.getRepository(SignalBindingVersion).find({
      where: {
        tenantId, sourceSystem: profile.sourceSystem, externalId: profile.externalId,
        signalKey: FUEL_RATE_SIGNAL, componentId: '', isPrimary: true, status: 'active',
      },
      order: { validFrom: 'DESC' },
    });
    const inForce = rows.find((r) => r.validFrom <= period.to && (r.validTo === null || r.validTo > period.from));
    return inForce ? { unit: inForce.canonicalUnit } : null;
  }

  private async readSamples(
    m: EntityManager, tenantId: string, profile: EquipmentProfile, signal: string, from: Date, to: Date,
  ): Promise<Sample[]> {
    const segments = overlapping(
      await bindingSegments(m, tenantId, profile, [signal], { by: 'signalKey', componentId: '' }), from, to,
    );
    const bySignal = await this.reader.readSegments(
      m, tenantId, segments.map(({ signal: s, imei, from: f, to: t }) => ({ signal: s, imei, from: f, to: t })), from, to,
    );
    return (bySignal.get(signal) ?? []).map((r) => ({ at: r.at.getTime(), value: r.value }));
  }

  /**
   * Runs the detector from shortly before `from` to now and writes what it finds.
   * Idempotent: a start already written is left alone (`ON CONFLICT DO NOTHING`), so a
   * replay over the same telemetry writes nothing new, and two calls at once write each
   * event once. The only update is an open event closing.
   */
  private async detect(
    m: EntityManager, tenantId: string, profile: EquipmentProfile, from: Date, now: Date,
    config?: Awaited<ReturnType<OeeService['configuration']>>, shifts?: EquipmentShift[],
  ): Promise<void> {
    const cfg = config ?? await this.configuration(m, tenantId, profile, now);
    if (!cfg.runningSignal || !cfg.availabilitySignal || cfg.idleBound === null) return;
    const machineShifts = shifts ?? await this.shifts(m, tenantId, profile);
    if (!machineShifts.length) return;

    const start = new Date(from.getTime() - DETECTION_LEAD_MS);
    const span = { from: start, to: now };
    const [running, availability] = await Promise.all([
      this.readSamples(m, tenantId, profile, cfg.runningSignal, start, now),
      this.readSamples(m, tenantId, profile, cfg.availabilitySignal, start, now),
    ]);
    // The shifts' real bounds, not cut at now: the detector stops at `until` itself, and
    // needs to see whether the shift is still running then to call a run open.
    const scheduled = scheduledIntervals(machineShifts, { from: start, to: new Date(now.getTime() + DETECTION_LEAD_MS) });
    const detect = (thresholdMinutes: number) => detectBreakdowns({
      running: { signal: cfg.runningSignal!, samples: running, idleBound: cfg.idleBound! },
      availability: { signal: cfg.availabilitySignal!, samples: availability },
      scheduled, thresholdMinutes, until: now.getTime(),
    });
    const shiftOf = (t: number) => machineShifts.find((s) =>
      scheduledIntervals([s], span).some((i) => t >= i.start && t < i.end))?.id ?? null;

    for (const run of detect(cfg.threshold.value)) {
      const closed = !run.open;
      await m.query(
        `INSERT INTO "breakdown_event"
           ("tenant_id", "source_system", "external_id", "started_at", "ended_at", "duration_minutes",
            "shift_id", "threshold_minutes", "detected_from")
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
         ON CONFLICT ("tenant_id", "source_system", "external_id", "started_at") DO NOTHING`,
        [
          tenantId, profile.sourceSystem, profile.externalId, new Date(run.start),
          closed ? new Date(run.end) : null, closed ? Math.floor((run.end - run.start) / MINUTE) : null,
          shiftOf(run.start), cfg.threshold.value, JSON.stringify(run.detectedFrom),
        ],
      );
    }

    // Close what was open and has since ended. Judged on every idle run, whatever its
    // length: a row's own threshold decided it was a breakdown, and a later threshold
    // change must not leave it counting to now forever.
    const open = await m.getRepository(BreakdownEvent).find({
      where: { tenantId, sourceSystem: profile.sourceSystem, externalId: profile.externalId, endedAt: IsNull() },
    });
    if (!open.length) return;
    const runs = detect(0);
    for (const row of open) {
      const run = runs.find((r) => r.start === row.startedAt.getTime());
      if (!run || run.open) continue;
      await m.query(
        `UPDATE "breakdown_event" SET "ended_at" = $2, "duration_minutes" = $3
          WHERE "id" = $1 AND "ended_at" IS NULL`,
        [row.id, new Date(run.end), Math.max(row.thresholdMinutes, Math.floor((run.end - run.start) / MINUTE))],
      );
    }
  }

  private eventsIn(m: EntityManager, tenantId: string, profile: EquipmentProfile, from: Date, to: Date) {
    return m.getRepository(BreakdownEvent).createQueryBuilder('b')
      .where('b.tenant_id = :tenantId', { tenantId })
      .andWhere('b.source_system = :s AND b.external_id = :e', { s: profile.sourceSystem, e: profile.externalId })
      .andWhere('b.started_at < :to', { to })
      .andWhere('(b.ended_at IS NULL OR b.ended_at > :from)', { from })
      .orderBy('b.started_at', 'ASC')
      .getMany();
  }
}

