import { HttpException, HttpStatus, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { DataSource, EntityManager } from 'typeorm';
import { RequestScope } from '../auth/types/request-scope';
import { chainForEquipment, resolveParameters } from '../parameters/services/parameter-resolution';
import { runTenantSpanning } from '../scope/tenant-session';
import { RUNNING_SIGNAL } from '../shift/services/running-status';

/** The firmware's body ceiling, overridable as the contract says. */
export const MAX_BODY_BYTES = Number(process.env.MOTOR_MAX_BODY_BYTES) || 8192;
/** The firmware sends ≤ 50; a few more is a firmware change, many more is not this device. */
const MAX_RECORDS = 200;

export interface MotorRecord {
  seq: number;
  timestamp: number;
  voltage: number;
  current: number;
  power_factor: number;
  temperature: number;
  rpm: number;
}

export interface MotorBatch {
  device_id: string;
  batch_id: string;
  first_seq: number;
  last_seq: number;
  count: number;
  boot?: number;
  lost_total?: number;
  dropped_total?: number;
  /** The device clock at send time, in the same seconds as `timestamp`. Added for 2.0. */
  device_now?: number;
  records: MotorRecord[];
}

/** The ACK, built so its keys serialise in the order the device's parser needs. */
export interface MotorAck {
  status: 'ok';
  ack_seq: number;
}

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
];

/**
 * The motor loggers' bulk upload (SIM800L GSM; one POST of ≤ 50 records every five
 * minutes).
 *
 * The device deletes its flash copy only on an ACK, so the ACK is sent only after the
 * transaction that stored every record has committed, and the same range sent twice is
 * the same 200. All of a batch commits or none of it does, so the ACK is always the
 * whole range (`last_seq`); the partial-ACK forms in the contract are never needed.
 */
@Injectable()
export class MotorIngestService {
  private readonly logger = new Logger(MotorIngestService.name);

  constructor(private readonly ds: DataSource) {}

  async bulk(raw: unknown, deviceKey: string | undefined, contentLength: number | undefined, receivedAt = new Date()): Promise<MotorAck> {
    if (contentLength !== undefined && contentLength > MAX_BODY_BYTES) {
      // The device halves its batch and retries on 413, which is what this is for.
      throw new HttpException(`Body is ${contentLength} bytes; the limit is ${MAX_BODY_BYTES}.`, HttpStatus.PAYLOAD_TOO_LARGE);
    }
    const batch = validateBatch(raw);
    await this.authenticate(batch.device_id, deviceKey);

    return runTenantSpanning(this.ds, `motor logger upload from ${batch.device_id}`, async (m) => {
      const stored = batch.records.length ? await this.storeRecords(m, batch, receivedAt) : [];
      await m.query(
        `INSERT INTO "motor_upload_log" ("device_id", "batch_id", "first_seq", "last_seq", "record_count",
           "stored_count", "boot", "lost_total", "dropped_total", "device_now", "received_at")
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [batch.device_id, batch.batch_id, batch.first_seq, batch.last_seq, batch.records.length, stored.length,
          batch.boot ?? null, batch.lost_total ?? null, batch.dropped_total ?? null, batch.device_now ?? null, receivedAt],
      );
      if (batch.records.length && !stored.length) await this.warnOnSeqReset(m, batch);
      const owner = await this.owner(m, batch.device_id);
      if (stored.length) await this.writeMinutes(m, batch.device_id, stored, receivedAt, owner);
      if (owner) await this.writeLoggerHealth(m, batch, receivedAt, owner);
      return { status: 'ok', ack_seq: batch.last_seq };
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
          ORDER BY "reading_at" DESC, "seq" DESC LIMIT $2`, [visible, take],
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

  /**
   * Issues a logger's key (Master Admin). Shown once: only its hash is kept, so a lost
   * key is replaced, never recovered. Re-issuing replaces the old one at once — the
   * device must be reflashed with the new key before its next upload is accepted.
   */
  async issueKey(scope: RequestScope, deviceId: string): Promise<{ deviceId: string; key: string }> {
    if (!DEVICE_ID.test(deviceId ?? '')) {
      throw new HttpException('A device id is 1-64 letters, digits, "_" or "-".', HttpStatus.BAD_REQUEST);
    }
    const key = randomBytes(24).toString('hex');
    await this.ds.query(
      `INSERT INTO "motor_logger_key" ("device_id", "key_hash", "issued_by") VALUES ($1, $2, $3)
       ON CONFLICT ("device_id") DO UPDATE SET "key_hash" = EXCLUDED."key_hash", "issued_by" = EXCLUDED."issued_by", "issued_at" = now()`,
      [deviceId, sha256(key), scope.userId],
    );
    this.logger.warn(`${scope.userId} issued a key for motor logger ${deviceId}.`);
    return { deviceId, key };
  }

  // ----------------------------------------------------------------------------------

  private async authenticate(deviceId: string, key: string | undefined): Promise<void> {
    const [row] = await this.ds.query(`SELECT "key_hash" FROM "motor_logger_key" WHERE "device_id" = $1`, [deviceId]);
    // One answer for "no such logger" and "wrong key": telling them apart would let
    // anyone enumerate which device ids exist.
    const ok = !!row && !!key && timingSafeEqual(Buffer.from(sha256(key)), Buffer.from(row.key_hash));
    if (!ok) throw new HttpException('Unknown motor logger or wrong X-Device-Key.', HttpStatus.UNAUTHORIZED);
  }

  /** Inserts the batch; returns what was new. A resent record is a no-op, not an error. */
  private async storeRecords(m: EntityManager, batch: MotorBatch, receivedAt: Date): Promise<{ seq: number; readingAt: Date }[]> {
    const timed = readingTimes(batch, receivedAt);
    const values: unknown[] = [];
    const tuples = batch.records.map((r, i) => {
      const at = timed[i];
      values.push(batch.device_id, r.seq, r.timestamp, r.voltage, r.current, r.power_factor, r.temperature, r.rpm,
        batch.batch_id, receivedAt, at.readingAt, at.basis);
      const o = i * 12;
      return `($${o + 1}, $${o + 2}, $${o + 3}, $${o + 4}, $${o + 5}, $${o + 6}, $${o + 7}, $${o + 8}, $${o + 9}, $${o + 10}, $${o + 11}, $${o + 12})`;
    });
    const inserted: { seq: string; reading_at: Date }[] = await m.query(
      `INSERT INTO "motor_sensor_records" ("device_id", "seq", "device_ts", "voltage_v", "current_a", "power_factor",
         "temperature_c", "rpm", "batch_id", "received_at", "reading_at", "time_basis")
       VALUES ${tuples.join(', ')}
       ON CONFLICT ("device_id", "seq") DO NOTHING
       RETURNING "seq", "reading_at"`, values,
    );
    return inserted.map((r) => ({ seq: Number(r.seq), readingAt: new Date(r.reading_at) }));
  }

  /**
   * Recomputes every minute this batch touched, from all the stored readings in it, and
   * writes the result over what was there. A minute usually straddles two batches (50
   * readings is under a minute at 1 Hz), so its first write is a partial; the next batch
   * completes it. A late revision of a value is what telemetry already allows (G06).
   *
   * Only for a logger that is assigned to an account: an unassigned one's readings are
   * kept, and reach telemetry once it is assigned and resends — never under a guessed
   * tenant.
   */
  /** The account a logger is assigned to, and the machine it is claimed onto, if any. */
  private async owner(m: EntityManager, deviceId: string): Promise<Owner | null> {
    const [row] = await m.query(
      `SELECT "tenant_id", "equipment_external_id" FROM "device_inventory"
        WHERE "imei" = $1 AND "state" = 'assigned' AND "tenant_id" IS NOT NULL`, [deviceId],
    );
    return row ? { tenant_id: row.tenant_id, equipmentExternalId: row.equipment_external_id ?? null } : null;
  }

  private async writeMinutes(
    m: EntityManager, deviceId: string, stored: { readingAt: Date }[], receivedAt: Date, owner: Owner | null,
  ): Promise<void> {
    if (!owner) {
      this.logger.warn(`Motor logger ${deviceId} is not assigned to an account; readings stored, not scored.`);
      return;
    }
    const minutes = [...new Set(stored.map((s) => Math.floor(s.readingAt.getTime() / 60_000) * 60_000))].sort((a, b) => a - b);
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
    for (const row of rows) {
      MINUTE_SIGNALS.forEach((s, i) => {
        const v = Number(row[`s${i}`]);
        if (!Number.isFinite(v)) return;
        const o = values.length;
        values.push(owner.tenant_id, deviceId, s.signal, v, s.unit, new Date(row.minute), receivedAt);
        tuples.push(`($${o + 1}, $${o + 2}, $${o + 3}, $${o + 4}, $${o + 5}, $${o + 6}, $${o + 7}, 'live')`);
      });
    }
    for (const row of await this.runningMinutes(m, owner, deviceId, minutes)) {
      for (const [signal, unit, value] of [
        [RUNNING_SIGNAL, 'dimensionless', row.ran ? 1 : 0], ['motor_starts', 'starts', Number(row.starts)],
      ] as const) {
        const o = values.length;
        values.push(owner.tenant_id, deviceId, signal, value, unit, new Date(row.minute), receivedAt);
        tuples.push(`($${o + 1}, $${o + 2}, $${o + 3}, $${o + 4}, $${o + 5}, $${o + 6}, $${o + 7}, 'live')`);
      }
    }
    if (!tuples.length) return;
    await upsertTelemetry(m, tuples, values);
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
  ): Promise<{ minute: Date; ran: boolean; starts: string }[]> {
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
         SELECT "reading_at", ("voltage_v" > $3 AND "current_a" > $4) AS "on"
           FROM "motor_sensor_records"
          WHERE "device_id" = $1 AND "reading_at" >= $5 AND "reading_at" < $6
       ), t AS (
         SELECT "reading_at", "on",
                lag("on") OVER (ORDER BY "reading_at") AS "prev",
                lag("reading_at") OVER (ORDER BY "reading_at") AS "prev_at"
           FROM r
       )
       SELECT date_trunc('minute', "reading_at") AS "minute", bool_or("on") AS "ran",
              count(*) FILTER (WHERE "on" AND "prev" = false AND "reading_at" - "prev_at" <= interval '5 seconds') AS "starts"
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
   * written is the growth. A total lower than the last one is a counter reset (flash
   * replaced, firmware reflashed), and the new total is what was lost since.
   */
  private async writeLoggerHealth(m: EntityManager, batch: MotorBatch, receivedAt: Date, owner: Owner): Promise<void> {
    const [previous] = await m.query(
      `SELECT "lost_total"::float8 AS "lost", "dropped_total"::float8 AS "dropped" FROM "motor_upload_log"
        WHERE "device_id" = $1 AND "received_at" < $2 ORDER BY "received_at" DESC, "id" DESC LIMIT 1`,
      [batch.device_id, receivedAt],
    );
    const growth = (now: number | undefined, before: number | null | undefined) =>
      now == null ? null : before == null ? 0 : now >= before ? now - before : now;
    const minute = new Date(Math.floor(receivedAt.getTime() / 60_000) * 60_000);
    const values: unknown[] = [];
    const tuples: string[] = [];
    for (const [signal, value] of [
      ['logger_records_lost', growth(batch.lost_total, previous?.lost)],
      ['logger_records_dropped', growth(batch.dropped_total, previous?.dropped)],
    ] as const) {
      if (value === null) continue;
      const o = values.length;
      values.push(owner.tenant_id, batch.device_id, signal, value, 'records', minute, receivedAt);
      tuples.push(`($${o + 1}, $${o + 2}, $${o + 3}, $${o + 4}, $${o + 5}, $${o + 6}, $${o + 7}, 'live')`);
    }
    if (!tuples.length) return;
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

  /**
   * Every record already stored, and the batch's range sits well below what this device
   * has sent before: its flash was replaced or wiped and seq started again. Those
   * readings are being ignored as duplicates of old ones — the case the contract warns
   * of. Logged loudly; the fix is a new device_id or clearing the old range.
   */
  private async warnOnSeqReset(m: EntityManager, batch: MotorBatch): Promise<void> {
    const [row] = await m.query(
      `SELECT max("seq")::float8 AS "max" FROM "motor_sensor_records" WHERE "device_id" = $1`, [batch.device_id],
    );
    if (row?.max != null && batch.last_seq < row.max - 1000) {
      this.logger.error(
        `Motor logger ${batch.device_id} sent seq ${batch.first_seq}-${batch.last_seq}, far below its stored maximum `
          + `${row.max}, and every record matched an old one: its seq has probably restarted. These readings are `
          + 'not being stored. Give the device a new device_id or clear its old range.',
      );
    }
  }
}

interface Owner { tenant_id: string; equipmentExternalId: string | null }

async function upsertTelemetry(m: EntityManager, tuples: string[], values: unknown[]): Promise<void> {
  await m.query(
    `INSERT INTO "telemetry_reading" ("tenant_id", "imei", "signal", "value", "unit", "source_timestamp", "received_at", "source")
     VALUES ${tuples.join(', ')}
     ON CONFLICT ("imei", "signal", "source_timestamp") DO UPDATE
       SET "value" = EXCLUDED."value", "received_at" = EXCLUDED."received_at"`,
    values,
  );
}

const DEVICE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

/**
 * Each reading's wall-clock time. With `device_now`, exact: the reading happened
 * `device_now - timestamp` seconds before the request arrived, however late it arrived.
 * Without it, approximate: the newest record is taken as arriving now and the rest
 * placed by the device clock before it — off by however long the batch waited.
 *
 * A record dated after `device_now` was taken before a reboot reset the clock; it gets
 * the approximate time too rather than one in the future.
 */
export function readingTimes(batch: MotorBatch, receivedAt: Date): { readingAt: Date; basis: 'device_now' | 'approximate' }[] {
  const arrived = receivedAt.getTime();
  const newest = Math.max(...batch.records.map((r) => r.timestamp));
  return batch.records.map((r) => {
    if (batch.device_now != null && r.timestamp <= batch.device_now) {
      return { readingAt: new Date(arrived - (batch.device_now - r.timestamp) * 1000), basis: 'device_now' as const };
    }
    return { readingAt: new Date(arrived - Math.max(0, newest - r.timestamp) * 1000), basis: 'approximate' as const };
  });
}

/** The contract's rules, refused with a 422 the device logs and retries (it never will pass). */
export function validateBatch(raw: unknown): MotorBatch {
  const problems: string[] = [];
  const b = (raw ?? {}) as Partial<MotorBatch>;
  const int = (v: unknown, min: number, max: number) => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
  const num = (v: unknown, min: number, max: number) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
  const SEQ_MAX = 4_294_967_295;

  if (typeof b.device_id !== 'string' || !DEVICE_ID.test(b.device_id)) problems.push('device_id is 1-64 letters, digits, "_" or "-".');
  if (typeof b.batch_id !== 'string' || !b.batch_id || b.batch_id.length > 128) problems.push('batch_id is required, at most 128 characters.');
  if (!int(b.first_seq, 0, SEQ_MAX) || !int(b.last_seq, 0, SEQ_MAX) || (b.first_seq as number) > (b.last_seq as number)) {
    problems.push('first_seq and last_seq are whole numbers with first_seq ≤ last_seq.');
  }
  if (!Array.isArray(b.records)) problems.push('records must be a list (it may be empty).');
  else {
    if (b.records.length > MAX_RECORDS) problems.push(`at most ${MAX_RECORDS} records per request.`);
    if (b.count !== b.records.length) problems.push(`count (${b.count}) must equal the number of records (${b.records.length}).`);
    let previous = -1;
    b.records.forEach((r, i) => {
      const at = `record ${i + 1}`;
      if (!int(r?.seq, 1, SEQ_MAX)) { problems.push(`${at}: seq is a whole number from 1.`); return; }
      if (r.seq <= previous) problems.push(`${at}: records must be in ascending seq order.`);
      if (r.seq < (b.first_seq as number) || r.seq > (b.last_seq as number)) problems.push(`${at}: seq ${r.seq} is outside first_seq-last_seq.`);
      previous = r.seq;
      if (!int(r.timestamp, 0, Number.MAX_SAFE_INTEGER)) problems.push(`${at}: timestamp is a whole number of seconds.`);
      if (!num(r.voltage, 0, 6553.5)) problems.push(`${at}: voltage is 0-6553.5.`);
      if (!num(r.current, 0, 655.35)) problems.push(`${at}: current is 0-655.35.`);
      if (!num(r.power_factor, 0, 1)) problems.push(`${at}: power_factor is 0-1.`);
      if (!num(r.temperature, -3276.8, 3276.7)) problems.push(`${at}: temperature is -3276.8-3276.7.`);
      if (!int(r.rpm, 0, 65535)) problems.push(`${at}: rpm is a whole number 0-65535.`);
    });
  }
  for (const k of ['boot', 'lost_total', 'dropped_total', 'device_now'] as const) {
    if (b[k] != null && !int(b[k], 0, Number.MAX_SAFE_INTEGER)) problems.push(`${k} is a whole number when given.`);
  }
  if (problems.length) {
    throw new HttpException({ message: problems.slice(0, 10).join(' ') }, HttpStatus.UNPROCESSABLE_ENTITY);
  }
  return b as MotorBatch;
}
