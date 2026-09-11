/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Predictive Maintenance — data-service layer.
 *
 * One async function per screen's data need, backed by mock data for now. Every
 * function returns a Promise so screens can later be pointed at a real API
 * without any component changes.
 */

import {
  BENCHMARK_ROWS,
  DEVICE_HEALTH_ROWS,
  EMISSIONS_ROWS,
  FLEET_RISK_TREND_90D,
  FUEL_THEFT_EVENTS,
  GEOFENCE_EVENTS,
  MACHINES,
  OPERATOR_SCORES,
  UTILIZATION_ROWS,
  WARRANTY_RECORDS,
  getMachine,
} from './mockData';
import {
  BenchmarkRow,
  DeviceHealthRow,
  EmissionsRow,
  FleetSummary,
  FuelTheftEvent,
  GeofenceEvent,
  Machine,
  OperatorScore,
  UtilizationRow,
  WarrantyRecord,
} from './types';

const NETWORK_DELAY_MS = 220;

function delay<T>(value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), NETWORK_DELAY_MS));
}

/** Deep-ish clone so callers can't mutate the shared mock store. */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

// ---------------------------------------------------------------------------
// Predictive Maintenance — Overview
// ---------------------------------------------------------------------------

export async function fetchFleetSummary(): Promise<FleetSummary> {
  const healthy = MACHINES.filter((m) => m.severity === 'none' || m.severity === 'low').length;
  const attention = MACHINES.filter((m) => m.severity === 'medium').length;
  const critical = MACHINES.filter((m) => m.severity === 'critical' || m.severity === 'high').length;
  const avgFleetHealth = Math.round((MACHINES.reduce((s, m) => s + m.healthScore, 0) / MACHINES.length) * 10) / 10;
  const maintenanceDue = MACHINES.filter((m) => m.severity === 'critical' || m.severity === 'high').length;
  return delay(
    clone({
      totalMachines: MACHINES.length,
      healthy,
      attention,
      critical,
      avgFleetHealth,
      maintenanceDue,
      riskDistribution: { healthy, attention, critical },
      riskTrend90d: FLEET_RISK_TREND_90D,
    }),
  );
}

export async function fetchMachinesAtRisk(): Promise<Machine[]> {
  const ranked = [...MACHINES].sort((a, b) => b.riskScore - a.riskScore);
  return delay(clone(ranked));
}

// ---------------------------------------------------------------------------
// Machine Details / Predictive Trends — shared machine lookups
// ---------------------------------------------------------------------------

export async function fetchAllMachines(): Promise<Machine[]> {
  return delay(clone(MACHINES));
}

export async function fetchMachineById(id: string): Promise<Machine | undefined> {
  return delay(clone(getMachine(id)));
}

// ---------------------------------------------------------------------------
// Action Center — maintenance queue grouped into lanes
// ---------------------------------------------------------------------------

export async function fetchActionQueue(): Promise<{ critical: Machine[]; high: Machine[]; medium: Machine[]; upcoming: Machine[] }> {
  const bySeverity = (sev: Machine['severity']) => MACHINES.filter((m) => m.severity === sev).sort((a, b) => b.riskScore - a.riskScore);
  return delay(
    clone({
      critical: bySeverity('critical'),
      high: bySeverity('high'),
      medium: bySeverity('medium'),
      upcoming: MACHINES.filter((m) => m.severity === 'low' || m.severity === 'none').sort((a, b) => b.riskScore - a.riskScore),
    }),
  );
}

// ---------------------------------------------------------------------------
// Monitoring
// ---------------------------------------------------------------------------

export async function fetchFuelTheftEvents(): Promise<FuelTheftEvent[]> {
  return delay(clone(FUEL_THEFT_EVENTS));
}

export async function fetchUtilizationRows(): Promise<UtilizationRow[]> {
  return delay(clone(UTILIZATION_ROWS));
}

export async function fetchGeofenceEvents(): Promise<GeofenceEvent[]> {
  return delay(clone(GEOFENCE_EVENTS));
}

export async function fetchDeviceHealthRows(): Promise<DeviceHealthRow[]> {
  return delay(clone(DEVICE_HEALTH_ROWS));
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

export async function fetchOperatorScores(): Promise<OperatorScore[]> {
  return delay(clone(OPERATOR_SCORES));
}

export async function fetchBenchmarkRows(): Promise<BenchmarkRow[]> {
  return delay(clone(BENCHMARK_ROWS));
}

export async function fetchEmissionsRows(): Promise<EmissionsRow[]> {
  return delay(clone(EMISSIONS_ROWS));
}

export async function fetchWarrantyRecords(): Promise<WarrantyRecord[]> {
  return delay(clone(WARRANTY_RECORDS));
}
