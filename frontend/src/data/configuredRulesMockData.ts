// UI-only mock of "configured rules" — the client-ui-new demo's RulesPanel
// shows one card per (rule, assigned equipment) pair, filtered by outcome
// type depending on the page (alert on Alerts, prediction on Predictions,
// unfiltered on Scenarios). This is that same flattened shape, ported with
// real fleet equipment instead of invented ids. Rules are created/edited via
// RuleBuilderModal, which mutates MOCK_RULES in place through upsertRule.

export type RuleOutcome = 'kpi' | 'alert' | 'prediction';
export type RuleSeverity = 'Warning' | 'Critical';

export interface ConfiguredRule {
  id: string;
  name: string;
  equipmentId: string;
  sensorKey: string;
  operator: '>' | '<';
  threshold: number;
  unit: string;
  severity: RuleSeverity;
  horizonHours: number;
  enabled: boolean;
  revision: number;
  outcomes: RuleOutcome[];
  kpiValue?: number;
  alertOutcome?: 'No breach' | 'Breach';
  predictionText?: string;
}

export const MOCK_RULES: ConfiguredRule[] = [
  { id: 'r1', name: 'Fuel reserve monitor', equipmentId: '4100460', sensorKey: 'fuel_level', operator: '>', threshold: 224.1958, unit: 'L', severity: 'Warning', horizonHours: 8, enabled: true, revision: 1, outcomes: ['kpi'], kpiValue: 217.4086 },
  { id: 'r2', name: 'Fuel reserve monitor', equipmentId: '4600055', sensorKey: 'fuel_level', operator: '>', threshold: 224.1958, unit: 'L', severity: 'Warning', horizonHours: 8, enabled: true, revision: 1, outcomes: ['kpi'], kpiValue: 162.5112 },
  { id: 'r3', name: 'Fuel reserve monitor', equipmentId: '3100357', sensorKey: 'fuel_level', operator: '>', threshold: 224.1958, unit: 'L', severity: 'Warning', horizonHours: 8, enabled: true, revision: 1, outcomes: ['kpi'], kpiValue: 71.1476 },
  { id: 'r4', name: 'Fuel usage forecast', equipmentId: '4100460', sensorKey: 'fuel_level', operator: '>', threshold: 224.1958, unit: 'L', severity: 'Warning', horizonHours: 8, enabled: true, revision: 1, outcomes: ['prediction'], predictionText: '259.71 L over 8 h. Linear planning projection, not a failure model.' },
  { id: 'r5', name: 'Coolant temperature guard', equipmentId: '3702054', sensorKey: 'coolant_temperature', operator: '>', threshold: 72, unit: '°C', severity: 'Critical', horizonHours: 8, enabled: true, revision: 2, outcomes: ['alert'], alertOutcome: 'Breach' },
  { id: 'r6', name: 'Coolant temperature guard', equipmentId: '4600055', sensorKey: 'coolant_temperature', operator: '>', threshold: 74, unit: '°C', severity: 'Warning', horizonHours: 8, enabled: true, revision: 1, outcomes: ['alert'], alertOutcome: 'No breach' },
];

export function rulesByOutcome(outcome: RuleOutcome): ConfiguredRule[] {
  return MOCK_RULES.filter((r) => r.outcomes.includes(outcome));
}

export function findRule(id: string): ConfiguredRule | undefined {
  return MOCK_RULES.find((r) => r.id === id);
}

// RuleBuilderModal's confirm step calls this once per selected machine — it
// mutates the exported array in place (not a React state setter) so every
// page that imports MOCK_RULES sees the change the next time it mounts,
// without needing a shared store for what's otherwise page-local mock data.
export function upsertRule(rule: ConfiguredRule): void {
  const index = MOCK_RULES.findIndex((r) => r.id === rule.id);
  if (index >= 0) MOCK_RULES[index] = rule;
  else MOCK_RULES.push(rule);
}
