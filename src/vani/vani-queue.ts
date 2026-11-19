import { Logger } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { AlertEvent } from '../alert/entities/alert-event.entity';
import { vaniSeverity } from './vani-severity';
import { healthCardSentence } from '../machine-health/health-score';
import { healthIn, healthKey } from '../machine-health/machine-health';
import { speakableSummary } from './vani-speech';

const logger = new Logger('VaniQueue');

/**
 * Asks for a Vani call about each alert that just fired on a linked machine, in the
 * transaction that fired it (integration guide §6.2).
 *
 * Written here and sent later by `VaniCallSender`, so the alert and the request to
 * phone about it commit together: a crash between the two can neither lose the call
 * nor phone about an alert that was rolled back. Nothing is sent from inside the
 * alert's transaction — a slow Vani must never hold up alerting.
 *
 * Inside a savepoint, because a fault in this optional step must not cost the alert
 * itself. A lost call request is logged; a lost alert would be silent.
 */
export async function queueVaniCalls(m: EntityManager, tenantId: string, alerts: AlertEvent[]): Promise<number> {
  if (!alerts.length) return 0;
  await m.query('SAVEPOINT vani_queue');
  try {
    let queued = 0;
    for (const alert of alerts) {
      queued += await queueOne(m, tenantId, alert);
    }
    await m.query('RELEASE SAVEPOINT vani_queue');
    return queued;
  } catch (err) {
    await m.query('ROLLBACK TO SAVEPOINT vani_queue');
    logger.error(`Vani call requests for ${tenantId} were not queued: ${(err as Error).message}`);
    return 0;
  }
}

async function queueOne(m: EntityManager, tenantId: string, alert: AlertEvent): Promise<number> {
  const [link]: { vani_account_id: string; customer_phone: string | null; callback_url: string | null;
    machine_id: string; spoken_name: string }[] = await m.query(
    `SELECT a."vani_account_id", a."customer_phone", a."callback_url", l."machine_id", l."spoken_name"
       FROM "vani_machine_link" l
       JOIN "vani_account_link" a ON a."tenant_id" = l."tenant_id"
      WHERE l."tenant_id" = $1 AND l."source_system" = $2 AND l."external_id" = $3 AND a."enabled"`,
    [tenantId, alert.sourceSystem, alert.externalId],
  );
  if (!link) return 0;

  // Read now, not at send time: the request is the record of what the customer could
  // have been told, so an edit to the rule after the alert fired must not change it.
  const [rule]: { recommended_action: string | null }[] = await m.query(
    `SELECT "recommended_action" FROM "alert_rule" WHERE "tenant_id" = $1 AND "id" = $2`,
    [tenantId, alert.ruleId],
  );
  const recommendedAction = rule?.recommended_action?.trim() || null;
  const healthCard = await healthCardFor(m, tenantId, alert);

  const severity = vaniSeverity(alert.severity);
  const request = {
    // The alert id is Vani's idempotency key: resending this body can never ring twice.
    event_id: alert.id,
    account_id: link.vani_account_id,
    ...(link.customer_phone ? { customer_phone: link.customer_phone } : {}),
    machine: { machine_id: link.machine_id, name: link.spoken_name },
    trigger: {
      kind: 'alert',
      severity,
      title: alert.ruleName,
      ...(alert.firedAt ? { fired_at: alert.firedAt.toISOString() } : {}),
    },
    // Vani speaks only from this. It carries what the alert actually says and nothing
    // more: a prediction window or a health score that 2.0 did not record would be
    // words put in Vani's mouth. The recommended action is sent only when someone
    // wrote one on the rule (`1765800000000-AlertRecommendedAction.ts`).
    context: {
      alert_title: alert.ruleName,
      // Said aloud, so composed from the alert's evidence rather than the engine's
      // screen wording (`vani-speech.ts`).
      summary: speakableSummary(alert, link.spoken_name),
      ...(recommendedAction ? { recommended_action: recommendedAction } : {}),
      // The machine's health score now, with this alert in it (D63). Left out when the
      // machine cannot be scored: Vani says nothing about health rather than a guess.
      ...(healthCard ? { health_card: healthCard } : {}),
    },
    ...(link.callback_url ? { callback_url: link.callback_url } : {}),
  };

  const inserted: unknown[] = await m.query(
    `INSERT INTO "vani_call" ("tenant_id", "alert_event_id", "vani_account_id", "machine_id", "severity", "request")
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)
     ON CONFLICT ("tenant_id", "alert_event_id") DO NOTHING
     RETURNING "id"`,
    [tenantId, alert.id, link.vani_account_id, link.machine_id, severity, JSON.stringify(request)],
  );
  return inserted.length;
}

/**
 * The health card for the call, in its own savepoint: the score reads the service
 * forecast and the logger state, and a fault in either must cost the card, never the
 * call request beside it.
 */
async function healthCardFor(m: EntityManager, tenantId: string, alert: AlertEvent): Promise<string | null> {
  await m.query('SAVEPOINT vani_health');
  try {
    const ref = { sourceSystem: alert.sourceSystem, externalId: alert.externalId };
    const health = (await healthIn(m, tenantId, [ref])).get(healthKey(ref));
    await m.query('RELEASE SAVEPOINT vani_health');
    return health ? healthCardSentence(health) : null;
  } catch (err) {
    await m.query('ROLLBACK TO SAVEPOINT vani_health');
    logger.warn(`No health card for the call about alert ${alert.id}: ${(err as Error).message}`);
    return null;
  }
}
