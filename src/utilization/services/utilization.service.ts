import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { RequestScope } from '../../auth/types/request-scope';
import { EquipmentProfile } from '../../equipment/equipment-profile.entity';
import { withTenantId, withTenantSession } from '../../scope/tenant-session';
import { UtilizationShift } from '../entities/utilization-shift.entity';
import { DutyCycle } from './duty-cycle';

export interface RecordInput {
  tenantId: string;
  shiftId: string;
  shiftName: string;
  sourceSystem: string;
  externalId: string;
  localDate: string;
  duty: DutyCycle;
}

export interface Range {
  from?: Date;
  to?: Date;
}

export type GroupBy = 'equipment' | 'plant' | 'date' | 'shift';

export interface SummaryRow {
  key: string | null;
  shifts: number;
  totalSeconds: number;
  productiveSeconds: number;
  idleSeconds: number;
  runningUnclassifiedSeconds: number;
  offSeconds: number;
  unknownSeconds: number;
  engineOnSeconds: number;
  coverage: number;
  utilizationRate: number | null;
  productiveRate: number | null;
  /** Shifts where nothing described the machine at all. */
  unobservedShifts: number;
}

/**
 * Writing duty cycle down, and adding it up (task P4-05).
 *
 * The adding up is the part with a trap in it. A month's utilization for a machine is
 * not the average of its daily rates: a four-hour Saturday shift worked flat out and
 * a twelve-hour Monday spent idling are not two numbers to average, and doing so
 * hands a Saturday three times the weight it earned. Every rate here is recomputed
 * from summed seconds for that reason, and the per-shift rates on the rows are for
 * reading a single day rather than for rolling up.
 */
@Injectable()
export class UtilizationService {
  private readonly logger = new Logger(UtilizationService.name);

  constructor(private readonly ds: DataSource) {}

  /**
   * Store one window's measurement, replacing any earlier one for the same window.
   *
   * The plant and class are resolved here and copied onto the row. If the machine is
   * not in the register yet the row is still written with nulls: a utilization report
   * that silently omits uncommissioned machines is worse than one with a gap in the
   * site column, because the machines missing from it are the ones nobody is watching.
   */
  async record(input: RecordInput): Promise<UtilizationShift> {
    return withTenantId(this.ds, input.tenantId, async (m) => {
      const profile = await m.getRepository(EquipmentProfile).findOne({
        where: {
          tenantId: input.tenantId,
          sourceSystem: input.sourceSystem,
          externalId: input.externalId,
        },
      });

      const d = input.duty;
      const row = {
        tenantId: input.tenantId,
        shiftId: input.shiftId,
        shiftName: input.shiftName,
        sourceSystem: input.sourceSystem,
        externalId: input.externalId,
        plantId: profile?.plantId ?? null,
        equipmentClassSlug: profile?.equipmentClassSlug ?? null,
        localDate: input.localDate,
        windowStart: d.windowStart,
        windowEnd: d.windowEnd,
        totalSeconds: d.totalSeconds,
        productiveSeconds: d.productiveSeconds,
        idleSeconds: d.idleSeconds,
        runningUnclassifiedSeconds: d.runningUnclassifiedSeconds,
        offSeconds: d.offSeconds,
        unknownSeconds: d.unknownSeconds,
        engineOnSeconds: d.engineOnSeconds,
        carrySeconds: d.carrySeconds,
        coverage: d.coverage,
        utilizationRate: d.utilizationRate,
        productiveRate: d.productiveRate,
        idleRate: d.idleRate,
        runtimeDelta: d.runtimeDelta,
        runtimeUnit: d.runtimeUnit,
        runtimeCounterReset: d.runtimeCounterReset,
        samples: d.samples,
        signalsPresent: d.signalsPresent,
        computedAt: new Date(),
      };

      // Upsert on the window, not on the id. Late telemetry rewinds a window and it
      // is measured again; the second measurement is the same shift seen properly,
      // and it replaces the first rather than sitting beside it.
      await m
        .createQueryBuilder()
        .insert()
        .into(UtilizationShift)
        .values(row)
        .orUpdate(
          [
            'shift_name', 'plant_id', 'equipment_class_slug', 'local_date', 'window_end',
            'total_seconds', 'productive_seconds', 'idle_seconds',
            'running_unclassified_seconds', 'off_seconds', 'unknown_seconds',
            'engine_on_seconds', 'carry_seconds', 'coverage', 'utilization_rate',
            'productive_rate', 'idle_rate', 'runtime_delta', 'runtime_unit',
            'runtime_counter_reset', 'samples', 'signals_present', 'computed_at',
          ],
          ['tenant_id', 'source_system', 'external_id', 'shift_id', 'window_start'],
        )
        .execute();

      return (await m.getRepository(UtilizationShift).findOneOrFail({
        where: {
          tenantId: input.tenantId,
          sourceSystem: input.sourceSystem,
          externalId: input.externalId,
          shiftId: input.shiftId,
          windowStart: d.windowStart,
        },
      }));
    });
  }

  /** The shift-by-shift record for one machine, newest first. */
  async forEquipment(
    scope: RequestScope,
    ref: { sourceSystem: string; externalId: string },
    range: Range = {},
    take = 100,
  ): Promise<UtilizationShift[]> {
    // Undefined is unrestricted, [] matches nothing. The same rule everywhere.
    if (scope.equipmentIds !== undefined && !scope.equipmentIds.includes(ref.externalId)) {
      return [];
    }
    return withTenantSession(this.ds, scope, (m) => {
      const qb = m.getRepository(UtilizationShift).createQueryBuilder('u')
        .where('u.tenant_id = :tenantId', { tenantId: scope.tenantId })
        .andWhere('u.source_system = :sourceSystem', { sourceSystem: ref.sourceSystem })
        .andWhere('u.external_id = :externalId', { externalId: ref.externalId });
      if (range.from) qb.andWhere('u.window_start >= :from', { from: range.from });
      if (range.to) qb.andWhere('u.window_start < :to', { to: range.to });
      return qb.orderBy('u.window_start', 'DESC').take(take).getMany();
    });
  }

  /**
   * Hours rolled up by machine, site, day or shift.
   *
   * `groupBy` chooses a column from a fixed map rather than being interpolated: the
   * value arrives from a query string, and a grouping key is the one part of this
   * query that cannot be a bind parameter.
   */
  async summary(
    scope: RequestScope,
    options: Range & { groupBy: GroupBy; plantId?: string } = { groupBy: 'equipment' },
  ): Promise<SummaryRow[]> {
    const COLUMN: Record<GroupBy, string> = {
      equipment: 'external_id',
      plant: 'plant_id::text',
      date: 'local_date',
      shift: 'shift_name',
    };
    const column = COLUMN[options.groupBy];
    if (!column) throw new Error(`Cannot group utilization by "${options.groupBy}".`);

    return withTenantSession(this.ds, scope, async (m) => {
      const params: unknown[] = [scope.tenantId];
      const where = ['"tenant_id" = $1'];

      if (options.from) { params.push(options.from); where.push(`"window_start" >= $${params.length}`); }
      if (options.to) { params.push(options.to); where.push(`"window_start" < $${params.length}`); }
      if (options.plantId) { params.push(options.plantId); where.push(`"plant_id" = $${params.length}::uuid`); }
      // An operator sees their own machines and a manager sees the ones assigned to
      // them. An empty list is not "no filter" — it is a caller entitled to nothing,
      // and `= ANY('{}')` is the honest translation of that.
      if (scope.equipmentIds !== undefined) {
        params.push(scope.equipmentIds);
        where.push(`"external_id" = ANY($${params.length}::text[])`);
      }

      const rows = await m.query(
        `SELECT ${column} AS key,
                count(*)::int AS shifts,
                count(*) FILTER (WHERE "coverage" = 0)::int AS unobserved_shifts,
                sum("total_seconds") AS total_seconds,
                sum("productive_seconds") AS productive_seconds,
                sum("idle_seconds") AS idle_seconds,
                sum("running_unclassified_seconds") AS running_unclassified_seconds,
                sum("off_seconds") AS off_seconds,
                sum("unknown_seconds") AS unknown_seconds,
                sum("engine_on_seconds") AS engine_on_seconds
           FROM "utilization_shift"
          WHERE ${where.join(' AND ')}
          GROUP BY ${column}
          ORDER BY sum("engine_on_seconds") DESC NULLS LAST`,
        params,
      );

      return rows.map((r: Record<string, string | number | null>) => this.rates(r));
    });
  }

  /**
   * Rates from summed seconds, never from averaged rates.
   *
   * Averaging the per-shift numbers would weight a four-hour Saturday the same as a
   * twelve-hour Monday. It is the kind of wrong that survives review because every
   * individual row is right.
   */
  private rates(r: Record<string, string | number | null>): SummaryRow {
    const n = (key: string): number => Number(r[key] ?? 0);

    const productiveSeconds = n('productive_seconds');
    const idleSeconds = n('idle_seconds');
    const engineOnSeconds = n('engine_on_seconds');
    const offSeconds = n('off_seconds');
    const totalSeconds = n('total_seconds');
    const observed = engineOnSeconds + offSeconds;
    const classifiedRunning = productiveSeconds + idleSeconds;
    const round = (x: number) => Math.round(x * 1000) / 1000;

    return {
      key: r.key === null || r.key === undefined ? null : String(r.key),
      shifts: n('shifts'),
      unobservedShifts: n('unobserved_shifts'),
      totalSeconds: round(totalSeconds),
      productiveSeconds: round(productiveSeconds),
      idleSeconds: round(idleSeconds),
      runningUnclassifiedSeconds: round(n('running_unclassified_seconds')),
      offSeconds: round(offSeconds),
      unknownSeconds: round(n('unknown_seconds')),
      engineOnSeconds: round(engineOnSeconds),
      coverage: totalSeconds > 0 ? round(observed / totalSeconds) : 0,
      utilizationRate: observed > 0 ? round(engineOnSeconds / observed) : null,
      productiveRate: classifiedRunning > 0 ? round(productiveSeconds / classifiedRunning) : null,
    };
  }
}
