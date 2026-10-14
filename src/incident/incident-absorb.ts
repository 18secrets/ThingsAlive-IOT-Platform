import { EntityManager } from 'typeorm';
import { AlertEvent } from '../alert/entities/alert-event.entity';
import { Severity, SEVERITY_ORDER } from '../common/severity';

const rank = (s: string) => SEVERITY_ORDER.indexOf(s as Severity);
const plusMinutes = (at: Date, minutes: number) => new Date(at.getTime() + minutes * 60_000);

/**
 * Gather newly fired alerts into incidents, in the transaction that fired them.
 *
 * An alert on a machine with no live incident opens one; on a machine with one, it
 * joins it — and a worse alert raises the incident's severity and pulls its SLA clock
 * in to the tighter promise, never out. The insert is race-safe on its own:
 * `uq_incident_live_per_machine` makes a second concurrent opener a no-op, after which
 * both join the one row. Called from `AlertService.evaluateWindow`, the one place
 * alerts fire; a plain function rather than a service so the alert module gains no
 * dependency on this one.
 */
export async function absorbAlerts(m: EntityManager, tenantId: string, alerts: AlertEvent[]): Promise<void> {
  for (const alert of alerts) {
    const at = alert.firedAt ?? new Date();
    const policy: { ack: number; resolve: number } | undefined = (await m.query(
      `SELECT "ack_within_minutes" AS ack, "resolve_within_minutes" AS resolve
         FROM "incident_sla_policy" WHERE "tenant_id" = $1 AND "severity" = $2`, [tenantId, alert.severity],
    ))[0];

    const [opened] = await m.query(
      `INSERT INTO "incident" ("tenant_id", "source_system", "external_id", "severity", "opened_at", "ack_due_at", "resolve_due_at")
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT ("tenant_id", "source_system", "external_id") WHERE "status" <> 'resolved' DO NOTHING
       RETURNING "id"`,
      [tenantId, alert.sourceSystem, alert.externalId, alert.severity, at,
        policy ? plusMinutes(at, policy.ack) : null, policy ? plusMinutes(at, policy.resolve) : null],
    );
    const [live] = await m.query(
      `SELECT "id", "severity", "opened_at", "ack_due_at", "resolve_due_at" FROM "incident"
        WHERE "tenant_id" = $1 AND "source_system" = $2 AND "external_id" = $3 AND "status" <> 'resolved'
        FOR UPDATE`,
      [tenantId, alert.sourceSystem, alert.externalId],
    );

    await m.query(
      `INSERT INTO "incident_alert" ("incident_id", "alert_event_id", "tenant_id", "linked_at")
       VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`, [live.id, alert.id, tenantId, at],
    );
    const event = (kind: string, detail: Record<string, unknown>) => m.query(
      `INSERT INTO "incident_event" ("tenant_id", "incident_id", "kind", "actor", "at", "detail")
       VALUES ($1, $2, $3, 'system', $4, $5::jsonb)`, [tenantId, live.id, kind, at, JSON.stringify(detail)],
    );
    if (opened) {
      await event('opened', { alertId: alert.id, severity: alert.severity, slaPolicy: policy ?? null });
      continue;
    }
    await event('alert_linked', { alertId: alert.id, severity: alert.severity });

    if (rank(alert.severity) > rank(live.severity)) {
      // Measured from when the incident opened: the machine has been in trouble since
      // then, and a worse alert is less time to answer, not a fresh start.
      const openedAt = new Date(live.opened_at);
      const tighter = (current: Date | null, minutes: number | undefined) => {
        if (minutes === undefined) return current;
        const candidate = plusMinutes(openedAt, minutes);
        return current && new Date(current) < candidate ? new Date(current) : candidate;
      };
      await m.query(
        `UPDATE "incident" SET "severity" = $2, "ack_due_at" = $3, "resolve_due_at" = $4, "updated_at" = now()
          WHERE "id" = $1`,
        [live.id, alert.severity, tighter(live.ack_due_at, policy?.ack), tighter(live.resolve_due_at, policy?.resolve)],
      );
      await event('severity_raised', { from: live.severity, to: alert.severity, alertId: alert.id });
    }
  }
}
