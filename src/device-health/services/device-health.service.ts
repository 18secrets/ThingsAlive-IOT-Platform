import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { RequestScope } from '../../auth/types/request-scope';
import { EquipmentProfile } from '../../equipment/equipment-profile.entity';
import { withTenantId, withTenantSession } from '../../scope/tenant-session';
import { DeviceLinkHealth } from '../entities/device-link-health.entity';
import { LinkHealth, LinkState } from '../services/link-health';

export interface RecordInput {
  tenantId: string;
  imei: string;
  sourceSystem: string;
  externalId: string;
  localDate: string;
  health: LinkHealth;
}

export interface FleetLinkRow {
  imei: string;
  externalId: string;
  state: LinkState;
  detail: string;
  windowStart: Date;
  windowEnd: Date;
  /** Consecutive windows ending here that carried this same state. */
  windowsInState: number;
  signalBand: string | null;
  signalWorstBand: string | null;
  longestGapSeconds: number | null;
  medianLagSeconds: number | null;
  missingSignals: string[];
}

/** How far back the fleet view looks when nobody says otherwise. */
export const DEFAULT_LOOK_BACK_DAYS = 7;

/**
 * Storing a link verdict, and answering "which of my loggers is in trouble" (P4-08).
 *
 * The fleet view returns the newest window per device rather than every window, because
 * the question is about now. What it adds to that is `windowsInState`: a device dark
 * for one window may be a machine parked in a shed over a weekend, and the same device
 * dark for nine is a site visit. The number is what separates the two, and without it
 * every Monday morning produces a list of alarms that resolve themselves by lunchtime.
 */
@Injectable()
export class DeviceHealthService {
  private readonly logger = new Logger(DeviceHealthService.name);

  constructor(private readonly ds: DataSource) {}

  async record(input: RecordInput): Promise<DeviceLinkHealth> {
    return withTenantId(this.ds, input.tenantId, async (m) => {
      const profile = await m.getRepository(EquipmentProfile).findOne({
        where: {
          tenantId: input.tenantId,
          sourceSystem: input.sourceSystem,
          externalId: input.externalId,
        },
      });

      const h = input.health;
      const row = {
        tenantId: input.tenantId,
        imei: input.imei,
        sourceSystem: input.sourceSystem,
        externalId: input.externalId,
        plantId: profile?.plantId ?? null,
        localDate: input.localDate,
        windowStart: h.windowStart,
        windowEnd: h.windowEnd,
        state: h.state,
        detail: h.detail,
        signalScale: h.signal.scale,
        signalMedian: h.signal.median,
        signalWorst: h.signal.worst,
        // A band without a scale is a verdict nobody can interpret, and the database
        // refuses it. Kept consistent here so the refusal never has to fire.
        signalBand: h.signal.scale ? h.signal.band : null,
        signalWorstBand: h.signal.scale ? h.signal.worstBand : null,
        longestGapSeconds: h.longestGapSeconds,
        medianLagSeconds: h.medianLagSeconds,
        maxLagSeconds: h.maxLagSeconds,
        reportedSignals: h.reportedSignals,
        missingSignals: h.missingSignals,
        samples: h.samples,
        computedAt: new Date(),
      };

      await m.createQueryBuilder().insert().into(DeviceLinkHealth).values(row)
        .orUpdate(
          [
            'source_system', 'external_id', 'plant_id', 'local_date', 'window_end',
            'state', 'detail', 'signal_scale', 'signal_median', 'signal_worst',
            'signal_band', 'signal_worst_band', 'longest_gap_seconds',
            'median_lag_seconds', 'max_lag_seconds', 'reported_signals',
            'missing_signals', 'samples', 'computed_at',
          ],
          ['tenant_id', 'imei', 'window_start'],
        ).execute();

      return m.getRepository(DeviceLinkHealth).findOneOrFail({
        where: { tenantId: input.tenantId, imei: input.imei, windowStart: h.windowStart },
      });
    });
  }

  /** Every window for one device, newest first. */
  async forDevice(scope: RequestScope, imei: string, take = 50): Promise<DeviceLinkHealth[]> {
    return withTenantSession(this.ds, scope, async (m) => {
      const rows = await m.getRepository(DeviceLinkHealth).find({
        where: { tenantId: scope.tenantId, imei },
        order: { windowStart: 'DESC' },
        take,
      });
      // A device's history is only visible to somebody who may see the machine it is
      // on. Narrowed after the read rather than in it, because the assignment is per
      // machine and a logger can have moved between them mid-history.
      if (scope.equipmentIds === undefined) return rows;
      return rows.filter((r) => scope.equipmentIds!.includes(r.externalId));
    });
  }

  /**
   * The newest window per device, with how long it has been in that state.
   *
   * One query rather than one per device: a fleet of four hundred loggers would
   * otherwise be four hundred round trips to build one screen.
   */
  async fleet(
    scope: RequestScope,
    options: { states?: LinkState[]; sinceDays?: number } = {},
    now = new Date(),
  ): Promise<FleetLinkRow[]> {
    const since = new Date(
      now.getTime() - (options.sinceDays ?? DEFAULT_LOOK_BACK_DAYS) * 86400_000,
    );

    return withTenantSession(this.ds, scope, async (m) => {
      const params: unknown[] = [scope.tenantId, since];
      let assetFilter = '';
      if (scope.equipmentIds !== undefined) {
        params.push(scope.equipmentIds);
        assetFilter = ` AND "external_id" = ANY($${params.length}::text[])`;
      }

      /*
       * The run length is computed with a gaps-and-islands count: for each device,
       * number the windows newest-first, and number them again partitioned by state.
       * The difference between the two only stays constant while the state does, so
       * counting rows sharing the newest window's difference gives the current run.
       *
       * Done in SQL rather than in TypeScript because the alternative is fetching
       * every window for every device to count a handful of rows at the end of each.
       */
      const rows = await m.query(
        `WITH windows AS (
           SELECT "imei", "external_id", "state", "detail", "window_start", "window_end",
                  "signal_band", "signal_worst_band", "longest_gap_seconds",
                  "median_lag_seconds", "missing_signals",
                  row_number() OVER (PARTITION BY "imei" ORDER BY "window_start" DESC) AS rn,
                  row_number() OVER (
                    PARTITION BY "imei", "state" ORDER BY "window_start" DESC
                  ) AS rn_state
             FROM "device_link_health"
            WHERE "tenant_id" = $1 AND "window_start" >= $2${assetFilter}
         ),
         latest AS (
           SELECT * FROM windows WHERE rn = 1
         )
         SELECT l."imei", l."external_id", l."state", l."detail",
                l."window_start", l."window_end", l."signal_band", l."signal_worst_band",
                l."longest_gap_seconds", l."median_lag_seconds", l."missing_signals",
                (SELECT count(*)::int FROM windows w
                  WHERE w."imei" = l."imei" AND w."state" = l."state"
                    AND w.rn - w.rn_state = l.rn - l.rn_state) AS windows_in_state
           FROM latest l
          ORDER BY l."window_start" DESC`,
        params,
      );

      const out: FleetLinkRow[] = rows.map((r: Record<string, unknown>) => ({
        imei: String(r.imei),
        externalId: String(r.external_id),
        state: r.state as LinkState,
        detail: String(r.detail),
        windowStart: new Date(r.window_start as string),
        windowEnd: new Date(r.window_end as string),
        windowsInState: Number(r.windows_in_state ?? 1),
        signalBand: r.signal_band === null ? null : String(r.signal_band),
        signalWorstBand: r.signal_worst_band === null ? null : String(r.signal_worst_band),
        longestGapSeconds: r.longest_gap_seconds === null ? null : Number(r.longest_gap_seconds),
        medianLagSeconds: r.median_lag_seconds === null ? null : Number(r.median_lag_seconds),
        missingSignals: (r.missing_signals as string[]) ?? [],
      }));

      const wanted = options.states;
      const filtered = wanted?.length ? out.filter((r) => wanted.includes(r.state)) : out;

      // Worst first, and within a state the longest-standing first — a logger dark for
      // nine windows is a different errand from one dark since this morning.
      const RANK: Record<LinkState, number> = {
        dark: 0, partial: 1, intermittent: 2, 'weak-signal': 3, buffering: 4,
        unknown: 5, healthy: 6,
      };
      return filtered.sort((a, b) => {
        const d = (RANK[a.state] ?? 9) - (RANK[b.state] ?? 9);
        return d !== 0 ? d : b.windowsInState - a.windowsInState;
      });
    });
  }
}
