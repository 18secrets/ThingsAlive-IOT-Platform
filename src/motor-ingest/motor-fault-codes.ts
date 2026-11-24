import { DataSource } from 'typeorm';
import { chainForEquipment, resolveParameters } from '../parameters/services/parameter-resolution';
import { withTenantId } from '../scope/tenant-session';
import {
  DEFAULT_THRESHOLDS, FAULT_LOOKBACK_SECONDS, FaultSample, P_CODES, PCodeThresholds, THRESHOLD_PARAMETERS, deviceFaults,
} from './p-code-rules';

interface EpisodeRow { id: string; code: string; status: 'active' | 'cleared'; lastSeenAt: Date; clearedAt: Date | null }

/**
 * Turns a logger's newly placed readings into fault-code episodes on the machine it is
 * claimed onto: opened when the device would raise the code, seen while it holds,
 * cleared at the first reading without it — the device's own lifecycle, not the vehicle
 * DTCs' ten-minute one, which exists because a vehicle's packets say nothing about a
 * code that has gone.
 *
 * Idempotent: a reading at or before what an episode of that code already accounts for
 * changes nothing, so a pass repeated, or a batch processed twice, writes nothing twice.
 * Serialised per machine by a transaction-level advisory lock, so two passes over the
 * same machine cannot both open the same episode; the one-active-episode index
 * (DtcActiveUnique) would refuse the second anyway, but it would fail the pass to do it.
 */
export async function recordMotorFaults(
  ds: DataSource,
  machine: { tenantId: string; externalId: string; deviceId: string; from: Date; to: Date },
): Promise<{ opened: number; cleared: number }> {
  return withTenantId(ds, machine.tenantId, async (m) => {
    await m.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`pcode:${machine.tenantId}:${machine.externalId}`]);
    // Pump codes are worked out only for an account given them (Account access, fault code
    // library step 4): an account without the kind has no P-codes to show.
    const [given] = await m.query(
      `SELECT 1 FROM "fault_code_type_grant" WHERE "tenant_id" = $1 AND "code_type" = 'motor-pump' AND "revoked_at" IS NULL`,
      [machine.tenantId]);
    if (!given) return { opened: 0, cleared: 0 };
    const [profile] = await m.query(
      `SELECT "id", "source_system" AS "sourceSystem", "equipment_class_slug" AS "equipmentClassSlug", "plant_id" AS "plantId"
         FROM "equipment_profile" WHERE "tenant_id" = $1 AND "external_id" = $2
        ORDER BY ("source_system" = 'ta-2.0') DESC LIMIT 1`, [machine.tenantId, machine.externalId]);
    if (!profile) return { opened: 0, cleared: 0 };
    const names = Object.values(THRESHOLD_PARAMETERS);
    const ratings = await resolveParameters(m, machine.tenantId, chainForEquipment(profile), ['rated_current', ...names], new Date());
    const rated = ratings.get('rated_current')?.value;
    // Each line the machine's own where one is set at any scope, the spec's otherwise.
    const thresholds = { ...DEFAULT_THRESHOLDS };
    for (const [key, name] of Object.entries(THRESHOLD_PARAMETERS) as [keyof PCodeThresholds, string][]) {
      const v = ratings.get(name)?.value;
      if (typeof v === 'number' && Number.isFinite(v) && v > 0) thresholds[key] = v;
    }

    const samples: FaultSample[] = (await m.query(
      `SELECT "reading_at" AS "at", "voltage_v"::float8 AS "voltage", "current_a"::float8 AS "current",
              "temperature_c"::float8 AS "temperature"
         FROM "motor_sensor_records"
        WHERE "device_id" = $1 AND "reading_at" >= $2::timestamptz - make_interval(secs => $4) AND "reading_at" <= $3
        ORDER BY "reading_at", "seq"`,
      [machine.deviceId, machine.from, machine.to, FAULT_LOOKBACK_SECONDS],
    )).map((r: { at: Date; voltage: number; current: number; temperature: number }) => ({
      at: new Date(r.at), voltage: Number(r.voltage), current: Number(r.current), temperature: Number(r.temperature),
    }));
    if (!samples.length) return { opened: 0, cleared: 0 };

    const episodes: EpisodeRow[] = await m.query(
      `SELECT "id", "code", "status", "last_seen_at" AS "lastSeenAt", "cleared_at" AS "clearedAt"
         FROM "device_dtc_episode"
        WHERE "tenant_id" = $1 AND "source_system" = $2 AND "external_id" = $3 AND "protocol" = 'pcode'`,
      [machine.tenantId, profile.sourceSystem, machine.externalId],
    );
    // How far each code is already accounted for; nothing at or before it is judged again.
    const done = new Map<string, number>();
    const open = new Map<string, { id: string; lastSeen: Date; dirty: boolean }>();
    for (const e of episodes) {
      const until = new Date(e.clearedAt ?? e.lastSeenAt).getTime();
      done.set(e.code, Math.max(done.get(e.code) ?? 0, until));
      if (e.status === 'active') open.set(e.code, { id: e.id, lastSeen: new Date(e.lastSeenAt), dirty: false });
    }

    let opened = 0;
    let cleared = 0;
    for (const { at, active } of deviceFaults(samples, typeof rated === 'number' ? rated : null, thresholds)) {
      for (const p of P_CODES) {
        if (at.getTime() <= (done.get(p.code) ?? 0)) continue;
        const episode = open.get(p.code);
        if (active.has(p.code) && !episode) {
          const [row] = await m.query(
            `INSERT INTO "device_dtc_episode" (
                "tenant_id", "source_system", "external_id", "imei", "protocol", "code",
                "lamp_status", "severity", "status", "first_seen_at", "last_seen_at", "occurrences")
             VALUES ($1, $2, $3, $4, 'pcode', $5, $6, $7, 'active', $8, $8, 1) RETURNING "id"`,
            [machine.tenantId, profile.sourceSystem, machine.externalId, machine.deviceId, p.code, p.lamp, p.severity, at],
          );
          open.set(p.code, { id: row.id, lastSeen: at, dirty: false });
          opened += 1;
        } else if (active.has(p.code) && episode) {
          episode.lastSeen = at;
          episode.dirty = true;
        } else if (!active.has(p.code) && episode) {
          await m.query(
            `UPDATE "device_dtc_episode"
                SET "status" = 'cleared', "cleared_at" = $1, "last_seen_at" = $2, "updated_at" = now()
              WHERE "id" = $3`, [at, episode.lastSeen, episode.id]);
          open.delete(p.code);
          cleared += 1;
        }
      }
    }
    for (const episode of open.values()) {
      if (!episode.dirty) continue;
      await m.query(
        `UPDATE "device_dtc_episode" SET "last_seen_at" = $1, "updated_at" = now() WHERE "id" = $2`,
        [episode.lastSeen, episode.id]);
    }
    return { opened, cleared };
  });
}
