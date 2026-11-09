import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { RequestScope } from '../auth/types/request-scope';
import { chainForEquipment, resolveParameters } from '../parameters/services/parameter-resolution';
import { runTenantSpanning } from '../scope/tenant-session';
import { tryTakePassLock } from '../shift/services/pass-lock';
import { RUNNING_SIGNAL } from '../shift/services/running-status';

/** Its own lock, not the shift runner's: the two may run side by side. */
export const MOTOR_TELEMETRY_LOCK_KEY = 7_315_009;

/** Readings a pass takes from the queue. A logger's backlog after an outage drains over passes. */
export const MAX_READINGS_PER_PASS = 20_000;

/**
 * What one minute of a logger becomes in `telemetry_reading`. Formulas, alerts and KPIs
 * read these, not the per-second rows: a reading a second is ~430,000 telemetry rows a
 * day per motor at full resolution, and storage is the platform's scaling axis (D13).
 * Voltage and current keep their extremes as well as their mean, since a one-second
 * overload or sag is exactly what a mean hides. `input_power` is single-phase
 * V × I × PF per reading, averaged, the measured quantity a duty curve is read by.
 */
const MINUTE_SIGNALS: readonly { signal: string; unit: string | null; expr: string }[] = [
  { signal: 'supply_voltage', unit: 'V', expr: 'avg("voltage_v")' },
  { signal: 'supply_voltage_min', unit: 'V', expr: 'min("voltage_v")' },
  { signal: 'supply_voltage_max', unit: 'V', expr: 'max("voltage_v")' },
  { signal: 'motor_current', unit: 'A', expr: 'avg("current_a")' },
  { signal: 'motor_current_max', unit: 'A', expr: 'max("current_a")' },
  { signal: 'power_factor', unit: null, expr: 'avg("power_factor")' },
  { signal: 'input_power', unit: 'kW', expr: 'avg("voltage_v" * "current_a" * "power_factor") / 1000' },
  { signal: 'motor_temperature', unit: 'degC', expr: 'avg("temperature_c")' },
  // The firmware's speed. The Crompton review found its estimate wrong for fixed-speed
  // motors (V-02); stored as the device sent it, under a name a class declares as
  // estimated, never as a measured speed.
  { signal: 'motor_speed_est', unit: 'rpm', expr: 'avg("rpm")' },
  // The logger's added sensors (all optional in the payload; a logger without one leaves
  // the column null and no signal is written for it, rather than a zero that reads as a
  // cold room or a perfectly smooth bearing).
  { signal: 'ambient_temperature', unit: 'degC', expr: 'avg("ambient_c")' },
  { signal: 'vibration_velocity', unit: 'mm/s', expr: 'avg("vibration_mm_s")' },
  { signal: 'vibration_velocity_max', unit: 'mm/s', expr: 'max("vibration_mm_s")' },
  { signal: 'device_load_pct', unit: 'dimensionless', expr: 'avg("load_pct")' },
  // Stored as sent until its unit and meaning are confirmed; nothing reads it yet.
  { signal: 'water_air_gap', unit: null, expr: 'avg("water_air_gap")' },
];

export interface PassSummary {
  readings: number;
  devices: number;
  uploads: number;
}

interface Owner { tenant_id: string; equipmentExternalId: string | null }

/**
 * The motor loggers' readings, from where the receiver puts them to where the platform
 * reads them.
 *
 * The receiver is `motor_logger_http_server.py`: it takes the loggers' POSTs, writes
 * `motor_sensor_records` and `motor_upload_log` in this database, and ACKs. It knows
 * nothing of accounts, ratings or telemetry, and should not have to. This job picks up
 * what it wrote — rows whose `reading_at` is still null, uploads whose `processed_at` is
 * — and turns them into the platform's one-minute telemetry, for the loggers assigned to
 * an account. Everything downstream (KPIs, alerts, scenarios, shift scoring and the
 * late-arrival sweep) reads that telemetry, so it does not care which receiver wrote the
 * rows.
 */
@Injectable()
export class MotorIngestService {
  private readonly logger = new Logger(MotorIngestService.name);

  constructor(private readonly ds: DataSource) {}

  /** One pass, unless another instance is mid-pass: then nothing, and its next tick does it. */
  async processExclusively(now = new Date()): Promise<PassSummary | null> {
    const lock = await tryTakePassLock(this.ds, MOTOR_TELEMETRY_LOCK_KEY);
    if (!lock) return null;
    try {
      return await this.processPending(now);
    } finally {
      await lock.release();
    }
  }

  /**
   * Places the receiver's new readings in time, writes the minutes they touched, and
   * turns new uploads' counters into logger-health signals. Idempotent: what it has done
   * it marks, and a reading it has placed is not placed again.
   */
  async processPending(now = new Date(), maxReadings = MAX_READINGS_PER_PASS): Promise<PassSummary> {
    return runTenantSpanning(this.ds, 'motor telemetry: readings the receiver stored', async (m) => {
      // The reading's wall-clock time. The device's timestamp is its own clock (seconds,
      // continuous within one boot); the receiver keeps no device clock at send time. So,
      // per logger and boot, the newest reading waiting in this pass is taken as received
      // when its batch was, and every other one placed by the device clock before it.
      //
      // Anchored per logger, not per batch: a logger sends its five-minute buffer as six
      // batches seconds apart, and anchoring each batch to its own arrival squeezed five
      // minutes into one — a backfill after an outage into seconds. Still approximate (off
      // by however long the newest reading waited on the device), and said so on the row.
      //
      // The anchor is the newest reading still waiting for that boot, not the newest in
      // this pass. A backlog larger than one pass (a logger back after hours offline)
      // used to be anchored pass by pass, each chunk on "now", so 23 hours of readings
      // were stacked onto the last five. Waiting readings are few in steady running and
      // found through the partial index on reading_at IS NULL.
      const result: unknown = await m.query(
        `WITH pending AS (
           SELECT "device_id", "seq", "device_ts", "batch_id", "received_at"
             FROM "motor_sensor_records" WHERE "reading_at" IS NULL
            ORDER BY "received_at", "device_id", "seq" LIMIT $1
         ), booted AS (
           SELECT p.*, coalesce((SELECT u."boot" FROM "motor_upload_log" u
                                  WHERE u."device_id" = p."device_id" AND u."batch_id" = p."batch_id"
                                  ORDER BY u."id" LIMIT 1), -1) AS "boot"
             FROM pending p
         ), anchor AS (
           SELECT DISTINCT ON (w."device_id", "boot") w."device_id", "boot", w."device_ts" AS "a_ts", w."received_at" AS "a_at"
             FROM "motor_sensor_records" w
             CROSS JOIN LATERAL (SELECT coalesce((SELECT u."boot" FROM "motor_upload_log" u
                                   WHERE u."device_id" = w."device_id" AND u."batch_id" = w."batch_id"
                                   ORDER BY u."id" LIMIT 1), -1) AS "boot") wb
            WHERE w."reading_at" IS NULL AND w."device_id" IN (SELECT "device_id" FROM pending)
            ORDER BY w."device_id", "boot", w."device_ts" DESC, w."received_at" DESC
         )
         UPDATE "motor_sensor_records" r
            SET "reading_at" = a."a_at" - make_interval(secs => greatest(0, a."a_ts" - b."device_ts")),
                "time_basis" = 'approximate'
           FROM booted b JOIN anchor a ON a."device_id" = b."device_id" AND a."boot" = b."boot"
          WHERE r."device_id" = b."device_id" AND r."seq" = b."seq" AND r."reading_at" IS NULL
        RETURNING r."device_id", r."reading_at"`,
        [maxReadings],
      );
      // TypeORM's postgres driver returns [rows, affected] for an UPDATE ... RETURNING.
      const placed = (Array.isArray(result) && Array.isArray(result[0]) ? result[0] : result) as { device_id: string; reading_at: Date }[];

      const byDevice = new Map<string, Date[]>();
      for (const p of placed) {
        const list = byDevice.get(p.device_id) ?? [];
        list.push(new Date(p.reading_at));
        byDevice.set(p.device_id, list);
      }
      for (const [deviceId, readingAts] of byDevice) {
        const owner = await this.owner(m, deviceId);
        if (!owner) {
          this.logger.warn(`Motor logger ${deviceId} is not assigned to an account; readings stored, not scored.`);
          continue;
        }
        await this.writeMinutes(m, deviceId, readingAts, now, owner);
      }

      const uploads = await this.processUploads(m, now);
      if (placed.length || uploads) {
        this.logger.log(`Placed ${placed.length} reading(s) from ${byDevice.size} logger(s); ${uploads} upload(s) checked.`);
      }
      return { readings: placed.length, devices: byDevice.size, uploads };
    });
  }

  /**
   * The newest readings, the devices and the last uploads, as the logger contract's
   * `/api/motor/recent` describes — narrowed to the loggers this account has. A logger
   * belongs to an account through `device_inventory`; platform staff see every logger.
   */
  async recent(scope: RequestScope, deviceId: string | undefined, limit = 300) {
    const take = Math.max(1, Math.min(Number.isFinite(limit) ? limit : 300, 1000));
    return runTenantSpanning(this.ds, `motor recent for ${scope.userId}`, async (m) => {
      const devices: string[] = scope.isPlatformRole
        ? (await m.query(`SELECT DISTINCT "device_id" FROM "motor_upload_log"`)).map((r: { device_id: string }) => r.device_id)
        : (await m.query(
          `SELECT "imei" FROM "device_inventory" WHERE "tenant_id" = $1 AND "state" = 'assigned'`, [scope.tenantId],
        )).map((r: { imei: string }) => r.imei);
      const visible = deviceId ? devices.filter((d) => d === deviceId) : devices;
      if (deviceId && !visible.length) throw new NotFoundException(`No motor logger "${deviceId}" in this account.`);
      if (!visible.length) return { records: [], devices: [], uploads: [] };
      const records = await m.query(
        `SELECT "device_id", "seq"::float8 AS "seq", "device_ts"::float8 AS "device_ts",
                "voltage_v"::float8 AS "voltage_v", "current_a"::float8 AS "current_a",
                "power_factor"::float8 AS "power_factor", "temperature_c"::float8 AS "temperature_c", "rpm",
                "batch_id", "received_at", "reading_at", "time_basis"
           FROM "motor_sensor_records" WHERE "device_id" = ANY($1::text[])
          ORDER BY coalesce("reading_at", "received_at") DESC, "seq" DESC LIMIT $2`, [visible, take],
      );
      const summary = await m.query(
        `SELECT "device_id", count(*)::int AS "total_records", max("received_at") AS "last_seen", max("seq")::float8 AS "last_seq"
           FROM "motor_sensor_records" WHERE "device_id" = ANY($1::text[]) GROUP BY "device_id" ORDER BY "device_id"`, [visible],
      );
      const uploads = await m.query(
        `SELECT "device_id", "batch_id", "first_seq"::float8 AS "first_seq", "last_seq"::float8 AS "last_seq",
                "record_count", "stored_count", "lost_total"::float8 AS "lost_total",
                "dropped_total"::float8 AS "dropped_total", "received_at"
           FROM "motor_upload_log" WHERE "device_id" = ANY($1::text[]) ORDER BY "received_at" DESC, "id" DESC LIMIT 20`, [visible],
      );
      return { records, devices: summary, uploads };
    });
  }

  // ----------------------------------------------------------------------------------

  /** The account a logger is assigned to, and the machine it is claimed onto, if any. */
  private async owner(m: EntityManager, deviceId: string): Promise<Owner | null> {
    const [row] = await m.query(
      `SELECT "tenant_id", "equipment_external_id" FROM "device_inventory"
        WHERE "imei" = $1 AND "state" = 'assigned' AND "tenant_id" IS NOT NULL`, [deviceId],
    );
    return row ? { tenant_id: row.tenant_id, equipmentExternalId: row.equipment_external_id ?? null } : null;
  }

  /**
   * Recomputes every minute these readings touched, from all the placed readings in it,
   * and writes the result over what was there. A minute usually straddles two batches
   * (50 readings is under a minute at 1 Hz), so its first write is a partial and the next
   * pass completes it. A late revision of a value is what telemetry already allows (G06),
   * and the shift runner's late-arrival sweep re-scores a shift it changes.
   */
  private async writeMinutes(m: EntityManager, deviceId: string, readingAts: Date[], now: Date, owner: Owner): Promise<void> {
    const minutes = [...new Set(readingAts.map((t) => Math.floor(t.getTime() / 60_000) * 60_000))].sort((a, b) => a - b);
    const months = new Set(minutes.map((t) => new Date(t).toISOString().slice(0, 7) + '-01'));
    for (const month of months) await m.query(`SELECT ensure_telemetry_partition($1::date)`, [month]);

    const select = MINUTE_SIGNALS.map((s, i) => `${s.expr} AS "s${i}"`).join(', ');
    const rows: { minute: Date; [k: string]: unknown }[] = await m.query(
      `SELECT date_trunc('minute', "reading_at") AS "minute", ${select}
         FROM "motor_sensor_records"
        WHERE "device_id" = $1 AND date_trunc('minute', "reading_at") = ANY($2::timestamptz[])
        GROUP BY 1`,
      [deviceId, minutes.map((t) => new Date(t))],
    );
    const values: unknown[] = [];
    const tuples: string[] = [];
    const add = (signal: string, unit: string | null, value: number, minute: Date) => {
      const o = values.length;
      values.push(owner.tenant_id, deviceId, signal, value, unit, minute, now);
      tuples.push(`($${o + 1}, $${o + 2}, $${o + 3}, $${o + 4}, $${o + 5}, $${o + 6}, $${o + 7}, 'live')`);
    };
    for (const row of rows) {
      MINUTE_SIGNALS.forEach((s, i) => {
        const raw = row[`s${i}`];
        // Number(null) is 0, a reading nobody took.
        if (raw === null || raw === undefined) return;
        const v = Number(raw);
        if (Number.isFinite(v)) add(s.signal, s.unit, v, new Date(row.minute));
      });
    }
    for (const row of await this.runningMinutes(m, owner, deviceId, minutes)) {
      const minute = new Date(row.minute);
      add(RUNNING_SIGNAL, 'dimensionless', row.ran ? 1 : 0, minute);
      add('motor_starts', 'starts', Number(row.starts), minute);
      // The share of the minute's seconds it ran: a 30 s stop is half a minute, which the
      // 1/0 flag above (any running at all) cannot say.
      add('motor_running_share', 'dimensionless', Number(row.share), minute);
      // Only while running, and only with enough seconds to have a spread at all.
      if (row.fluct != null && Number.isFinite(Number(row.fluct))) add('current_fluctuation_pct', 'dimensionless', Number(row.fluct), minute);
    }
    if (tuples.length) await upsertTelemetry(m, tuples, values);
  }

  /**
   * Whether the motor ran in each minute, and how many times it started, judged per
   * second before anything is averaged: a start is a moment, and a one-minute mean has
   * already lost it. "Running" is the workbook's F1: supply above 15% of rated voltage
   * and current above 5% of rated current, the machine's own ratings (nameplate first,
   * then its model), so the floor scales with the motor.
   *
   * `engine_running_status` is the platform's one running signal — availability, duty
   * cycle, the operating gate a baseline learns from, and the shift runner's "never
   * ran" check all read it. With no ratings for the machine nothing is written: unknown,
   * which the platform already treats as unknown, rather than a floor guessed for a class
   * that spans a six-fold range of motors.
   *
   * A start needs the previous reading within five seconds. Across a gap in the data the
   * motor's state in between is not known, and the logger coming back is not a start.
   */
  private async runningMinutes(
    m: EntityManager, owner: Owner, deviceId: string, minutes: number[],
  ): Promise<{ minute: Date; ran: boolean; starts: string; share: string; fluct: string | null }[]> {
    if (!owner.equipmentExternalId || !minutes.length) return [];
    const [profile] = await m.query(
      `SELECT "id", "equipment_class_slug" AS "equipmentClassSlug", "plant_id" AS "plantId" FROM "equipment_profile"
        WHERE "tenant_id" = $1 AND "external_id" = $2 ORDER BY ("source_system" = 'ta-2.0') DESC LIMIT 1`,
      [owner.tenant_id, owner.equipmentExternalId],
    );
    if (!profile) return [];
    const ratings = await resolveParameters(m, owner.tenant_id, chainForEquipment(profile), ['rated_voltage', 'rated_current'], new Date());
    const v = ratings.get('rated_voltage')?.value;
    const i = ratings.get('rated_current')?.value;
    if (typeof v !== 'number' || typeof i !== 'number') return [];
    return m.query(
      `WITH r AS (
         SELECT "reading_at", "current_a", ("voltage_v" > $3 AND "current_a" > $4) AS "on"
           FROM "motor_sensor_records"
          WHERE "device_id" = $1 AND "reading_at" >= $5 AND "reading_at" < $6
       ), t AS (
         SELECT "reading_at", "on", "current_a",
                lag("on") OVER (ORDER BY "reading_at") AS "prev",
                lag("reading_at") OVER (ORDER BY "reading_at") AS "prev_at"
           FROM r
       )
       SELECT date_trunc('minute', "reading_at") AS "minute", bool_or("on") AS "ran",
              avg(CASE WHEN "on" THEN 1 ELSE 0 END) AS "share",
              count(*) FILTER (WHERE "on" AND "prev" = false AND "reading_at" - "prev_at" <= interval '5 seconds') AS "starts",
              -- F, the current-fluctuation %: the input of the workbook's instability_score
              -- (V-07: a current-noise index, not vibration). Running seconds only; ten at least.
              CASE WHEN count(*) FILTER (WHERE "on") >= 10
                   THEN 100 * stddev_samp("current_a") FILTER (WHERE "on") / NULLIF(avg("current_a") FILTER (WHERE "on"), 0)
              END AS "fluct"
         FROM t
        WHERE date_trunc('minute', "reading_at") = ANY($2::timestamptz[])
        GROUP BY 1`,
      [deviceId, minutes.map((t) => new Date(t)), 0.15 * v, 0.05 * i,
        new Date(minutes[0] - 60_000), new Date(minutes[minutes.length - 1] + 60_000)],
    );
  }

  /**
   * The logger's own health (U10): how many records it overwrote (flash full) or could
   * not store since its previous upload, as signals an alert can watch. The contract says
   * to alert if `lost_total` / `dropped_total` grow; the totals only ever grow, so what is
   * written is the growth. A total lower than the previous one is a counter reset (flash
   * replaced, firmware reflashed), and the new total is what was lost since. A retry of a
   * range carries the same totals, so it adds nothing.
   *
   * Each upload is marked processed in the same transaction that writes its growth, so a
   * pass that fails writes nothing and marks nothing.
   */
  private async processUploads(m: EntityManager, now: Date): Promise<number> {
    const pending: { id: string; device_id: string; lost: number | null; dropped: number | null; received_at: Date }[] = await m.query(
      `SELECT "id", "device_id", "lost_total"::float8 AS "lost", "dropped_total"::float8 AS "dropped", "received_at"
         FROM "motor_upload_log" WHERE "processed_at" IS NULL ORDER BY "id" LIMIT 2000`,
    );
    for (const u of pending) {
      const owner = await this.owner(m, u.device_id);
      if (owner) {
        const [previous] = await m.query(
          `SELECT "lost_total"::float8 AS "lost", "dropped_total"::float8 AS "dropped" FROM "motor_upload_log"
            WHERE "device_id" = $1 AND "id" < $2 ORDER BY "id" DESC LIMIT 1`, [u.device_id, u.id],
        );
        const growth = (current: number | null, before: number | null | undefined) =>
          current == null ? null : before == null ? 0 : current >= before ? current - before : current;
        const minute = new Date(Math.floor(new Date(u.received_at).getTime() / 60_000) * 60_000);
        const values: unknown[] = [];
        const tuples: string[] = [];
        for (const [signal, value] of [
          ['logger_records_lost', growth(u.lost, previous?.lost)],
          ['logger_records_dropped', growth(u.dropped, previous?.dropped)],
        ] as const) {
          if (value === null) continue;
          const o = values.length;
          values.push(owner.tenant_id, u.device_id, signal, value, 'records', minute, now);
          tuples.push(`($${o + 1}, $${o + 2}, $${o + 3}, $${o + 4}, $${o + 5}, $${o + 6}, $${o + 7}, 'live')`);
        }
        if (tuples.length) {
          await m.query(`SELECT ensure_telemetry_partition($1::date)`, [minute.toISOString().slice(0, 7) + '-01']);
          // Two uploads in one minute: the minute's growth is their sum, not the last one's.
          await m.query(
            `INSERT INTO "telemetry_reading" ("tenant_id", "imei", "signal", "value", "unit", "source_timestamp", "received_at", "source")
             VALUES ${tuples.join(', ')}
             ON CONFLICT ("imei", "signal", "source_timestamp") DO UPDATE
               SET "value" = "telemetry_reading"."value" + EXCLUDED."value", "received_at" = EXCLUDED."received_at"`,
            values,
          );
        }
      }
      // Unassigned loggers' uploads are marked too: their counters describe a period no
      // account held the logger, and replaying them on assignment would date them wrong.
      await m.query(`UPDATE "motor_upload_log" SET "processed_at" = $2 WHERE "id" = $1`, [u.id, now]);
    }
    return pending.length;
  }
}

async function upsertTelemetry(m: EntityManager, tuples: string[], values: unknown[]): Promise<void> {
  await m.query(
    `INSERT INTO "telemetry_reading" ("tenant_id", "imei", "signal", "value", "unit", "source_timestamp", "received_at", "source")
     VALUES ${tuples.join(', ')}
     ON CONFLICT ("imei", "signal", "source_timestamp") DO UPDATE
       SET "value" = EXCLUDED."value", "received_at" = EXCLUDED."received_at"`,
    values,
  );
}
