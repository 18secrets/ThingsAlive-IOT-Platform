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
  /** The rest only with `VANI_SNAPSHOT_DETAIL=true` (D57, Lane C). */
  recent_alerts?: SnapshotAlert[];
  open_work_orders?: SnapshotWorkOrder[];
  open_predictions?: SnapshotPrediction[];
}

/** An alert from the last `RECENT_ALERT_DAYS`, and what became of it. */
export interface SnapshotAlert {
  title: string;
  severity: string;
  state: string;
  fired_at: string;
  /** What whoever resolved it wrote, when it was resolved. */
  resolution?: string;
}

export interface SnapshotWorkOrder {
  reference: string;
  title: string;
  status: string;
  due_at?: string;
}

/** The latest live reading of a scenario that is saying something. */
export interface SnapshotPrediction {
  scenario: string;
  severity: string;
  risk_score: number;
  confidence: string;
  scored_at: string;
}

export const RECENT_ALERT_DAYS = 30;
export const RECENT_ALERT_LIMIT = 5;
/** A prediction older than this is not "open": the machine has been scored since, or has stopped reporting. */
export const OPEN_PREDICTION_DAYS = 7;

/** Off unless switched on: Vani may refuse fields it does not read yet, and a refusal stops every snapshot. */
export function snapshotDetailOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.VANI_SNAPSHOT_DETAIL === 'true';
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
    private readonly env: NodeJS.ProcessEnv = process.env,
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

      const machines = await snapshotMachines(m, tenantId, snapshotDetailOn(this.env), now);
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

/**
 * Every linked machine in the account, with what is open on it, in a stable order.
 *
 * With `detail`, each machine also carries its recent alerts and what became of them,
 * its open jobs, and the predictions saying something — the spec's §4 named-machine
 * review, so Vani can walk an account before anyone asks a question (D57, Lane C).
 * Still only what 2.0 holds: no health card, because there is no health score.
 */
export async function snapshotMachines(
  m: EntityManager, tenantId: string, detail = false, now = new Date(),
): Promise<SnapshotMachine[]> {
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
  const machines: SnapshotMachine[] = rows.map((r) => ({
    machine_id: r.machine_id,
    name: r.spoken_name,
    status: r.open === 0
      ? 'No open alerts'
      : r.open === 1
        ? `One open alert: ${r.worst}`
        : `${r.open} open alerts, the most serious: ${r.worst}`,
  }));
  if (!detail) return machines;

  // Tenant-spanning connection, so every query names the tenant itself.
  const since = new Date(now.getTime() - RECENT_ALERT_DAYS * 86_400_000);
  const alerts: { machine_id: string; rule_name: string; severity: string; state: string; fired_at: Date;
    resolution_note: string | null }[] = await m.query(
    `SELECT machine_id, rule_name, severity, state, fired_at, resolution_note FROM (
       SELECT l."machine_id", a."rule_name", a."severity", a."state", a."fired_at", a."resolution_note",
              row_number() OVER (PARTITION BY l."machine_id" ORDER BY a."fired_at" DESC, a."id") AS n
         FROM "vani_machine_link" l
         JOIN "alert_event" a ON a."tenant_id" = l."tenant_id" AND a."source_system" = l."source_system"
                             AND a."external_id" = l."external_id"
        WHERE l."tenant_id" = $1 AND a."fired_at" >= $2) x
      WHERE n <= $3
      ORDER BY machine_id, fired_at DESC`,
    [tenantId, since, RECENT_ALERT_LIMIT]);
  const jobs: { machine_id: string; reference: string; title: string; status: string; due_at: Date | null }[] = await m.query(
    `SELECT l."machine_id", w."reference", w."title", w."status", w."due_at"
       FROM "vani_machine_link" l
       JOIN "work_order" w ON w."tenant_id" = l."tenant_id" AND w."source_system" = l."source_system"
                          AND w."external_id" = l."external_id"
      WHERE l."tenant_id" = $1 AND w."status" IN ('created', 'in-progress')
      ORDER BY l."machine_id", w."due_at" NULLS LAST, w."reference"`,
    [tenantId]);
  const predictionsSince = new Date(now.getTime() - OPEN_PREDICTION_DAYS * 86_400_000);
  // The latest live score of each scenario, kept when it says something: medium or
  // worse, from at least part of the machine. A replay is history, not the machine now.
  const predictions: { machine_id: string; slug: string; name: string | null; severity: string; risk_score: number;
    confidence: string; occurred_at: Date }[] = await m.query(
    `SELECT machine_id, slug, name, severity, risk_score, confidence, occurred_at FROM (
       SELECT DISTINCT ON (l."machine_id", p."client_scenario_slug")
              l."machine_id", p."client_scenario_slug" AS slug,
              (SELECT s."name" FROM "client_scenario" s WHERE s."tenant_id" = p."tenant_id"
                 AND s."slug" = p."client_scenario_slug" LIMIT 1) AS name,
              p."severity", p."risk_score", p."confidence", p."occurred_at"
         FROM "vani_machine_link" l
         JOIN "prediction" p ON p."tenant_id" = l."tenant_id" AND p."source_system" = l."source_system"
                            AND p."external_id" = l."external_id"
        WHERE l."tenant_id" = $1 AND p."source" = 'live' AND p."occurred_at" >= $2
        ORDER BY l."machine_id", p."client_scenario_slug", p."occurred_at" DESC) latest
      WHERE severity IN ('medium', 'high', 'critical') AND confidence <> 'none'
      ORDER BY machine_id, CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 ELSE 2 END, slug`,
    [tenantId, predictionsSince]);

  return machines.map((machine) => ({
    ...machine,
    recent_alerts: alerts.filter((a) => a.machine_id === machine.machine_id).map((a) => ({
      title: a.rule_name, severity: a.severity, state: a.state, fired_at: new Date(a.fired_at).toISOString(),
      ...(a.state === 'resolved' && a.resolution_note ? { resolution: a.resolution_note } : {}),
    })),
    open_work_orders: jobs.filter((j) => j.machine_id === machine.machine_id).map((j) => ({
      reference: j.reference, title: j.title, status: j.status,
      ...(j.due_at ? { due_at: new Date(j.due_at).toISOString() } : {}),
    })),
    open_predictions: predictions.filter((p) => p.machine_id === machine.machine_id).map((p) => ({
      scenario: p.name ?? p.slug.replace(/[-_]+/g, ' '),
      severity: p.severity,
      // Rounded: a score moving by a fraction each shift is not news, and would re-push
      // the whole account every time it did.
      risk_score: Math.round(Number(p.risk_score)),
      confidence: p.confidence,
      scored_at: new Date(p.occurred_at).toISOString(),
    })),
  }));
}
