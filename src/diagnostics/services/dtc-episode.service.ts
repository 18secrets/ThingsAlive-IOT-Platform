import { Injectable, Logger } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { DeviceDtcEpisode } from '../entities/device-dtc-episode.entity';
import { DecodedTelemetryPacket } from './dtc-packet-decoder';
import { Severity } from '../../common/severity';
import { runTenantSpanning, withTenantId } from '../../scope/tenant-session';

export const CONSECUTIVE_MISSING_THRESHOLD = 3;
/** Absent this long while the engine runs, a code is cleared (plan decision 4, suggested 10 min). */
export const ACTIVE_ABSENT_WINDOW_MS = 10 * 60_000;
/** Cleared episodes older than this are pruned (plan decision 5, suggested 90 days). */
export const DEFAULT_RETENTION_DAYS = 90;

export interface EquipmentFaultItem {
  id: string;
  code: string;
  protocol: string;
  spn: number | null;
  fmi: number | null;
  lamp: string;
  severity: Severity;
  description: string;
  causes: string | null;
  remedies: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  clearedAt?: string | null;
  occurrences: number;
}

export interface EquipmentFaultsResponse {
  reportsFaults: boolean;
  active: EquipmentFaultItem[];
  history: EquipmentFaultItem[];
}

/** The rows an UPDATE … RETURNING gave back: TypeORM's Postgres driver answers an UPDATE with
 * `[rows, count]` and an INSERT with the rows alone. */
const updatedRows = <T>(result: unknown): T[] =>
  (Array.isArray(result) && Array.isArray(result[0]) ? result[0] : result) as T[];

/** An active episode as this service reads it: the columns it compares, under the names it uses. */
interface ActiveRow { id: string; code: string; lastSeenAt: Date; missing: number }

/**
 * Fault-code episodes: one row per code per machine, active until the machine has run
 * without it for ten minutes.
 *
 * Every query runs in a tenant session (`withTenantId`): `device_dtc_episode` forces row
 * level security, and outside a session the policy matches nothing — the first cut queried
 * the pool directly, so it saved nothing and read nothing, and its mocked tests could not
 * tell. The account is still named in every WHERE: the session is the guarantee, the
 * filter is what keeps the plan using the indexes.
 */
@Injectable()
export class DtcEpisodeService {
  private readonly logger = new Logger(DtcEpisodeService.name);

  constructor(private readonly ds: DataSource) {}

  /**
   * One packet that carried codes. A code already active is seen again; a new one opens
   * an episode. The database's one-active-episode index (DtcActiveUnique) settles a race
   * between two passes: the second insert becomes a sighting, never a second episode.
   *
   * Clearing is mostly `sweepClears`' job — a machine whose codes have all gone sends no
   * packet this method sees — but a running packet with other codes still counts as one
   * missing sighting for each code it lacks.
   */
  async processPacket(
    tenantId: string,
    externalId: string,
    packet: DecodedTelemetryPacket,
    sourceSystem = 'ta-2.0',
  ): Promise<{ active: DeviceDtcEpisode[]; cleared: DeviceDtcEpisode[] }> {
    return withTenantId(this.ds, tenantId, async (m: EntityManager) => {
      const existingActive: ActiveRow[] = await m.query(
        `SELECT "id", "code", "last_seen_at" AS "lastSeenAt", "consecutive_missing_count" AS "missing"
           FROM "device_dtc_episode"
          WHERE "tenant_id" = $1 AND "source_system" = $2 AND "external_id" = $3 AND "status" = 'active'
          FOR UPDATE`,
        [tenantId, sourceSystem, externalId],
      );
      const activeMap = new Map(existingActive.map((ep) => [ep.code, ep]));
      const incomingCodes = new Set<string>();
      const updatedEpisodes: DeviceDtcEpisode[] = [];
      const clearedEpisodes: DeviceDtcEpisode[] = [];

      for (const dtc of packet.dtcs) {
        if (incomingCodes.has(dtc.code)) continue;
        incomingCodes.add(dtc.code);
        // Opened, or seen again if it is open already — one statement either way, so two
        // passes racing on the same code cannot both open it.
        const [row] = await m.query(
          `INSERT INTO "device_dtc_episode" (
              "tenant_id", "source_system", "external_id", "imei", "protocol",
              "code", "spn", "fmi", "lamp_status", "severity", "status",
              "first_seen_at", "last_seen_at", "occurrences", "consecutive_missing_count"
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'active', $11, $11, 1, 0)
            ON CONFLICT ("tenant_id", "source_system", "external_id", "protocol", "code") WHERE "status" = 'active'
            DO UPDATE SET
              "last_seen_at" = GREATEST("device_dtc_episode"."last_seen_at", EXCLUDED."last_seen_at"),
              "occurrences" = "device_dtc_episode"."occurrences" + 1,
              "consecutive_missing_count" = 0,
              "lamp_status" = CASE WHEN EXCLUDED."lamp_status" IN ('red_stop', 'protect') THEN EXCLUDED."lamp_status" ELSE "device_dtc_episode"."lamp_status" END,
              "severity" = CASE WHEN EXCLUDED."severity" = 'critical' THEN EXCLUDED."severity" ELSE "device_dtc_episode"."severity" END,
              "updated_at" = now()
            RETURNING *`,
          [
            tenantId, sourceSystem, externalId, packet.imei, dtc.protocol,
            dtc.code, dtc.spn ?? null, dtc.fmi ?? null, dtc.lampStatus, dtc.severity, packet.timestamp,
          ],
        );
        if (row) updatedEpisodes.push(row);
      }

      // Key-off guard: a stopped engine reports nothing about its faults, so its silence
      // clears nothing.
      if (packet.engineRunning !== false) {
        for (const [code, episode] of activeMap) {
          if (incomingCodes.has(code)) continue;
          const missing = Number(episode.missing ?? 0) + 1;
          const msSinceLastSeen = packet.timestamp.getTime() - new Date(episode.lastSeenAt).getTime();
          if (missing >= CONSECUTIVE_MISSING_THRESHOLD && msSinceLastSeen >= ACTIVE_ABSENT_WINDOW_MS) {
            const [cleared] = updatedRows<DeviceDtcEpisode>(await m.query(
              `UPDATE "device_dtc_episode"
                  SET "status" = 'cleared', "cleared_at" = $1, "consecutive_missing_count" = $2, "updated_at" = now()
                WHERE "id" = $3
                RETURNING *`,
              [packet.timestamp, missing, episode.id],
            ));
            if (cleared) clearedEpisodes.push(cleared);
          } else {
            await m.query(
              `UPDATE "device_dtc_episode" SET "consecutive_missing_count" = $1, "updated_at" = now() WHERE "id" = $2`,
              [missing, episode.id],
            );
          }
        }
      }

      return { active: updatedEpisodes, cleared: clearedEpisodes };
    });
  }

  /**
   * Clears every code the machine has run without for ten minutes.
   *
   * `latestRunningAt` is the machine's newest packet with the engine running, codes or not
   * (`LegacyPacketReader.latestRunningPackets`). The sync processes the coded packets first,
   * so a code still present has a `last_seen_at` within reach of it; one that is not, has
   * gone. Cleared at the moment the absence was confirmed, not backdated.
   */
  async sweepClears(
    tenantId: string, sourceSystem: string, externalId: string, latestRunningAt: Date,
  ): Promise<DeviceDtcEpisode[]> {
    return withTenantId(this.ds, tenantId, async (m) => updatedRows<DeviceDtcEpisode>(await m.query(
      `UPDATE "device_dtc_episode"
          SET "status" = 'cleared', "cleared_at" = $4, "updated_at" = now()
        WHERE "tenant_id" = $1 AND "source_system" = $2 AND "external_id" = $3
          AND "status" = 'active'
          AND "last_seen_at" <= $4::timestamptz - make_interval(secs => $5)
        RETURNING *`,
      [tenantId, sourceSystem, externalId, latestRunningAt, ACTIVE_ABSENT_WINDOW_MS / 1000],
    )));
  }

  /**
   * The machine's fault codes for its page: whether its device reports codes at all, the
   * active ones (red lamp first) and the 20 most recent cleared, each with its meaning,
   * lamp, causes and remedies from the mirrored 1.0 list. A device never pulled and never
   * coded reads `reportsFaults: false`, and the page shows no panel.
   */
  async getEquipmentFaults(
    tenantId: string,
    sourceSystem: string,
    externalId: string,
  ): Promise<EquipmentFaultsResponse> {
    return withTenantId(this.ds, tenantId, async (m) => {
      const [presence] = await m.query(
        `SELECT EXISTS (
           SELECT 1 FROM "device_dtc_episode"
            WHERE "tenant_id" = $1 AND "source_system" = $2 AND "external_id" = $3
         ) AS has_episodes,
         EXISTS (
           SELECT 1 FROM "device_projection" d
             JOIN "dtc_pull_watermark" w ON w.imei = d.imei
            WHERE d.tenant_id = $1 AND d.source_system = $2 AND d.equipment_external_id = $3
         ) AS has_watermark`,
        [tenantId, sourceSystem, externalId],
      );
      if (!presence?.has_episodes && !presence?.has_watermark) {
        return { reportsFaults: false, active: [], history: [] };
      }

      const rows = await m.query(
        `SELECT e.id, e.code, e.protocol, e.spn, e.fmi, e.status,
                COALESCE(NULLIF(mc.lamp, 'none'), e.lamp_status) AS lamp,
                COALESCE(mc.severity, e.severity) AS severity,
                e.first_seen_at AS "firstSeenAt", e.last_seen_at AS "lastSeenAt", e.cleared_at AS "clearedAt",
                e.occurrences,
                COALESCE(mc.description, e.code) AS description, mc.causes, mc.remedies
           FROM "device_dtc_episode" e
           LEFT JOIN "dtc_master_catalog" mc ON mc.protocol = e.protocol AND mc.code = e.code
          WHERE e.tenant_id = $1 AND e.source_system = $2 AND e.external_id = $3
          ORDER BY CASE WHEN e.status = 'active' THEN 0 ELSE 1 END,
                   CASE COALESCE(NULLIF(mc.lamp, 'none'), e.lamp_status)
                     WHEN 'red_stop' THEN 0 WHEN 'protect' THEN 1 WHEN 'amber_warning' THEN 2 ELSE 3 END,
                   e.last_seen_at DESC`,
        [tenantId, sourceSystem, externalId],
      );

      const active: EquipmentFaultItem[] = [];
      const history: EquipmentFaultItem[] = [];
      for (const r of rows) {
        const item: EquipmentFaultItem = {
          id: r.id, code: r.code, protocol: r.protocol, spn: r.spn ?? null, fmi: r.fmi ?? null,
          lamp: r.lamp, severity: r.severity, description: r.description,
          causes: r.causes ?? null, remedies: r.remedies ?? null,
          firstSeenAt: new Date(r.firstSeenAt).toISOString(),
          lastSeenAt: new Date(r.lastSeenAt).toISOString(),
          clearedAt: r.clearedAt ? new Date(r.clearedAt).toISOString() : null,
          occurrences: Number(r.occurrences ?? 1),
        };
        if (r.status === 'active') active.push(item);
        else if (history.length < 20) history.push(item);
      }
      return { reportsFaults: true, active, history };
    });
  }

  /** The machine's active episodes, newest first. */
  async getActiveEpisodes(tenantId: string, externalId: string, sourceSystem?: string): Promise<DeviceDtcEpisode[]> {
    return withTenantId(this.ds, tenantId, (m) => m.query(
      `SELECT * FROM "device_dtc_episode"
        WHERE "tenant_id" = $1 AND "external_id" = $2 AND "status" = 'active'
          AND ($3::text IS NULL OR "source_system" = $3)
        ORDER BY "last_seen_at" DESC`,
      [tenantId, externalId, sourceSystem ?? null],
    ));
  }

  /** Episodes that overlap a time window, newest first. */
  async getHistory(
    tenantId: string,
    externalId: string,
    from?: Date,
    to?: Date,
    sourceSystem?: string,
  ): Promise<DeviceDtcEpisode[]> {
    return withTenantId(this.ds, tenantId, (m) => m.query(
      `SELECT * FROM "device_dtc_episode"
        WHERE "tenant_id" = $1 AND "external_id" = $2
          AND ($3::text IS NULL OR "source_system" = $3)
          AND ($4::timestamptz IS NULL OR "last_seen_at" >= $4)
          AND ($5::timestamptz IS NULL OR "first_seen_at" <= $5)
        ORDER BY "first_seen_at" DESC`,
      [tenantId, externalId, sourceSystem ?? null, from ?? null, to ?? null],
    ));
  }

  /** Prunes cleared episodes past retention, across every account (a scheduled job). */
  async pruneHistory(olderThanDays = DEFAULT_RETENTION_DAYS): Promise<number> {
    const cutoff = new Date(Date.now() - olderThanDays * 86_400_000);
    return runTenantSpanning(this.ds, 'dtc history prune', async (m) => {
      const result = await m.query(
        `DELETE FROM "device_dtc_episode" WHERE "status" = 'cleared' AND "cleared_at" < $1`,
        [cutoff],
      );
      return Number(result?.[1] ?? 0);
    });
  }
}
