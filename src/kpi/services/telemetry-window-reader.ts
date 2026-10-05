import { EntityManager } from 'typeorm';
import { Reading } from '../../catalog/formula/baseline-operators';

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
