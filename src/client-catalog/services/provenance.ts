import { checksumOf } from '../../projection/services/checksum';
import { EquipmentClassProfile } from '../../catalog/entities/equipment-class-profile.entity';
import { ScenarioDefinition } from '../../catalog/entities/scenario-definition.entity';
import { ClientEquipmentClass } from '../entities/client-equipment-class.entity';
import { ClientScenario } from '../entities/client-scenario.entity';
import { AlertRuleTemplate } from '../../catalog/entities/alert-rule-template.entity';
import { AlertRule } from '../../alert/entities/alert-rule.entity';

/**
 * What a copy is hashed on: the fields the client can change.
 *
 * Deliberately not the whole row. Timestamps, ids and the provenance columns move for
 * reasons that have nothing to do with the content, and including them would make
 * every copy look edited the moment it was written — which would make the divergence
 * signal worthless on day one.
 */
export function classContentChecksum(
  c: Pick<EquipmentClassProfile | ClientEquipmentClass, 'name' | 'description' | 'category'
    | 'expectedSignals' | 'failureModes' | 'defaultThresholds'>,
): string {
  return checksumOf({
    name: c.name,
    description: c.description,
    category: c.category,
    expectedSignals: c.expectedSignals,
    failureModes: c.failureModes,
    defaultThresholds: c.defaultThresholds,
  });
}

export function scenarioContentChecksum(
  s: Pick<ScenarioDefinition | ClientScenario, 'name' | 'description' | 'severity' | 'tier'
    | 'requiredSignals' | 'minimumHistoryDays' | 'parameters'>,
): string {
  return checksumOf({
    name: s.name,
    description: s.description,
    severity: s.severity,
    tier: s.tier,
    requiredSignals: s.requiredSignals,
    minimumHistoryDays: s.minimumHistoryDays,
    parameters: s.parameters,
  });
}

/**
 * What an alert rule is hashed on (task P1-128).
 *
 * The fields a client would change to make a shipped rule theirs: what it watches, how
 * hard, how loudly, and whether it is on at all. `enabled` is in the hash deliberately
 * — switching a rule off is the most common edit anybody makes to one, and a copy that
 * still called itself unchanged after being silenced would be lying about the only
 * thing that mattered.
 */
export function alertRuleContentChecksum(
  r: Pick<AlertRule, 'name' | 'description' | 'trigger' | 'params' | 'severity' | 'enabled'>
    | Pick<AlertRuleTemplate, 'name' | 'description' | 'trigger' | 'params' | 'severity'>
      & { enabled: boolean },
): string {
  return checksumOf({
    name: r.name,
    description: r.description,
    trigger: r.trigger,
    params: r.params,
    severity: r.severity,
    enabled: r.enabled,
  });
}

export interface Provenance {
  templateSlug: string | null;
  templateVersion: number | null;
  /** false when the client has changed the content since it was copied. */
  unchangedSinceCopy: boolean;
  /** true when a newer published template version exists than the one copied. */
  newerTemplateAvailable: boolean;
  newerTemplateVersion: number | null;
  copiedAt: Date | null;
}

/**
 * Answers the two questions support actually asks about a client's copy.
 *
 * "Is this still what we shipped?" — compare the content hash against the hash taken
 * at copy time. "Are they on the current version?" — compare the copied version
 * against the latest published template.
 *
 * Both are cheap and neither requires the client to have told anybody they edited
 * something, which they will not have.
 */
export function describeProvenance(
  copy: { templateSlug: string | null; templateVersion: number | null;
          templateChecksum: string | null; copiedAt: Date | null },
  currentChecksum: string,
  latestTemplateVersion: number | null,
): Provenance {
  const newer = copy.templateVersion !== null
    && latestTemplateVersion !== null
    && latestTemplateVersion > copy.templateVersion;

  return {
    templateSlug: copy.templateSlug,
    templateVersion: copy.templateVersion,
    // A copy with no recorded checksum is one the client wrote themselves. Calling
    // that "unchanged" would be a claim about a template it never came from.
    unchangedSinceCopy: copy.templateChecksum !== null && copy.templateChecksum === currentChecksum,
    newerTemplateAvailable: newer,
    newerTemplateVersion: newer ? latestTemplateVersion : null,
    copiedAt: copy.copiedAt,
  };
}
