import { DataSource } from 'typeorm';
import { Severity } from '../common/severity';
import { withTenantId } from '../scope/tenant-session';
import { PCode, P_CODES } from './p-code-rules';

interface EpisodeRow { id: string; code: string; status: 'active' | 'cleared'; lastSeenAt: Date; clearedAt: Date | null }

/**
 * A code that clears and comes back within this long is the same trouble, not news: a
 * pump hunting around the low-voltage line would otherwise email everyone each time it
 * crossed. Its episodes are still recorded; only the email is held back.
 */
export const FAULT_EMAIL_QUIET_MINUTES = 30;

/**
 * A code the logger reports that the library does not list. Recorded under its own name
 * rather than dropped: the device is the authority on its faults, and a firmware that
 * learns a seventh code should not go unheard until 2.0 is taught its title.
 */
function unknownCode(code: string): PCode {
  return { code, title: `Device fault ${code}`, lamp: 'amber_warning', severity: Severity.High, currentBased: false };
}

/**
 * Turns the fault codes a logger reported into fault-code episodes on the machine it is
 * claimed onto: opened at the first record that lists a code, seen while records keep
 * listing it, cleared at the first record without it — the device's own lifecycle, not
 * the vehicle DTCs' ten-minute one, which exists because a vehicle's packets say nothing
 * about a code that has gone.
 *
 * The codes are the device's (Motor Logger server payload spec, 25 Nov 2026: a `faults`
 * array in every record), never worked out here from voltage and current. The firmware
 * judges each second against the limits it was flashed with and applies its own
 * three-second rule; a second opinion from 2.0 with other limits only ever disagreed
 * with the pump's own relay (the user's decision, 25 Nov 2026). A record whose `faults`
 * the firmware did not send (`device_faults` null: older firmware, the demo simulator)
 * is not judged at all — it neither opens nor clears anything, because "not said" is not
 * "no fault".
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
    const timeline: { at: Date; active: Set<string> }[] = (await m.query(
      `SELECT "reading_at" AS "at", "device_faults" AS "faults"
         FROM "motor_sensor_records"
        WHERE "device_id" = $1 AND "reading_at" >= $2 AND "reading_at" <= $3 AND "device_faults" IS NOT NULL
        ORDER BY "reading_at", "seq"`,
      [machine.deviceId, machine.from, machine.to],
    )).map((r: { at: Date; faults: string[] }) => ({ at: new Date(r.at), active: new Set(r.faults) }));
    if (!timeline.length) return { opened: 0, cleared: 0 };

    const episodes: EpisodeRow[] = await m.query(
      `SELECT "id", "code", "status", "last_seen_at" AS "lastSeenAt", "cleared_at" AS "clearedAt"
         FROM "device_dtc_episode"
        WHERE "tenant_id" = $1 AND "source_system" = $2 AND "external_id" = $3 AND "protocol" = 'pcode'`,
      [machine.tenantId, profile.sourceSystem, machine.externalId],
    );
    // How far each code is already accounted for; nothing at or before it is judged again.
    const done = new Map<string, number>();
    const open = new Map<string, { id: string; lastSeen: Date; dirty: boolean }>();
    // Every code this pass must follow: the library's, any open one, and any the device
    // named in these records. An open episode of a code the device stops naming clears.
    const known = new Map<string, PCode>(P_CODES.map((p) => [p.code, p]));
    for (const e of episodes) if (!known.has(e.code)) known.set(e.code, unknownCode(e.code));
    for (const { active } of timeline) for (const code of active) if (!known.has(code)) known.set(code, unknownCode(code));
    for (const e of episodes) {
      const until = new Date(e.clearedAt ?? e.lastSeenAt).getTime();
      done.set(e.code, Math.max(done.get(e.code) ?? 0, until));
      if (e.status === 'active') open.set(e.code, { id: e.id, lastSeen: new Date(e.lastSeenAt), dirty: false });
    }

    // When each code last cleared on this machine, for the quiet period above.
    const lastCleared = new Map<string, number>();
    for (const e of episodes) {
      if (e.clearedAt) lastCleared.set(e.code, Math.max(lastCleared.get(e.code) ?? 0, new Date(e.clearedAt).getTime()));
    }

    let opened = 0;
    let cleared = 0;
    for (const { at, active } of timeline) {
      for (const p of known.values()) {
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
          // In the same transaction as the episode, so an email is queued for exactly the
          // episodes that exist (motor-alert-notify.handler.ts). Its time is the reading's:
          // the outbox drops what is over a day old, so a backlog after an outage opens
          // its episodes without emailing about last week.
          const quietSince = lastCleared.get(p.code);
          if (quietSince === undefined || at.getTime() - quietSince > FAULT_EMAIL_QUIET_MINUTES * 60_000) {
            await m.query(
              `INSERT INTO "domain_event" ("event_type", "tenant_id", "subject", "payload", "occurred_at")
               VALUES ('motor.fault_code_raised.v1', $1, $2, $3::jsonb, $4)`,
              [machine.tenantId, row.id, JSON.stringify({
                episodeId: row.id, code: p.code, title: p.title, severity: p.severity, deviceId: machine.deviceId,
                machine: { sourceSystem: profile.sourceSystem, externalId: machine.externalId }, at: at.toISOString(),
              }), at]);
          }
        } else if (active.has(p.code) && episode) {
          episode.lastSeen = at;
          episode.dirty = true;
        } else if (!active.has(p.code) && episode) {
          await m.query(
            `UPDATE "device_dtc_episode"
                SET "status" = 'cleared', "cleared_at" = $1, "last_seen_at" = $2, "updated_at" = now()
              WHERE "id" = $3`, [at, episode.lastSeen, episode.id]);
          open.delete(p.code);
          lastCleared.set(p.code, at.getTime());
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
