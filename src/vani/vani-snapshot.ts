import { Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { DataSource, EntityManager } from 'typeorm';
import { runTenantSpanning } from '../scope/tenant-session';
import { VaniBreaker } from './vani-breaker';
import { VaniTransport } from './vani-client';
import { VaniAccountLink } from './vani.entities';

/** After a failed push (not a refusal), wait this long before trying the same picture again. */
export const SNAPSHOT_RETRY_MS = 5 * 60 * 1000;

export interface SnapshotMachine {
  machine_id: string;
  name: string;
  status: string;
}

export interface SnapshotResult {
  pushed: number;
  unchanged: number;
  refused: number;
  failed: number;
}

/**
 * Tells Vani what each linked account's machines look like now, so a customer who
 * phones in can ask about them (integration guide §6.4).
 *
 * Pushed only when the picture changed since Vani last accepted one: a machine linked
 * or unlinked, renamed, or its open alerts different. The first pass after an account
 * is linked always pushes, which is the guide's "once right after Step 2".
 *
 * The status line is what Vani reads out, so it says only what 2.0 actually knows —
 * which alerts are open on the machine. There is no `health_score`: 2.0 does not keep
 * one, and a number made up to fill the field would be read to a customer as fact.
 */
export class VaniSnapshotPusher {
  private readonly logger = new Logger(VaniSnapshotPusher.name);

  constructor(
    private readonly ds: DataSource,
    private readonly vani: VaniTransport,
    private readonly breaker: VaniBreaker = new VaniBreaker(),
  ) {}

  async pass(now = new Date()): Promise<SnapshotResult> {
    const result: SnapshotResult = { pushed: 0, unchanged: 0, refused: 0, failed: 0 };
    if (!this.vani.configured) return result;
    const tenants: { tenant_id: string }[] = await runTenantSpanning(this.ds, 'vani snapshot list', (m) =>
      m.query(`SELECT "tenant_id" FROM "vani_account_link" WHERE "enabled" ORDER BY "tenant_id"`));
    for (const { tenant_id } of tenants) {
      // Shared with the call sender: an outage seen by either holds both.
      if (!this.breaker.allows(now)) break;
      let vani = 'none' as 'up' | 'down' | 'none';
      const outcome = await this.one(tenant_id, now, (health) => { vani = health; });
      if (outcome) result[outcome] += 1;
      if (vani === 'down') { this.breaker.failed(now); break; }
      if (vani === 'up') this.breaker.succeeded();
      else this.breaker.release();
    }
    return result;
  }

  private one(tenantId: string, now: Date, saw: (health: 'up' | 'down') => void): Promise<keyof SnapshotResult | null> {
    return runTenantSpanning(this.ds, 'vani snapshot push', async (m) => {
      // Locked so two schedulers do not both push the same picture. Harmless if they
      // did — Vani keeps the newest — but pointless.
      const [locked] = await m.query(
        `SELECT 1 FROM "vani_account_link" WHERE "tenant_id" = $1 AND "enabled" FOR NO KEY UPDATE SKIP LOCKED`,
        [tenantId],
      );
      if (!locked) return null;
      const repo = m.getRepository(VaniAccountLink);
      const link = (await repo.findOneBy({ tenantId }))!;

      const machines = await snapshotMachines(m, tenantId);
      const hash = createHash('sha256').update(JSON.stringify(machines)).digest('hex');
      if (hash === link.snapshotHash) return 'unchanged';
      if (hash === link.snapshotRefusedHash) return 'unchanged';
      if (link.snapshotError && link.snapshotAttemptedAt
        && now.getTime() - link.snapshotAttemptedAt.getTime() < SNAPSHOT_RETRY_MS) {
        return 'unchanged';
      }

      const body = { account_id: link.vaniAccountId, generated_at: now.toISOString(), machines };
      let status: number;
      let answer: Record<string, unknown>;
      try {
        ({ status, body: answer } = await this.vani.post('/platform/account-snapshot', body));
      } catch (err) {
        saw('down');
        await repo.update(tenantId, { snapshotAttemptedAt: now, snapshotError: `Vani could not be reached: ${(err as Error).message}` });
        return 'failed';
      }
      saw(VaniBreaker.isFailure(status) ? 'down' : 'up');
      if (status === 200) {
        await repo.update(tenantId, {
          snapshotHash: hash, snapshotPushedAt: now, snapshotAttemptedAt: now, snapshotError: null, snapshotRefusedHash: null,
        });
        return 'pushed';
      }
      const reason = typeof answer.error === 'string' ? answer.error : `Vani answered ${status}`;
      if (status === 422) {
        await repo.update(tenantId, { snapshotAttemptedAt: now, snapshotError: reason, snapshotRefusedHash: hash });
        this.logger.warn(`Vani refused the snapshot for ${link.vaniAccountId}: ${reason}`);
        return 'refused';
      }
      await repo.update(tenantId, {
        snapshotAttemptedAt: now,
        snapshotError: status === 401 ? 'Vani refused the platform token (401); check VANI_PLATFORM_TOKEN' : reason,
      });
      return 'failed';
    });
  }
}

/** Every linked machine in the account, with what is open on it, in a stable order. */
export async function snapshotMachines(m: EntityManager, tenantId: string): Promise<SnapshotMachine[]> {
  const rows: { machine_id: string; spoken_name: string; open: number; worst: string | null }[] = await m.query(
    `SELECT l."machine_id", l."spoken_name",
            count(a."id")::int AS "open",
            (array_agg(a."rule_name" ORDER BY
               CASE a."severity" WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END,
               a."fired_at" DESC) FILTER (WHERE a."id" IS NOT NULL))[1] AS "worst"
       FROM "vani_machine_link" l
       LEFT JOIN "alert_event" a
         ON a."tenant_id" = l."tenant_id" AND a."source_system" = l."source_system"
        AND a."external_id" = l."external_id" AND a."state" IN ('open', 'acknowledged')
      WHERE l."tenant_id" = $1
      GROUP BY l."machine_id", l."spoken_name"
      ORDER BY l."machine_id"`,
    [tenantId],
  );
  return rows.map((r) => ({
    machine_id: r.machine_id,
    name: r.spoken_name,
    status: r.open === 0
      ? 'No open alerts'
      : r.open === 1
        ? `One open alert: ${r.worst}`
        : `${r.open} open alerts, the most serious: ${r.worst}`,
  }));
}
