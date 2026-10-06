import { EntityManager } from 'typeorm';
import { Reading } from '../../catalog/formula/baseline-operators';

export interface BucketAggregate {
  bucket: Date;
  avg: number;
  min: number;
  max: number;
  sum: number;
  count: number;
  first: number;
  last: number;
}

/**
 * One device's tenure on one signal of one machine: the binding's IMEI, over the
 * binding's validity window `[from, to)` (task QFIX-DEVICES). A reading counts for this
 * machine only inside its segment — the device was somewhere else before and after.
 */
export interface TelemetrySegment {
  signal: string;
  imei: string;
  from: Date;
  /** Null: still bound. */
  to: Date | null;
}

const segmentParams = (segments: TelemetrySegment[]) => [
  segments.map((s) => s.signal), segments.map((s) => s.imei),
  segments.map((s) => s.from), segments.map((s) => s.to),
];

/** The segments joined as a set, so one query reads every (signal, device, window). */
const SEGMENTS_JOIN = `
  JOIN unnest($2::text[], $3::text[], $4::timestamptz[], $5::timestamptz[]) AS seg(signal, imei, seg_from, seg_to)
    ON r."signal" = seg.signal AND r."imei" = seg.imei
   AND r."source_timestamp" >= seg.seg_from AND (seg.seg_to IS NULL OR r."source_timestamp" < seg.seg_to)`;

/**
 * One query per `(imei[], signal[], window)`, never per signal (task QCE2 §3) —
 * a plan referencing several signals, or a page asking for twenty KPIs, shares
 * this single round trip rather than issuing one per widget.
 *
 * `source_timestamp` is bound on both ends so the partition-pruning QPART1 built
 * actually fires — see `explainPartitions` below, which is how that claim is
 * checked rather than assumed.
 */
export class TelemetryWindowReader {
  private static readonly QUERY = `
    SELECT "signal", "value", "source_timestamp" AS at
      FROM "telemetry_reading"
     WHERE "tenant_id" = $1 AND "imei" = ANY($2::text[]) AND "signal" = ANY($3::text[])
       AND "source_timestamp" >= $4 AND "source_timestamp" <= $5
     ORDER BY "signal", "source_timestamp" ASC`;

  async read(
    m: EntityManager, tenantId: string, imeis: string[], signals: string[], from: Date, to: Date,
  ): Promise<Map<string, Reading[]>> {
    const bySignal = new Map<string, Reading[]>();
    if (!imeis.length || !signals.length) return bySignal;

    const rows: { signal: string; value: string; at: Date }[] = await m.query(
      TelemetryWindowReader.QUERY, [tenantId, imeis, signals, from, to],
    );
    for (const r of rows) {
      const list = bySignal.get(r.signal) ?? [];
      list.push({ at: new Date(r.at), value: Number(r.value) });
      bySignal.set(r.signal, list);
    }
    return bySignal;
  }

  /**
   * The single latest reading per signal, unbounded on the early side (task
   * Q08S s3) — deliberately not window-bound, which is what makes it able to
   * tell `stale` (readings exist, none recently) apart from `no_readings`
   * (none ever). `read()`'s window-bound query cannot answer this: a reading
   * older than the window's lower bound is invisible to it, which is exactly
   * the conflation this method exists to avoid. One `DISTINCT ON` per
   * evaluation, not one per signal.
   */
  async latestPerSignal(
    m: EntityManager, tenantId: string, imeis: string[], signals: string[],
  ): Promise<Map<string, Date>> {
    const result = new Map<string, Date>();
    if (!imeis.length || !signals.length) return result;
    const rows: { signal: string; latest: Date }[] = await m.query(
      `SELECT DISTINCT ON ("signal") "signal", "source_timestamp" AS latest
         FROM "telemetry_reading"
        WHERE "tenant_id" = $1 AND "imei" = ANY($2::text[]) AND "signal" = ANY($3::text[])
        ORDER BY "signal", "source_timestamp" DESC`,
      [tenantId, imeis, signals],
    );
    for (const r of rows) result.set(r.signal, new Date(r.latest));
    return result;
  }

  private static readonly BUCKETED_QUERY = `
    SELECT "signal",
           to_timestamp(floor(extract(epoch from "source_timestamp") / $4::double precision) * $4::double precision)
             AS bucket,
           avg("value") AS avg, min("value") AS min, max("value") AS max, sum("value") AS sum,
           count(*) AS count,
           (array_agg("value" ORDER BY "source_timestamp" ASC))[1] AS first,
           (array_agg("value" ORDER BY "source_timestamp" DESC))[1] AS last
      FROM "telemetry_reading"
     WHERE "tenant_id" = $1 AND "imei" = ANY($2::text[]) AND "signal" = ANY($3::text[])
       AND "source_timestamp" >= $5 AND "source_timestamp" <= $6
     GROUP BY "signal", bucket
     ORDER BY "signal", bucket ASC`;

  /**
   * One bucket per signal per `bucketSeconds`, aggregated in the database
   * (task QCE2.1 §3) — never fetch every raw reading and bucket in Node, which
   * would move a whole window of rows across the wire to throw most of them
   * away. `source_timestamp` stays bound on both ends inside the same scan the
   * bucketing runs over, so partition pruning still fires — see
   * `explainBucketed`, which is how that claim is checked, not assumed.
   *
   * All seven per-bucket aggregates are computed unconditionally; the caller
   * picks which column answers its plan's own outer operator (§3's "aggregation
   * inside a bucket uses the plan's own operator") rather than this method
   * guessing which one matters.
   */
  async readBucketed(
    m: EntityManager, tenantId: string, imeis: string[], signals: string[],
    bucketSeconds: number, from: Date, to: Date,
  ): Promise<Map<string, BucketAggregate[]>> {
    const bySignal = new Map<string, BucketAggregate[]>();
    if (!imeis.length || !signals.length) return bySignal;

    const rows: {
      signal: string; bucket: Date; avg: string; min: string; max: string;
      sum: string; count: string; first: string; last: string;
    }[] = await m.query(
      TelemetryWindowReader.BUCKETED_QUERY, [tenantId, imeis, signals, bucketSeconds, from, to],
    );
    for (const r of rows) {
      const list = bySignal.get(r.signal) ?? [];
      list.push({
        bucket: new Date(r.bucket), avg: Number(r.avg), min: Number(r.min), max: Number(r.max),
        sum: Number(r.sum), count: Number(r.count), first: Number(r.first), last: Number(r.last),
      });
      bySignal.set(r.signal, list);
    }
    return bySignal;
  }

  // ------------------------------------------------- by binding (QFIX-DEVICES)
  // The same three reads, keyed by the signal's bindings instead of a device list.
  // A device list answers "which devices are on this machine now"; a binding answers
  // "which device produced this signal on this machine, and when" — the only form
  // that attributes history correctly when a device moves between machines.
  // `source_timestamp` stays bound on both ends of the outer scan, so pruning fires.

  async readSegments(
    m: EntityManager, tenantId: string, segments: TelemetrySegment[], from: Date, to: Date,
  ): Promise<Map<string, Reading[]>> {
    const bySignal = new Map<string, Reading[]>();
    if (!segments.length) return bySignal;
    const rows: { signal: string; value: string; at: Date }[] = await m.query(
      `SELECT r."signal", r."value", r."source_timestamp" AS at
         FROM "telemetry_reading" r ${SEGMENTS_JOIN}
        WHERE r."tenant_id" = $1 AND r."source_timestamp" >= $6 AND r."source_timestamp" <= $7
        ORDER BY r."signal", r."source_timestamp" ASC`,
      [tenantId, ...segmentParams(segments), from, to],
    );
    for (const r of rows) {
      const list = bySignal.get(r.signal) ?? [];
      list.push({ at: new Date(r.at), value: Number(r.value) });
      bySignal.set(r.signal, list);
    }
    return bySignal;
  }

  /** The latest reading per signal that this machine's bindings account for, up to
   * `at` — bounded below by the earliest binding, because a device's readings from
   * before it was fitted here belong to the machine it was on then. */
  async latestPerSignalInSegments(
    m: EntityManager, tenantId: string, segments: TelemetrySegment[], at: Date,
  ): Promise<Map<string, Date>> {
    const result = new Map<string, Date>();
    if (!segments.length) return result;
    const earliest = new Date(Math.min(...segments.map((s) => s.from.getTime())));
    const rows: { signal: string; latest: Date }[] = await m.query(
      `SELECT DISTINCT ON (r."signal") r."signal", r."source_timestamp" AS latest
         FROM "telemetry_reading" r ${SEGMENTS_JOIN}
        WHERE r."tenant_id" = $1 AND r."source_timestamp" >= $6 AND r."source_timestamp" <= $7
        ORDER BY r."signal", r."source_timestamp" DESC`,
      [tenantId, ...segmentParams(segments), earliest, at],
    );
    for (const r of rows) result.set(r.signal, new Date(r.latest));
    return result;
  }

  async readBucketedSegments(
    m: EntityManager, tenantId: string, segments: TelemetrySegment[],
    bucketSeconds: number, from: Date, to: Date,
  ): Promise<Map<string, BucketAggregate[]>> {
    const bySignal = new Map<string, BucketAggregate[]>();
    if (!segments.length) return bySignal;
    const rows: {
      signal: string; bucket: Date; avg: string; min: string; max: string;
      sum: string; count: string; first: string; last: string;
    }[] = await m.query(
      `SELECT r."signal",
              to_timestamp(floor(extract(epoch from r."source_timestamp") / $8::double precision) * $8::double precision)
                AS bucket,
              avg(r."value") AS avg, min(r."value") AS min, max(r."value") AS max, sum(r."value") AS sum,
              count(*) AS count,
              (array_agg(r."value" ORDER BY r."source_timestamp" ASC))[1] AS first,
              (array_agg(r."value" ORDER BY r."source_timestamp" DESC))[1] AS last
         FROM "telemetry_reading" r ${SEGMENTS_JOIN}
        WHERE r."tenant_id" = $1 AND r."source_timestamp" >= $6 AND r."source_timestamp" <= $7
        GROUP BY r."signal", bucket
        ORDER BY r."signal", bucket ASC`,
      [tenantId, ...segmentParams(segments), from, to, bucketSeconds],
    );
    for (const r of rows) {
      const list = bySignal.get(r.signal) ?? [];
      list.push({
        bucket: new Date(r.bucket), avg: Number(r.avg), min: Number(r.min), max: Number(r.max),
        sum: Number(r.sum), count: Number(r.count), first: Number(r.first), last: Number(r.last),
      });
      bySignal.set(r.signal, list);
    }
    return bySignal;
  }

  /** Same partition-pruning check as `explainPartitions`, for the bucketed
   * query (task QCE2.1 §6). */
  async explainBucketed(
    m: EntityManager, tenantId: string, imeis: string[], signals: string[],
    bucketSeconds: number, from: Date, to: Date,
  ): Promise<{ partitions: string[]; planText: string }> {
    const rows: { 'QUERY PLAN': string }[] = await m.query(
      `EXPLAIN (FORMAT TEXT) ${TelemetryWindowReader.BUCKETED_QUERY}`,
      [tenantId, imeis, signals, bucketSeconds, from, to],
    );
    const planText = rows.map((r) => r['QUERY PLAN']).join('\n');
    const partitions = [...new Set(
      [...planText.matchAll(/telemetry_reading_(\d{4}_\d{2})/g)].map((m2) => m2[1]),
    )].sort();
    return { partitions, planText };
  }

  /** Runs `EXPLAIN` on the exact query `read()` issues and names which monthly
   * partitions it touched — reported in QCE2's §3, not assumed from the shape of
   * the SQL. A query that touches every partition is a pruning bug, not a detail
   * to note in passing. */
  async explainPartitions(
    m: EntityManager, tenantId: string, imeis: string[], signals: string[], from: Date, to: Date,
  ): Promise<{ partitions: string[]; planText: string }> {
    const rows: { 'QUERY PLAN': string }[] = await m.query(
      `EXPLAIN (FORMAT TEXT) ${TelemetryWindowReader.QUERY}`,
      [tenantId, imeis, signals, from, to],
    );
    const planText = rows.map((r) => r['QUERY PLAN']).join('\n');
    const partitions = [...new Set(
      [...planText.matchAll(/telemetry_reading_(\d{4}_\d{2})/g)].map((m2) => m2[1]),
    )].sort();
    return { partitions, planText };
  }
}
