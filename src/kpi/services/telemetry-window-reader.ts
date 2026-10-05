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
