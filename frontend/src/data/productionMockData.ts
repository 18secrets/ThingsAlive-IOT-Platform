// UI-only mock data for the client-facing Production Monitoring page — no
// backend yet. Reuses fleetMockData's existing breach signal rather than
// inventing a second one: a machine currently past its demonstration coolant
// range counts as both "offline" for output purposes (2h downtime instead of
// 0) and as the source of its "active configured alerts" figure — the same
// concept ThingsCare and ThingsShield already surface, not a new one.

import { FleetThing, isBreaching, thingsCareFor } from './fleetMockData';

const SCHEDULED_HOURS = 112;

export interface ProductionSummary {
  oeePercent: number;
  uptimeHours: number;
  downtimeHours: number;
  activeAlerts: number;
}

export function productionSummaryFor(thing: FleetThing): ProductionSummary {
  const seed = Number(thing.id.replace(/\D/g, '')) || 1;
  const breaching = isBreaching(thing);
  const oeePercent = Math.round((65 + (seed % 16) - (breaching ? 6 : 0)) * 10) / 10;
  const downtimeHours = breaching ? 2 : 0;
  return {
    oeePercent,
    uptimeHours: SCHEDULED_HOURS - downtimeHours,
    downtimeHours,
    activeAlerts: thingsCareFor(thing).alertCount,
  };
}
