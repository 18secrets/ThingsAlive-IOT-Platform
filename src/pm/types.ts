/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Predictive Maintenance module — shared data model.
 */

export type ParamStatus = 'normal' | 'warning' | 'critical';

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'none';

export type ChipTone = 'critical' | 'warning' | 'normal';

export interface TrendPoint {
  /** Days ago, 0 = today, larger = further in the past. */
  daysAgo: number;
  value: number;
  /** 90-day rolling baseline band for this point. */
  baselineLow: number;
  baselineHigh: number;
}

export interface ParameterReading {
  key: string;
  label: string;
  unit: string;
  current: number;
  baseline: number;
  deviationPct: number;
  status: ParamStatus;
  zScore: number;
  /** 90-day history, oldest first. */
  history: TrendPoint[];
  /** Plain-English explanation — only set when this parameter is contributing to risk. */
  reason?: string;
  /** Days since this parameter started trending away from baseline (undefined if normal). */
  deviationStartedDaysAgo?: number;
}

export interface AbnormalParamChip {
  label: string;
  tone: ChipTone;
}

export type MachineType =
  | 'Excavator'
  | 'Wheel Loader'
  | 'Mobile Crane'
  | 'Diesel Genset'
  | 'Air Compressor'
  | 'Bulldozer';

export interface Machine {
  id: string;
  name: string;
  type: MachineType;
  model: string;
  serial: string;
  site: string;
  region: string;
  riskScore: number;
  healthScore: number;
  severity: Severity;
  engineRuntimeHrs: number;
  lastServiceDate: string;
  predictedServiceWindow: string;
  trendingDays: number;
  abnormalSignalsCount: number;
  totalSignalsMonitored: number;
  abnormalParameters: AbnormalParamChip[];
  parameters: ParameterReading[];
  recommendedAction: string;
  highPriorityFlag: boolean;
}

export interface FleetSummary {
  totalMachines: number;
  healthy: number;
  attention: number;
  critical: number;
  avgFleetHealth: number;
  maintenanceDue: number;
  riskDistribution: { healthy: number; attention: number; critical: number };
  riskTrend90d: { daysAgo: number; avgRisk: number }[];
}

export interface FuelTheftEvent {
  id: string;
  machineId: string;
  machineName: string;
  site: string;
  windowStart: string;
  windowEnd: string;
  fuelDropPct: number;
  fuelDropLiters: number;
  ignitionStatus: 'Off' | 'On';
  gpsStatus: 'Stationary' | 'Moving';
  status: 'Suspected' | 'Confirmed' | 'Dismissed';
}

export interface UtilizationRow {
  machineId: string;
  machineName: string;
  site: string;
  productiveHrs: number;
  idleHrs: number;
  offHrs: number;
  utilizationPct: number;
}

export type GeofenceEventType = 'Boundary Exit' | 'After-Hours Movement' | 'Unauthorized Relocation';

export interface GeofenceEvent {
  id: string;
  machineId: string;
  machineName: string;
  site: string;
  type: GeofenceEventType;
  timestamp: string;
  location: string;
  status: 'Open' | 'Acknowledged' | 'Resolved';
}

export interface DeviceHealthRow {
  deviceId: string;
  imei: string;
  machineName: string;
  site: string;
  gsmSignalPct: number;
  packetDropPct: number;
  lastSeen: string;
  serialGapCount: number;
  status: 'Healthy' | 'Degraded' | 'Offline';
}

export interface OperatorScore {
  operatorId: string;
  operatorName: string;
  site: string;
  machineName: string;
  harshEvents: number;
  idleRatioPct: number;
  throttleLoadRatio: number;
  score: number;
}

export interface BenchmarkRow {
  model: string;
  unitsCount: number;
  fuelPerHour: number;
  fleetAvgFuelPerHour: number;
  deltaPct: number;
}

export interface EmissionsRow {
  site: string;
  machinesCount: number;
  fuelConsumedLiters: number;
  estimatedCO2Tons: number;
}

export interface WarrantyRecord {
  id: string;
  machineId: string;
  machineName: string;
  incidentDate: string;
  description: string;
  loadAtIncidentPct: number;
  tempAtIncidentC: number;
  withinNormalBounds: boolean;
  verdict: 'Normal Operation' | 'Genuine Defect' | 'Under Investigation';
}
