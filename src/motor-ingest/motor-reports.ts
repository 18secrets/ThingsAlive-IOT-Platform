import { BadRequestException } from '@nestjs/common';
import { EntityManager } from 'typeorm';

/**
 * What the Motor Monitor integration spec (24 Nov 2026) asks the web application to show
 * about a pump logger beyond its live values: how complete its data is, what it ran and
 * used each day, and its raw readings to take away. Read from the receiver's per-second
 * rows (`motor_sensor_records`, `motor_upload_log`), not the one-minute telemetry: a gap
 * in seq, a restart and a second's energy are only visible there.
 *
 * Readings are placed in time by `reading_at`, which the motor job derives from the
 * device's seconds counter (the spec's own workaround; `time_basis` says approximate),
 * never by arrival: a backlog after an outage arrives days late. A reading still waiting
 * to be placed has no time yet and is counted as such, not guessed.
 */

/** The spec's "running", over a reading aliased `r`: the line the P-codes use (p-code-rules.ts isRunning). */
const RUNNING = `r."current_a" > 0.04 AND r."voltage_v" > 30`;

export const MAX_QUALITY_WINDOW_DAYS = 31;
export const MAX_DAILY_DAYS = 92;
export const MAX_EXPORT_WINDOW_DAYS = 31;
/** Gaps listed one by one; the total is counted regardless. */
export const MAX_GAPS_LISTED = 100;

export interface Window { from: Date; to: Date }

/** [from, to), defaulting to the day before `to`; refused when backwards or longer than `maxDays`. */
export function window(from: Date | undefined, to: Date | undefined, now: Date, maxDays: number): Window {
  const end = to ?? now;
  const start = from ?? new Date(end.getTime() - 86_400_000);
  if (start >= end) throw new BadRequestException('from must be before to.');
  if (end.getTime() - start.getTime() > maxDays * 86_400_000) {
    throw new BadRequestException(`The window is at most ${maxDays} days.`);
  }
  return { from: start, to: end };
}

/**
 * The machine's motor loggers: devices ever mapped to it by `at` (mapped-devices.ts,
 * the history sense, so a logger since moved on still answers for its time here) that
 * the receiver has heard from. A tracker or a 1.0 device on the same machine is not a
 * logger and has nothing in these tables.
 */
export async function loggersOf(m: EntityManager, mappedSql: string, tenantId: string, externalId: string, at: Date): Promise<string[]> {
  const rows: { imei: string }[] = await m.query(
    `SELECT DISTINCT d."imei" FROM (${mappedSql}) d
      WHERE d."equipment_external_id" = $2
        AND EXISTS (SELECT 1 FROM "motor_upload_log" u WHERE u."device_id" = d."imei")
      ORDER BY d."imei"`,
    [tenantId, externalId, at],
  );
  return rows.map((r) => r.imei);
}

export interface SeqGap { fromSeq: number; toSeq: number; missing: number; after: string }

export interface LoggerQuality {
  deviceId: string;
  /** Readings placed in the window, and the seq range they span. */
  readings: number;
  firstSeq: number | null;
  lastSeq: number | null;
  /** Seqs inside that range with no reading: a damaged record the device skipped (spec). */
  missing: number;
  gaps: SeqGap[];
  gapsTruncated: boolean;
  /** Readings the receiver stored that the motor job has not yet placed in time. */
  awaitingPlacement: number;
  /** Uploads that arrived in the window, by their arrival. */
  uploads: number;
  lastUploadAt: string | null;
  bootFirst: number | null;
  bootLast: number | null;
  /** Times `boot` went up between one upload and the next: device restarts. */
  restarts: number;
  /** The device's running totals as of its newest upload by `to`. */
  lostTotal: number | null;
  droppedTotal: number | null;
  /** How much each total grew in the window; a total lower than the one before is a reset, and counts whole. */
  lostInWindow: number;
  droppedInWindow: number;
}

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

/** The spec's data-quality panel for one logger. */
export async function loggerQuality(m: EntityManager, deviceId: string, w: Window): Promise<LoggerQuality> {
  const [span] = await m.query(
    `SELECT count(*)::int AS "readings", min("seq")::float8 AS "first", max("seq")::float8 AS "last"
       FROM "motor_sensor_records" WHERE "device_id" = $1 AND "reading_at" >= $2 AND "reading_at" < $3`,
    [deviceId, w.from, w.to]);
  const gapRows: { prev: string; seq: string; after: Date }[] = await m.query(
    `SELECT "prev", "seq", "prev_at" AS "after" FROM (
       SELECT "seq", lag("seq") OVER (ORDER BY "seq") AS "prev", lag("reading_at") OVER (ORDER BY "seq") AS "prev_at"
         FROM "motor_sensor_records" WHERE "device_id" = $1 AND "reading_at" >= $2 AND "reading_at" < $3) g
      WHERE "seq" - "prev" > 1 ORDER BY "seq" LIMIT ${MAX_GAPS_LISTED + 1}`,
    [deviceId, w.from, w.to]);
  const [pending] = await m.query(
    `SELECT count(*)::int AS "n" FROM "motor_sensor_records" WHERE "device_id" = $1 AND "reading_at" IS NULL`, [deviceId]);

  // The newest upload before the window too: the baseline the first upload in it grew from.
  const uploads: { boot: string | null; lost: string | null; dropped: string | null; at: Date; inWindow: boolean }[] = await m.query(
    `(SELECT "boot", "lost_total" AS "lost", "dropped_total" AS "dropped", "received_at" AS "at", false AS "inWindow", "id"
        FROM "motor_upload_log" WHERE "device_id" = $1 AND "received_at" < $2 ORDER BY "received_at" DESC, "id" DESC LIMIT 1)
     UNION ALL
     (SELECT "boot", "lost_total", "dropped_total", "received_at", true, "id"
        FROM "motor_upload_log" WHERE "device_id" = $1 AND "received_at" >= $2 AND "received_at" < $3)
     ORDER BY "at", "id"`,
    [deviceId, w.from, w.to]);

  const growth = (current: number | null, before: number | null) =>
    current === null || before === null ? 0 : current >= before ? current - before : current;
  let restarts = 0;
  let lostInWindow = 0;
  let droppedInWindow = 0;
  let prev: { boot: number | null; lost: number | null; dropped: number | null } | null = null;
  const boots: number[] = [];
  for (const u of uploads) {
    const cur = { boot: num(u.boot), lost: num(u.lost), dropped: num(u.dropped) };
    if (u.inWindow) {
      if (cur.boot !== null) boots.push(cur.boot);
      if (prev) {
        if (cur.boot !== null && prev.boot !== null && cur.boot > prev.boot) restarts += 1;
        lostInWindow += growth(cur.lost, prev.lost);
        droppedInWindow += growth(cur.dropped, prev.dropped);
      }
    }
    // A retry carries the totals of its time; only a known value moves the baseline.
    prev = {
      boot: cur.boot ?? prev?.boot ?? null, lost: cur.lost ?? prev?.lost ?? null, dropped: cur.dropped ?? prev?.dropped ?? null,
    };
  }
  const inWindow = uploads.filter((u) => u.inWindow);
  const gaps = gapRows.slice(0, MAX_GAPS_LISTED).map((g) => ({
    fromSeq: Number(g.prev) + 1, toSeq: Number(g.seq) - 1, missing: Number(g.seq) - Number(g.prev) - 1,
    after: new Date(g.after).toISOString(),
  }));
  const first = num(span.first);
  const last = num(span.last);
  return {
    deviceId,
    readings: span.readings,
    firstSeq: first,
    lastSeq: last,
    missing: first === null || last === null ? 0 : last - first + 1 - span.readings,
    gaps,
    gapsTruncated: gapRows.length > MAX_GAPS_LISTED,
    awaitingPlacement: pending.n,
    uploads: inWindow.length,
    lastUploadAt: inWindow.length ? new Date(inWindow[inWindow.length - 1].at).toISOString() : null,
    bootFirst: boots.length ? boots[0] : null,
    bootLast: boots.length ? boots[boots.length - 1] : null,
    restarts,
    lostTotal: prev?.lost ?? null,
    droppedTotal: prev?.dropped ?? null,
    lostInWindow,
    droppedInWindow,
  };
}

export interface DayTotals {
  /** The calendar day in the account's time zone. */
  date: string;
  readings: number;
  /** Share of the day's seconds with a reading: a day half missing is not half a day's use. */
  coverage: number;
  /** Null, not zero, for a day with no readings: nothing is known about it. */
  runningHours: number | null;
  energyKwh: number | null;
}

/** YYYY-MM-DD, or refused. */
export function parseDay(raw: string | undefined, field: string): string | undefined {
  if (raw === undefined || raw === '') return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw) || Number.isNaN(Date.parse(`${raw}T00:00:00Z`))) {
    throw new BadRequestException(`${field} must be a date as YYYY-MM-DD: "${raw}".`);
  }
  return raw;
}

/**
 * Running hours and energy per calendar day (spec: energy ≈ V × I × PF × 1 s per record).
 * Every reading is one second, as the device takes them; a second that was never stored
 * adds nothing rather than being filled in, and `coverage` says how much is missing.
 */
export async function dailyTotals(
  m: EntityManager, deviceId: string, fromDay: string, toDay: string, timeZone: string,
): Promise<DayTotals[]> {
  const rows: { date: string; readings: number; running: number; energy: number; seconds: number }[] = await m.query(
    `WITH days AS (
       SELECT d::date AS "day",
              (d::timestamp AT TIME ZONE $4) AS "start",
              ((d + interval '1 day')::timestamp AT TIME ZONE $4) AS "end"
         FROM generate_series($2::date, $3::date, interval '1 day') d
     )
     SELECT to_char(days."day", 'YYYY-MM-DD') AS "date",
            extract(epoch FROM days."end" - days."start")::float8 AS "seconds",
            count(r."seq")::int AS "readings",
            count(r."seq") FILTER (WHERE ${RUNNING})::int AS "running",
            coalesce(sum(r."voltage_v" * r."current_a" * r."power_factor"), 0)::float8 / 3600000 AS "energy"
       FROM days
       LEFT JOIN "motor_sensor_records" r
         ON r."device_id" = $1 AND r."reading_at" >= days."start" AND r."reading_at" < days."end"
      GROUP BY days."day", days."start", days."end"
      ORDER BY days."day"`,
    [deviceId, fromDay, toDay, timeZone]);
  return rows.map((r) => ({
    date: r.date,
    readings: r.readings,
    coverage: Math.round((r.readings / r.seconds) * 10_000) / 10_000,
    runningHours: r.readings ? Math.round((r.running / 3600) * 1000) / 1000 : null,
    energyKwh: r.readings ? Math.round(r.energy * 1000) / 1000 : null,
  }));
}

/**
 * The CSV's columns: the spec's record fields under the spec's names, the device's own
 * seq and seconds counter, and the placed time with how it was derived. Temperature and
 * rpm are the firmware's estimates and say so in their header.
 */
export const CSV_COLUMNS: readonly [header: string, sql: string][] = [
  ['device_id', '"device_id"'],
  ['seq', '"seq"'],
  ['timestamp', '"device_ts"'],
  ['reading_at', `to_char("reading_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`],
  ['time_basis', '"time_basis"'],
  ['voltage', '"voltage_v"'],
  ['current', '"current_a"'],
  ['power_factor', '"power_factor"'],
  ['temperature_estimated', '"temperature_c"'],
  ['rpm_estimated', '"rpm"'],
  ['load_loss', '"load_loss"'],
  ['vibration', '"vibration_score"'],
  ['air_gap', '"air_gap_score"'],
];
export const CSV_PAGE = 5_000;

function cell(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * The CSV a page at a time, by keyset on (device_id, seq), so a month of one-second
 * readings (2.6 million rows) is never held in memory at once. Ordered by seq per device,
 * as the spec orders a device's history.
 */
export async function* readingsCsv(
  query: (sql: string, params: unknown[]) => Promise<Record<string, unknown>[]>,
  deviceIds: string[], w: Window,
): AsyncGenerator<string> {
  yield CSV_COLUMNS.map(([h]) => h).join(',') + '\r\n';
  const select = CSV_COLUMNS.map(([h, sql]) => `${sql} AS "${h}"`).join(', ');
  let after: [string, string] = ['', '-1'];
  for (;;) {
    const rows = await query(
      `SELECT ${select}, "seq"::text AS "_seq" FROM "motor_sensor_records"
        WHERE "device_id" = ANY($1::text[]) AND "reading_at" >= $2 AND "reading_at" < $3
          AND ("device_id", "seq") > ($4, $5::bigint)
        ORDER BY "device_id", "seq" LIMIT ${CSV_PAGE}`,
      [deviceIds, w.from, w.to, after[0], after[1]]);
    if (!rows.length) return;
    yield rows.map((r) => CSV_COLUMNS.map(([h]) => cell(r[h])).join(',')).join('\r\n') + '\r\n';
    const lastRow = rows[rows.length - 1];
    after = [String(lastRow.device_id), String(lastRow._seq)];
    if (rows.length < CSV_PAGE) return;
  }
}
