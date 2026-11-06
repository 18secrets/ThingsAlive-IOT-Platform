import { Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { Severity } from '../common/severity';
import { withTenantId } from '../scope/tenant-session';
import { vaniSeverity } from './vani-severity';

const logger = new Logger('VaniPredictionQueue');

/** What the shift runner hands over: the predictions it just wrote for one machine. */
export interface ScoredPrediction {
  id: string;
  clientScenarioSlug: string;
  severity: Severity;
  confidence: string;
  source: string;
  riskScore: number;
  abnormalCount: number;
  occurredAt: Date;
}

export interface PredictionWindow {
  tenantId: string;
  sourceSystem: string;
  externalId: string;
  /** The machine's shift-local date; one call per scenario per one of these. */
  localDate: string;
}

/**
 * Which predictions earn a phone call (decided 2026-11-06, D57 Lane B): live, high or
 * critical, and full confidence. Live because a replay is history being re-scored, not
 * news. Full confidence because "partial" means a signal the scenario needs was
 * missing, and a customer rung on a half-read machine is a customer who stops trusting
 * the next call.
 */
export function worthACall(p: ScoredPrediction): boolean {
  return p.source === 'live'
    && (p.severity === Severity.High || p.severity === Severity.Critical)
    && p.confidence === 'full';
}

/**
 * Asks Vani to call about a prediction that raised no alert (D57, Lane B), as
 * `trigger.kind = trigger_action`. Run by the shift runner after the alert pass, so
 * it can see which predictions an alert already covers.
 *
 * A prediction an alert rule turned into an alert is that alert's call, already
 * queued; calling about it again would ring the customer twice about one thing. So a
 * machine with an open or acknowledged alert from the same scenario gets no
 * prediction call — the alert in hand is the one being dealt with.
 *
 * Its own transaction, after the prediction and the alerts committed: a fault here
 * costs the call, logged, never the scoring.
 */
export async function queueVaniPredictionCalls(
  ds: DataSource, window: PredictionWindow, predictions: ScoredPrediction[],
): Promise<number> {
  const due = predictions.filter(worthACall);
  if (!due.length) return 0;
  try {
    return await withTenantId(ds, window.tenantId, async (m) => {
      const [link]: { vani_account_id: string; customer_phone: string | null; callback_url: string | null;
        machine_id: string; spoken_name: string }[] = await m.query(
        `SELECT a."vani_account_id", a."customer_phone", a."callback_url", l."machine_id", l."spoken_name"
           FROM "vani_machine_link" l
           JOIN "vani_account_link" a ON a."tenant_id" = l."tenant_id"
          WHERE l."tenant_id" = $1 AND l."source_system" = $2 AND l."external_id" = $3 AND a."enabled"`,
        [window.tenantId, window.sourceSystem, window.externalId]);
      if (!link) return 0;

      let queued = 0;
      for (const p of due) {
        const [covered] = await m.query(
          `SELECT 1 FROM "alert_event" a
             JOIN "prediction" p ON p."id" = a."prediction_id"
            WHERE a."tenant_id" = $1 AND a."source_system" = $2 AND a."external_id" = $3
              AND a."state" IN ('open', 'acknowledged') AND p."client_scenario_slug" = $4
            LIMIT 1`,
          [window.tenantId, window.sourceSystem, window.externalId, p.clientScenarioSlug]);
        if (covered) continue;

        const [scenario] = await m.query(
          `SELECT "name" FROM "client_scenario" WHERE "tenant_id" = $1 AND "slug" = $2 LIMIT 1`,
          [window.tenantId, p.clientScenarioSlug]);
        const name: string = scenario?.name ?? p.clientScenarioSlug.replace(/[-_]+/g, ' ');
        const severity = vaniSeverity(p.severity);
        const eventId = randomUUID();
        const statement = predictionStatement(name, link.spoken_name, p);
        const request = {
          // Ours, fresh: there is no alert id to use. Resending it can never ring twice.
          event_id: eventId,
          account_id: link.vani_account_id,
          ...(link.customer_phone ? { customer_phone: link.customer_phone } : {}),
          machine: { machine_id: link.machine_id, name: link.spoken_name },
          trigger: {
            kind: 'trigger_action',
            severity,
            title: `${name} risk on ${link.spoken_name}`,
            fired_at: p.occurredAt.toISOString(),
          },
          // Vani speaks only from this, so it says what the prediction says and no more:
          // no failure window and no recommended action, because 2.0 did not record one.
          context: {
            alert_title: `${name} risk on ${link.spoken_name}`,
            summary: statement,
            prediction: statement,
            // Its own field (D57): how much of the machine the prediction was read from.
            confidence: p.confidence,
          },
          ...(link.callback_url ? { callback_url: link.callback_url } : {}),
        };
        const inserted: unknown[] = await m.query(
          `INSERT INTO "vani_call" ("tenant_id", "kind", "trigger_event_id", "prediction_id", "source_system",
             "external_id", "client_scenario_slug", "trigger_day", "vani_account_id", "machine_id", "severity", "request")
           VALUES ($1, 'trigger_action', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
           ON CONFLICT ("tenant_id", "source_system", "external_id", "client_scenario_slug", "trigger_day")
             WHERE "kind" = 'trigger_action' DO NOTHING
           RETURNING "id"`,
          [window.tenantId, eventId, p.id, window.sourceSystem, window.externalId, p.clientScenarioSlug,
            window.localDate, link.vani_account_id, link.machine_id, severity, JSON.stringify(request)]);
        queued += inserted.length;
      }
      return queued;
    });
  } catch (err) {
    logger.error(`Vani prediction calls for ${window.externalId} were not queued: ${(err as Error).message}`);
    return 0;
  }
}

/** One sentence Vani can say: the scenario, how serious, and what it rests on. */
export function predictionStatement(scenario: string, machine: string, p: ScoredPrediction): string {
  const signals = p.abnormalCount === 1 ? 'one signal' : `${p.abnormalCount} signals`;
  return `The platform's ${scenario} prediction for ${machine} is at ${p.severity} risk, `
    + `${Math.round(p.riskScore)} out of 100, with ${signals} outside their normal range. `
    + 'It was read from every signal that prediction uses.';
}
