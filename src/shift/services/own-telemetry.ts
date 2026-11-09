import { DataSource } from 'typeorm';
import { LateArrival, LateArrivalRequest, MAX_READINGS_PER_PULL, PullRequest, PullResult } from '../../legacy/legacy-telemetry.reader';
import { TELEMETRY_READING_V1 } from '../../projection/contracts/contracts';
import { withTenantId } from '../../scope/tenant-session';

/**
 * A shift window's readings from 2.0's own `telemetry_reading`, for when there is no
 * connection to the existing platform — the shape `LegacyTelemetryReader.pull` returns,
 * so the runner scores either the same way.
 *
 * Readings reach 2.0 without that connection too: a logger or stream posting straight
 * to ingest (the demo pushes every 30 seconds), and history uploaded per machine. Before
 * this, a deployment with no legacy route scored none of them, however fresh. They are
 * read through the machine's bindings, as every other reader does (QFIX-DEVICES): a
 * device's readings count for this machine only while a primary, active binding had it
 * here — by device, as the Tier 1 scorer and baseline read (`boundImeis`), so the window
 * the runner hands them is the window they would read themselves.
 *
 * Same window as the legacy pull: after `from`, up to and including `to`. Already stored,
 * so the runner does not ingest them again.
 */
export async function pullOwnTelemetry(ds: DataSource, request: PullRequest): Promise<PullResult> {
  const rows: { imei: string; signal: string; value: number; unit: string | null; source_timestamp: Date; source: string }[] =
    await withTenantId(ds, request.tenantId, (m) => m.query(
      `SELECT r."imei", r."signal", r."value", r."unit", r."source_timestamp", r."source"
         FROM "telemetry_reading" r
        WHERE r."tenant_id" = $1
          AND r."source_timestamp" > $4 AND r."source_timestamp" <= $5
          AND EXISTS (
            SELECT 1 FROM "signal_binding_version" b
             WHERE b."tenant_id" = r."tenant_id" AND b."source_system" = $2 AND b."external_id" = $3
               AND b."imei" = r."imei"
               AND b."is_primary" AND b."status" = 'active'
               AND r."source_timestamp" >= b."valid_from"
               AND (b."valid_to" IS NULL OR r."source_timestamp" < b."valid_to"))
        ORDER BY r."source_timestamp"
        LIMIT ${MAX_READINGS_PER_PULL}`,
      [request.tenantId, request.sourceSystem, request.externalId, request.from, request.to],
    ));
  if (!rows.length) return { envelope: null, reason: 'no-readings' };
  return {
    envelope: {
      contract: TELEMETRY_READING_V1,
      sourceSystem: request.sourceSystem,
      // Not ingested again, so this labels nothing; it says what the window was made of.
      source: rows.some((r) => r.source === 'live') ? 'live' : 'replayed',
      readings: rows.map((r) => ({
        imei: r.imei, signal: r.signal, value: Number(r.value), unit: r.unit ?? undefined,
        sourceTimestamp: new Date(r.source_timestamp).toISOString(),
      })),
    } as PullResult['envelope'],
  };
}

/**
 * Which loggers this machine had during the window, and the signals each was bound to
 * carry — the link check's list of what should have reported, for a window scored from
 * 2.0's own readings.
 *
 * The existing platform's sensor map knows only the loggers it registered. A logger
 * commissioned in 2.0 is known by its bindings alone, so without this its machine never
 * got a link verdict at all — every card said "no link data" while the logger reported
 * every ten minutes. Same rule as the readings above: primary, active, and bound to this
 * machine at some point inside the window.
 */
export async function ownExpectedSignals(ds: DataSource, request: PullRequest): Promise<Map<string, string[]>> {
  const rows: { imei: string; signal_key: string }[] = await withTenantId(ds, request.tenantId, (m) => m.query(
    `SELECT DISTINCT b."imei", b."signal_key"
       FROM "signal_binding_version" b
      WHERE b."tenant_id" = $1 AND b."source_system" = $2 AND b."external_id" = $3
        AND b."imei" IS NOT NULL AND b."is_primary" AND b."status" = 'active'
        AND b."valid_from" < $5 AND (b."valid_to" IS NULL OR b."valid_to" > $4)
      ORDER BY 1, 2`,
    [request.tenantId, request.sourceSystem, request.externalId, request.from, request.to],
  ));
  const byImei = new Map<string, string[]>();
  for (const r of rows) byImei.set(r.imei, [...(byImei.get(r.imei) ?? []), r.signal_key]);
  return byImei;
}

/**
 * Readings that reached 2.0 directly after the shift's arrivals watermark — the
 * counterpart of `LegacyTelemetryReader.lateArrivals` for a machine whose loggers post
 * to 2.0 itself (G06: a late reading revises an outcome).
 *
 * Store-and-forward is how these loggers work: after a GSM outage a motor logger flushes
 * hours of buffered readings at once, all dated in shifts already scored. Without this
 * sweep those shifts were never scored again, so an overload during an outage raised no
 * alert. Arrival is `received_at`, 2.0's own clock; the readings it finds are the ones
 * `pullOwnTelemetry` would read for the machine, through the same bindings.
 */
export async function ownLateArrivals(ds: DataSource, request: LateArrivalRequest): Promise<LateArrival | null> {
  const [row]: { earliest: Date | null; seen_through: Date | null; count: number }[] = await withTenantId(
    ds, request.tenantId, (m) => m.query(
      `SELECT min(r."source_timestamp") AS earliest, max(r."received_at") AS seen_through, count(*)::int AS count
         FROM "telemetry_reading" r
        WHERE r."tenant_id" = $1
          AND r."received_at" > $4 AND r."received_at" <= $5
          AND EXISTS (
            SELECT 1 FROM "signal_binding_version" b
             WHERE b."tenant_id" = r."tenant_id" AND b."source_system" = $2 AND b."external_id" = $3
               AND b."imei" = r."imei"
               AND b."is_primary" AND b."status" = 'active'
               AND r."source_timestamp" >= b."valid_from"
               AND (b."valid_to" IS NULL OR r."source_timestamp" < b."valid_to"))`,
      [request.tenantId, request.sourceSystem, request.externalId, request.since ?? new Date(0), request.upTo],
    ));
  if (!row?.count || !row.earliest || !row.seen_through) return null;
  return { earliestReading: new Date(row.earliest), seenThrough: new Date(row.seen_through), count: Number(row.count) };
}
