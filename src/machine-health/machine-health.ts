import { EntityManager } from 'typeorm';
import { Severity } from '../common/severity';
import { LinkState } from '../device-health/services/link-health';
import { onboardedMachines } from '../onboarding/mapped-devices';
import { Confidence } from '../prediction/services/tier1';
import { fleetForecastIn } from '../service/services/service-forecast.service';
import { HealthInput, HealthScore, scoreHealth } from './health-score';

/** A prediction older than this is not the machine now. The same week Vani's snapshot uses. */
export const HEALTH_PREDICTION_DAYS = 7;

export interface MachineKey { sourceSystem: string; externalId: string }

const key = (k: MachineKey) => `${k.sourceSystem}\u0000${k.externalId}`;

/**
 * The health score of each of these machines, read inside a transaction the caller
 * already holds for this tenant — a person's session, or a tenant-spanning worker's,
 * which is why every query names the tenant itself.
 *
 * One query per input across all the machines asked about, not one per machine: the
 * snapshot scores an account's whole linked fleet on every pass.
 */
export async function healthIn(
  m: EntityManager, tenantId: string, machines: MachineKey[], now = new Date(),
): Promise<Map<string, HealthScore>> {
  const out = new Map<string, HealthScore>();
  if (!machines.length) return out;
  const externalIds = [...new Set(machines.map((x) => x.externalId))];

  const onboarded = await onboardedMachines(m, tenantId, externalIds, now);

  const links: { source_system: string; external_id: string; state: LinkState; window_end: Date }[] = await m.query(
    `SELECT DISTINCT ON ("source_system", "external_id") "source_system", "external_id", "state", "window_end"
       FROM "device_link_health"
      WHERE "tenant_id" = $1 AND "external_id" = ANY($2::text[])
      ORDER BY "source_system", "external_id", "window_end" DESC`,
    [tenantId, externalIds]);

  const alerts: { source_system: string; external_id: string; severity: Severity; rule_name: string }[] = await m.query(
    `SELECT "source_system", "external_id", "severity", "rule_name"
       FROM "alert_event"
      WHERE "tenant_id" = $1 AND "external_id" = ANY($2::text[]) AND "state" IN ('open', 'acknowledged')`,
    [tenantId, externalIds]);

  // The latest live score of each scenario this week. A replay is history, not the machine now.
  const predictions: { source_system: string; external_id: string; slug: string; risk_score: number;
    confidence: Confidence }[] = await m.query(
    `SELECT DISTINCT ON ("source_system", "external_id", "client_scenario_slug")
            "source_system", "external_id", "client_scenario_slug" AS slug, "risk_score", "confidence"
       FROM "prediction"
      WHERE "tenant_id" = $1 AND "external_id" = ANY($2::text[]) AND "source" = 'live' AND "occurred_at" >= $3
      ORDER BY "source_system", "external_id", "client_scenario_slug", "occurred_at" DESC`,
    [tenantId, externalIds, new Date(now.getTime() - HEALTH_PREDICTION_DAYS * 86_400_000)]);

  // Service status from the same forecast the service screen shows, narrowed to these machines.
  const forecast = await fleetForecastIn(m, tenantId, externalIds, now);

  for (const machine of machines) {
    const k = key(machine);
    const mine = <T extends { source_system: string; external_id: string }>(rows: T[]) =>
      rows.filter((r) => key({ sourceSystem: r.source_system, externalId: r.external_id }) === k);
    const link = mine(links)[0];
    const input: HealthInput = {
      onboarded: onboarded.has(machine.externalId),
      link: link?.state ?? null,
      linkMeasuredAt: link ? new Date(link.window_end) : null,
      now,
      alerts: mine(alerts).map((a) => ({ severity: a.severity, title: a.rule_name })),
      predictions: mine(predictions).map((p) => ({ scenario: p.slug, riskScore: Number(p.risk_score), confidence: p.confidence })),
      service: forecast.assets.find((a) => a.sourceSystem === machine.sourceSystem && a.externalId === machine.externalId)?.status ?? null,
    };
    out.set(k, scoreHealth(input));
  }
  return out;
}

export const healthKey = key;
