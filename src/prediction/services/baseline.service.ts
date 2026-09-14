import { Injectable, Logger } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { RequestScope } from '../../auth/types/request-scope';
import { withTenantSession } from '../../scope/tenant-session';
import { DeviceProjection } from '../../projection/entities/device-projection.entity';
import { BaselineSource, PredictionBaseline } from '../entities/prediction-baseline.entity';

/** Thirty days of history is the default reference for a Tier 1 z-score. */
export const DEFAULT_WINDOW_DAYS = 30;

export interface BaselineTarget {
  sourceSystem: string;
  externalId: string;
}

interface AggregateRow {
  signal: string;
  mean: string;
  stddev: string;
  sample_count: number;
  first_at: Date;
  last_at: Date;
  days_with_data: number;
  live_count: number;
  other_count: number;
}

/**
 * Rebuilding what normal looks like, from telemetry (task P1-13).
 *
 * The whole computation is one grouped query rather than a fetch and a loop in
 * TypeScript. That is not only speed: a thirty-day window on a chatty logger is
 * hundreds of thousands of rows, and pulling them through the application to average
 * them is how a scheduled refresh turns into an outage on the day a customer adds a
 * second-resolution device.
 *
 * Idempotent by construction. Recomputing the same window writes the same numbers to
 * the same row, so a refresh that runs twice — or a replay that triggers one — leaves
 * the same state as running it once.
 */
@Injectable()
export class BaselineService {
  private readonly logger = new Logger(BaselineService.name);

  constructor(private readonly ds: DataSource) {}

  async refresh(
    scope: RequestScope,
    target: BaselineTarget,
    windowDays: number = DEFAULT_WINDOW_DAYS,
    now: Date = new Date(),
  ): Promise<PredictionBaseline[]> {
    const from = new Date(now.getTime() - windowDays * 86_400_000);

    return withTenantSession(this.ds, scope, async (m) => {
      const imeis = await this.imeisFor(m, scope, target);
      if (imeis.length === 0) {
        this.logger.debug(`No device on ${target.externalId}; nothing to baseline.`);
        return [];
      }

      const rows: AggregateRow[] = await m.query(
        `SELECT "signal",
                avg("value")                                            AS mean,
                coalesce(stddev_samp("value"), 0)                        AS stddev,
                count(*)::int                                            AS sample_count,
                min("source_timestamp")                                  AS first_at,
                max("source_timestamp")                                  AS last_at,
                count(DISTINCT date_trunc('day', "source_timestamp"))::int AS days_with_data,
                count(*) FILTER (WHERE "source" = 'live')::int            AS live_count,
                count(*) FILTER (WHERE "source" <> 'live')::int           AS other_count
           FROM "telemetry_reading"
          WHERE "tenant_id" = $1
            AND "imei" = ANY($2::text[])
            AND "source_timestamp" >= $3
            AND "source_timestamp" <= $4
          GROUP BY "signal"`,
        [scope.tenantId, imeis, from, now],
      );

      const written: PredictionBaseline[] = [];
      for (const r of rows) {
        written.push(
          await this.upsert(m, scope, target, windowDays, r, now),
        );
      }
      return written;
    });
  }

  /**
   * The asset's signals are the signals of the devices fitted to it, which is a join
   * away from the sensor map — the map is keyed by IMEI and knows nothing about
   * machines.
   */
  private async imeisFor(
    m: EntityManager, scope: RequestScope, target: BaselineTarget,
  ): Promise<string[]> {
    const devices = await m.getRepository(DeviceProjection).find({
      where: {
        tenantId: scope.tenantId,
        sourceSystem: target.sourceSystem,
        equipmentExternalId: target.externalId,
      },
    });
    return [...new Set(devices.map((d) => d.imei))];
  }

  private async upsert(
    m: EntityManager,
    scope: RequestScope,
    target: BaselineTarget,
    windowDays: number,
    r: AggregateRow,
    now: Date,
  ): Promise<PredictionBaseline> {
    // Days with any reading, over days in the window. Not sample count: a logger
    // reporting every second for one afternoon produces a large sample covering
    // almost nothing, and the two look identical from a count alone.
    const coverageRatio = Math.min(1, r.days_with_data / windowDays);

    const source: BaselineSource =
      r.other_count === 0 ? 'live' : r.live_count === 0 ? 'replayed' : 'mixed';

    const [row]: PredictionBaseline[] = await m.query(
      `INSERT INTO "prediction_baseline"
         ("tenant_id", "source_system", "external_id", "signal", "window_days",
          "mean", "stddev", "sample_count", "coverage_ratio",
          "first_sample_at", "last_sample_at", "source", "computed_at")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT ("tenant_id", "source_system", "external_id", "signal", "window_days")
       DO UPDATE SET
         "mean" = EXCLUDED."mean",
         "stddev" = EXCLUDED."stddev",
         "sample_count" = EXCLUDED."sample_count",
         "coverage_ratio" = EXCLUDED."coverage_ratio",
         "first_sample_at" = EXCLUDED."first_sample_at",
         "last_sample_at" = EXCLUDED."last_sample_at",
         "source" = EXCLUDED."source",
         "computed_at" = EXCLUDED."computed_at"
       RETURNING
         "id", "tenant_id" AS "tenantId", "source_system" AS "sourceSystem",
         "external_id" AS "externalId", "signal", "window_days" AS "windowDays",
         "mean", "stddev", "sample_count" AS "sampleCount",
         "coverage_ratio" AS "coverageRatio", "first_sample_at" AS "firstSampleAt",
         "last_sample_at" AS "lastSampleAt", "source", "computed_at" AS "computedAt"`,
      [
        scope.tenantId, target.sourceSystem, target.externalId, r.signal, windowDays,
        Number(r.mean), Number(r.stddev), r.sample_count, coverageRatio,
        r.first_at, r.last_at, source, now,
      ],
    );
    return row;
  }

  /** Everything known about an asset's normal, for one window. */
  async forAsset(
    scope: RequestScope, target: BaselineTarget, windowDays: number = DEFAULT_WINDOW_DAYS,
  ): Promise<PredictionBaseline[]> {
    return withTenantSession(this.ds, scope, (m) =>
      m.getRepository(PredictionBaseline).find({
        where: {
          tenantId: scope.tenantId,
          sourceSystem: target.sourceSystem,
          externalId: target.externalId,
          windowDays,
        },
        order: { signal: 'ASC' },
      }),
    );
  }
}
