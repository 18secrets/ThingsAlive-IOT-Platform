// UI-only mock data for the client-facing Work Orders and Cost Administration
// pages — no backend yet. `equipmentCode` references real ids from
// fleetMockData.ts so these pages read as the same fleet as Alerts/Dashboard
// instead of each inventing separate machines.

export type WorkOrderStatus = 'Open' | 'In Progress' | 'On Hold' | 'Completed' | 'Cancelled';
export type WorkOrderPriority = 'Low' | 'Medium' | 'High';

export interface MockWorkOrder {
  id: string;
  title: string;
  equipmentCode: string;
  equipmentName: string;
  status: WorkOrderStatus;
  priority: WorkOrderPriority;
  channel: 'Text' | 'Email' | 'Phone' | 'Things Service';
  contact: string;
  createdAt: string;
  notes?: string;
}

// Manually-created work orders, shown after the ones generated from current
// coolant-range breaches (see fleetMockData.ts's isBreaching + WorkOrdersPage).
export const MOCK_WORK_ORDERS: MockWorkOrder[] = [
  { id: 'wo-1', title: 'Replace cabin air filter', equipmentCode: '3800061', equipmentName: 'ROCK BODY TIPPER - 35 MT', status: 'On Hold', priority: 'Low', channel: 'Things Service', contact: '', createdAt: '2026-09-27T10:00:00+05:30', notes: 'Awaiting part delivery.' },
  { id: 'wo-2', title: 'Quarterly battery check', equipmentCode: '4700064', equipmentName: 'CAT Motor Grader 120H', status: 'Completed', priority: 'Low', channel: 'Things Service', contact: '', createdAt: '2026-09-20T09:00:00+05:30' },
];

export type CostScope = 'administration' | 'client' | 'site' | 'equipment';
export type CostRole = 'administrator' | 'client-admin' | 'operator';
export const costFields = ['fuelPerL', 'oilPerL', 'maintenance', 'filterReplacement', 'downtimePerHour', 'baselineFuelPerHour', 'implementationCost'] as const;
export type CostField = typeof costFields[number];

export const COST_FIELD_LABELS: Record<CostField, string> = {
  fuelPerL: 'Fuel / litre',
  oilPerL: 'Oil / litre',
  maintenance: 'Maintenance / event',
  filterReplacement: 'Filter replacement / event',
  downtimePerHour: 'Downtime / hour',
  baselineFuelPerHour: 'Fuel baseline (litres / hour)',
  implementationCost: 'Implementation cost (analysis period)',
};

export interface MockCostProfile {
  id: string;
  scope: CostScope;
  target: string;
  currency: string;
  effectiveFrom: string;
  fuelPerL: number | null;
  oilPerL: number | null;
  maintenance: number | null;
  filterReplacement: number | null;
  downtimePerHour: number | null;
  baselineFuelPerHour: number | null;
  implementationCost: number | null;
}

export function mayEditCost(role: CostRole, scope: CostScope): boolean {
  return role === 'administrator' || (role === 'client-admin' && scope !== 'administration');
}

export const MOCK_COST_PROFILES: MockCostProfile[] = [
  { id: 'cp-1', scope: 'client', target: 'default', currency: 'INR', effectiveFrom: '2026-01-01', fuelPerL: 96.5, oilPerL: 420, maintenance: 4200, filterReplacement: 850, downtimePerHour: 1800, baselineFuelPerHour: 18.5, implementationCost: null },
];

// Same precedence as lib/costs.ts's resolveCosts in the client-ui-new demo:
// equipment → site → client → administration, null = inherit from the next
// broader scope, never zero.
export function resolveCostsFor(date: string, location: string, equipmentId: string): { currency: string | null; values: Record<CostField, number | null> } {
  const levels: [CostScope, string][] = [['administration', '*'], ['client', 'default'], ['site', location], ['equipment', equipmentId]];
  const values = Object.fromEntries(costFields.map((f) => [f, null])) as Record<CostField, number | null>;
  let currency: string | null = null;
  for (const [scope, target] of levels) {
    const profile = MOCK_COST_PROFILES
      .filter((p) => p.scope === scope && p.target === target && p.effectiveFrom <= date)
      .sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom))
      .at(-1);
    if (!profile) continue;
    currency = profile.currency;
    for (const f of costFields) if (profile[f] !== null) values[f] = profile[f];
  }
  return { currency, values };
}
