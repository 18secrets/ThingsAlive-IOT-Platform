/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Predictive Maintenance module — realistic mock data.
 *
 * All machine risk figures (z-scores, composite risk score, abnormal parameter
 * chips, signal counts) are DERIVED from the same generated parameter history in
 * `generateMachine()` below, so a machine's "X/Y signals" badge, its abnormal
 * parameter chips, and its "Why is this machine high-risk?" panel can never drift
 * out of sync with one another — they all read from `machine.parameters`.
 */

import {
  AbnormalParamChip,
  BenchmarkRow,
  DeviceHealthRow,
  EmissionsRow,
  FuelTheftEvent,
  GeofenceEvent,
  Machine,
  MachineType,
  OperatorScore,
  ParameterReading,
  TrendPoint,
  UtilizationRow,
  WarrantyRecord,
} from './types';
import {
  HIGH_PRIORITY_SIGNAL_THRESHOLD,
  chipToneFromStatus,
  compositeRiskScore,
  severityFromRiskScore,
  statusFromZScore,
} from './riskLogic';

// ---------------------------------------------------------------------------
// Deterministic PRNG so every screen sees the exact same history for a given
// machine/parameter on every render, without stashing generated data in state.
// ---------------------------------------------------------------------------

function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return h >>> 0;
}

function mulberry32(seed: number) {
  let a = seed;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;

/** 2026-09-11 — kept fixed so predicted-service-window dates don't drift between renders. */
export const REFERENCE_DATE = new Date('2026-09-11T00:00:00');

function formatDate(d: Date): string {
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

function addDays(d: Date, days: number): Date {
  const next = new Date(d);
  next.setDate(next.getDate() + days);
  return next;
}

function formatDateRange(startOffsetDays: number, endOffsetDays: number): string {
  const start = addDays(REFERENCE_DATE, startOffsetDays);
  const end = addDays(REFERENCE_DATE, endOffsetDays);
  const sameMonth = start.getMonth() === end.getMonth() && start.getFullYear() === end.getFullYear();
  if (sameMonth) {
    return `${start.getDate()}–${end.getDate()} ${end.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' })}`;
  }
  return `${formatDate(start)} – ${formatDate(end)}`;
}

// ---------------------------------------------------------------------------
// Parameter definitions
// ---------------------------------------------------------------------------

interface ParamDef {
  key: string;
  label: string;
  unit: string;
  baseline: number;
  stdDev: number;
}

const PARAM_DEFS: Record<string, ParamDef> = {
  coolantTemp: { key: 'coolantTemp', label: 'Coolant Temperature', unit: '°C', baseline: 84, stdDev: 4.2 },
  oilPressure: { key: 'oilPressure', label: 'Oil Pressure', unit: 'bar', baseline: 4.6, stdDev: 0.35 },
  oilTemp: { key: 'oilTemp', label: 'Oil Temperature', unit: '°C', baseline: 88, stdDev: 4.5 },
  hydraulicOilTemp: { key: 'hydraulicOilTemp', label: 'Hydraulic Oil Temp', unit: '°C', baseline: 62, stdDev: 4.8 },
  fuelEfficiency: { key: 'fuelEfficiency', label: 'Fuel Consumption Rate', unit: 'L/hr', baseline: 11.2, stdDev: 1.1 },
  load: { key: 'load', label: 'Engine Load', unit: '%', baseline: 58, stdDev: 7.5 },
  throttle: { key: 'throttle', label: 'Throttle Position', unit: '%', baseline: 54, stdDev: 6.8 },
  torque: { key: 'torque', label: 'Torque Output', unit: 'Nm', baseline: 470, stdDev: 42 },
};

const PARAM_ORDER = ['coolantTemp', 'oilPressure', 'oilTemp', 'hydraulicOilTemp', 'fuelEfficiency', 'load', 'throttle', 'torque'];

const TYPE_PARAMS: Record<MachineType, string[]> = {
  'Excavator': PARAM_ORDER,
  'Wheel Loader': PARAM_ORDER,
  'Mobile Crane': PARAM_ORDER,
  'Bulldozer': PARAM_ORDER,
  'Diesel Genset': ['coolantTemp', 'oilPressure', 'oilTemp', 'fuelEfficiency', 'load', 'throttle', 'torque'],
  'Air Compressor': ['coolantTemp', 'oilPressure', 'oilTemp', 'fuelEfficiency', 'load'],
};

function reasonFor(def: ParamDef, zScore: number): string {
  const worse = zScore >= 0 ? 'above' : 'below';
  const pct = Math.round(Math.abs(zScore) * (def.stdDev / def.baseline) * 100);
  switch (def.key) {
    case 'coolantTemp':
      return `Coolant temperature is running ${pct}% ${worse} its 90-day baseline, consistent with a cooling system restriction or thermostat fault.`;
    case 'oilPressure':
      return zScore < 0
        ? `Oil pressure has dropped ${pct}% below baseline, an early indicator of pump wear or a developing lubrication leak.`
        : `Oil pressure is reading ${pct}% above baseline, which can indicate a stuck relief valve.`;
    case 'oilTemp':
      return `Oil temperature is trending ${pct}% ${worse} baseline, suggesting reduced lubrication efficiency or a cooling fault.`;
    case 'hydraulicOilTemp':
      return `Hydraulic oil temperature is running ${pct}% ${worse} baseline, pointing to a possible cooler blockage or fluid degradation.`;
    case 'fuelEfficiency':
      return `Fuel consumption per hour has risen ${pct}% above baseline for a similar duty cycle, a common early sign of injector fouling or air filter restriction.`;
    case 'load':
      return `Engine load is sustained ${pct}% ${worse} its typical baseline, indicating the machine may be operating outside its rated duty cycle.`;
    case 'throttle':
      return `Throttle position is trending ${pct}% ${worse} baseline, consistent with harsher-than-usual operator usage.`;
    case 'torque':
      return `Torque output has deviated ${pct}% ${worse} baseline, which can indicate transmission or drivetrain stress.`;
    default:
      return `${def.label} has deviated ${pct}% ${worse} its 90-day baseline.`;
  }
}

function recommendedActionFor(abnormal: ParameterReading[], severity: string): string {
  if (abnormal.length === 0) {
    return 'No action needed — continue standard monitoring cadence.';
  }
  const keys = new Set(abnormal.map((p) => p.key));
  if (keys.has('hydraulicOilTemp') && keys.has('oilPressure')) {
    return 'Schedule a hydraulic system and lubrication inspection before next deployment.';
  }
  if (keys.has('oilPressure')) {
    return 'Inspect oil pump and lubrication lines; verify no active leak before continued operation.';
  }
  if (keys.has('coolantTemp') || keys.has('oilTemp') || keys.has('hydraulicOilTemp')) {
    return 'Inspect cooling system (radiator, fans, coolant level) at next service window.';
  }
  if (keys.has('fuelEfficiency')) {
    return 'Check air filter and fuel injectors — consumption is trending above baseline.';
  }
  if (keys.has('throttle') || keys.has('load') || keys.has('torque')) {
    return 'Review operator usage pattern and duty cycle against rated specification.';
  }
  return severity === 'critical' ? 'Schedule immediate inspection.' : 'Schedule inspection at next planned downtime.';
}

interface AbnormalSpec {
  key: string;
  /** Signed target z-score the parameter drifts toward. */
  targetZ: number;
  startDaysAgo: number;
}

interface MachineSeed {
  id: string;
  name: string;
  type: MachineType;
  model: string;
  serial: string;
  site: string;
  region: string;
  lastServiceOffsetDays: number;
  engineRuntimeHrs: number;
  abnormal: AbnormalSpec[];
}

function buildHistory(
  rng: () => number,
  def: ParamDef,
  spec?: AbnormalSpec,
): { history: TrendPoint[]; current: number; zScore: number } {
  const bandLow = round2(def.baseline - 1.4 * def.stdDev);
  const bandHigh = round2(def.baseline + 1.4 * def.stdDev);
  const history: TrendPoint[] = [];
  let current = def.baseline;
  for (let daysAgo = 89; daysAgo >= 0; daysAgo--) {
    const noise = (rng() - 0.5) * def.stdDev * 0.55;
    let value = def.baseline + noise;
    if (spec && daysAgo <= spec.startDaysAgo) {
      const progress = 1 - daysAgo / spec.startDaysAgo;
      const eased = progress * progress * (3 - 2 * progress); // smoothstep
      value = def.baseline + spec.targetZ * def.stdDev * eased + noise * 0.4;
    }
    history.push({ daysAgo, value: round2(value), baselineLow: bandLow, baselineHigh: bandHigh });
    current = value;
  }
  const zScore = round2((current - def.baseline) / def.stdDev);
  return { history, current: round2(current), zScore };
}

function generateMachine(seed: MachineSeed): Machine {
  const applicableKeys = TYPE_PARAMS[seed.type];
  const parameters: ParameterReading[] = applicableKeys.map((key) => {
    const def = PARAM_DEFS[key];
    const spec = seed.abnormal.find((a) => a.key === key);
    const rng = mulberry32(hashString(`${seed.id}-${key}`));
    const { history, current, zScore } = buildHistory(rng, def, spec);
    const status = statusFromZScore(zScore);
    const deviationPct = round1(((current - def.baseline) / def.baseline) * 100);
    return {
      key,
      label: def.label,
      unit: def.unit,
      current,
      baseline: def.baseline,
      deviationPct,
      status,
      zScore,
      history,
      reason: status !== 'normal' ? reasonFor(def, zScore) : undefined,
      deviationStartedDaysAgo: spec?.startDaysAgo,
    };
  });

  const abnormal = parameters.filter((p) => p.status !== 'normal');
  const abnormalParameters: AbnormalParamChip[] = abnormal.map((p) => ({
    label: p.label,
    tone: chipToneFromStatus(p.status),
  }));
  const riskScore = compositeRiskScore(parameters.map((p) => p.zScore));
  const healthScore = Math.max(3, Math.min(100, Math.round(100 - riskScore * 0.8 - (abnormal.length >= HIGH_PRIORITY_SIGNAL_THRESHOLD ? 4 : 0))));
  const severity = severityFromRiskScore(riskScore);
  const trendingDays = abnormal.length > 0 ? Math.max(...abnormal.map((p) => p.deviationStartedDaysAgo ?? 0)) : 0;
  const highPriorityFlag = abnormal.length >= HIGH_PRIORITY_SIGNAL_THRESHOLD;

  const serviceOffsets: Record<string, [number, number]> = {
    critical: [1, 6],
    high: [5, 14],
    medium: [14, 28],
    low: [30, 50],
    none: [55, 80],
  };
  const [lo, hi] = serviceOffsets[severity];
  const predictedServiceWindow = formatDateRange(lo, hi);

  return {
    id: seed.id,
    name: seed.name,
    type: seed.type,
    model: seed.model,
    serial: seed.serial,
    site: seed.site,
    region: seed.region,
    riskScore,
    healthScore,
    severity,
    engineRuntimeHrs: seed.engineRuntimeHrs,
    lastServiceDate: formatDate(addDays(REFERENCE_DATE, -seed.lastServiceOffsetDays)),
    predictedServiceWindow,
    trendingDays,
    abnormalSignalsCount: abnormal.length,
    totalSignalsMonitored: parameters.length,
    abnormalParameters,
    parameters,
    recommendedAction: recommendedActionFor(abnormal, severity),
    highPriorityFlag,
  };
}

// ---------------------------------------------------------------------------
// Fleet roster
// ---------------------------------------------------------------------------

const SITES = [
  { site: 'Lucknow Infrastructure Plant', region: 'North' },
  { site: 'Pune Automotive Plant', region: 'West' },
  { site: 'CBM Central Works', region: 'Central' },
  { site: 'Nagpur Mining Division', region: 'Central' },
  { site: 'Ahmedabad Logistics Yard', region: 'West' },
  { site: 'Chennai Port Works', region: 'South' },
];

const MACHINE_SEEDS: MachineSeed[] = [
  { id: 'EXC-101', name: 'Volvo EC210 Crawler Excavator', type: 'Excavator', model: 'EC210', serial: 'VLV-EC210-8841', ...SITES[0], lastServiceOffsetDays: 128, engineRuntimeHrs: 9840, abnormal: [
    { key: 'hydraulicOilTemp', targetZ: 3.2, startDaysAgo: 45 },
    { key: 'oilPressure', targetZ: -2.8, startDaysAgo: 30 },
    { key: 'coolantTemp', targetZ: 2.6, startDaysAgo: 20 },
  ] },
  { id: 'EXC-102', name: 'CAT 320D Excavator', type: 'Excavator', model: '320D', serial: 'CAT-320D-2217', ...SITES[3], lastServiceOffsetDays: 74, engineRuntimeHrs: 7120, abnormal: [
    { key: 'oilTemp', targetZ: 2.9, startDaysAgo: 25 },
    { key: 'hydraulicOilTemp', targetZ: 2.1, startDaysAgo: 15 },
  ] },
  { id: 'LDR-201', name: 'JCB 3DX Backhoe Loader', type: 'Wheel Loader', model: '3DX', serial: 'JCB-3DX-5502', ...SITES[1], lastServiceOffsetDays: 41, engineRuntimeHrs: 5310, abnormal: [
    { key: 'throttle', targetZ: 1.8, startDaysAgo: 10 },
  ] },
  { id: 'LDR-202', name: 'Komatsu WA380 Wheel Loader', type: 'Wheel Loader', model: 'WA380', serial: 'KMT-WA380-9034', ...SITES[5], lastServiceOffsetDays: 22, engineRuntimeHrs: 4460, abnormal: [
    { key: 'load', targetZ: 1.6, startDaysAgo: 8 },
  ] },
  { id: 'CRN-301', name: 'Liebherr LTM 1090-4.2 Crane', type: 'Mobile Crane', model: 'LTM 1090-4.2', serial: 'LBH-LTM1090-1123', ...SITES[0], lastServiceOffsetDays: 151, engineRuntimeHrs: 11260, abnormal: [
    { key: 'torque', targetZ: 3.5, startDaysAgo: 50 },
    { key: 'throttle', targetZ: 2.7, startDaysAgo: 35 },
    { key: 'load', targetZ: 2.5, startDaysAgo: 28 },
    { key: 'coolantTemp', targetZ: 1.9, startDaysAgo: 12 },
  ] },
  { id: 'CRN-302', name: 'Tata Hitachi Zaxis 220 Crane', type: 'Mobile Crane', model: 'Zaxis 220', serial: 'TH-ZX220-3391', ...SITES[4], lastServiceOffsetDays: 18, engineRuntimeHrs: 3120, abnormal: [] },
  { id: 'GEN-401', name: 'Cummins PowerCommand C500 Genset', type: 'Diesel Genset', model: 'PowerCommand C500', serial: 'CMN-PC500-7710', ...SITES[2], lastServiceOffsetDays: 96, engineRuntimeHrs: 15420, abnormal: [
    { key: 'coolantTemp', targetZ: 2.8, startDaysAgo: 22 },
    { key: 'oilPressure', targetZ: -2.4, startDaysAgo: 18 },
    { key: 'fuelEfficiency', targetZ: 1.7, startDaysAgo: 9 },
  ] },
  { id: 'GEN-402', name: 'Mahindra Powerol 320kVA Genset', type: 'Diesel Genset', model: 'Powerol 320kVA', serial: 'MHN-PWL320-4402', ...SITES[3], lastServiceOffsetDays: 12, engineRuntimeHrs: 6040, abnormal: [] },
  { id: 'GEN-403', name: 'Kirloskar Green 500kVA Genset', type: 'Diesel Genset', model: 'Green 500kVA', serial: 'KLK-GRN500-2298', ...SITES[1], lastServiceOffsetDays: 58, engineRuntimeHrs: 8890, abnormal: [
    { key: 'oilTemp', targetZ: 2.0, startDaysAgo: 14 },
  ] },
  { id: 'CMP-501', name: 'Atlas Copco XAS 90 Compressor', type: 'Air Compressor', model: 'XAS 90', serial: 'ATC-XAS90-6650', ...SITES[2], lastServiceOffsetDays: 33, engineRuntimeHrs: 3980, abnormal: [
    { key: 'fuelEfficiency', targetZ: 1.5, startDaysAgo: 6 },
  ] },
  { id: 'CMP-502', name: 'Ingersoll Rand P185 Compressor', type: 'Air Compressor', model: 'P185', serial: 'IGR-P185-1587', ...SITES[5], lastServiceOffsetDays: 9, engineRuntimeHrs: 2210, abnormal: [] },
  { id: 'DZR-601', name: 'Komatsu D65 Bulldozer', type: 'Bulldozer', model: 'D65', serial: 'KMT-D65-4471', ...SITES[0], lastServiceOffsetDays: 142, engineRuntimeHrs: 10580, abnormal: [
    { key: 'oilPressure', targetZ: -3.4, startDaysAgo: 55 },
    { key: 'hydraulicOilTemp', targetZ: 3.0, startDaysAgo: 40 },
    { key: 'coolantTemp', targetZ: 2.6, startDaysAgo: 24 },
  ] },
  { id: 'DZR-602', name: 'BEML BD80 Bulldozer', type: 'Bulldozer', model: 'BD80', serial: 'BEML-BD80-9928', ...SITES[4], lastServiceOffsetDays: 67, engineRuntimeHrs: 6710, abnormal: [
    { key: 'hydraulicOilTemp', targetZ: 2.6, startDaysAgo: 20 },
    { key: 'torque', targetZ: -2.2, startDaysAgo: 15 },
  ] },
  { id: 'EXC-103', name: 'Tata Hitachi EX 200 Excavator', type: 'Excavator', model: 'EX 200', serial: 'TH-EX200-3305', ...SITES[1], lastServiceOffsetDays: 51, engineRuntimeHrs: 5990, abnormal: [
    { key: 'coolantTemp', targetZ: 1.9, startDaysAgo: 11 },
  ] },
  { id: 'EXC-104', name: 'Hyundai R220 Excavator', type: 'Excavator', model: 'R220', serial: 'HYD-R220-7743', ...SITES[3], lastServiceOffsetDays: 27, engineRuntimeHrs: 4120, abnormal: [
    { key: 'oilPressure', targetZ: -1.6, startDaysAgo: 7 },
  ] },
  { id: 'LDR-203', name: 'CAT 950 Wheel Loader', type: 'Wheel Loader', model: '950', serial: 'CAT-950-1129', ...SITES[2], lastServiceOffsetDays: 15, engineRuntimeHrs: 3450, abnormal: [] },
  { id: 'LDR-204', name: 'Volvo L120 Wheel Loader', type: 'Wheel Loader', model: 'L120', serial: 'VLV-L120-8867', ...SITES[5], lastServiceOffsetDays: 63, engineRuntimeHrs: 7280, abnormal: [
    { key: 'throttle', targetZ: 2.1, startDaysAgo: 16 },
    { key: 'load', targetZ: 1.7, startDaysAgo: 13 },
  ] },
  { id: 'CRN-303', name: 'Sany STC250 Mobile Crane', type: 'Mobile Crane', model: 'STC250', serial: 'SNY-STC250-4415', ...SITES[0], lastServiceOffsetDays: 39, engineRuntimeHrs: 4980, abnormal: [
    { key: 'torque', targetZ: 1.5, startDaysAgo: 9 },
  ] },
  { id: 'GEN-404', name: 'Cummins C150 Genset', type: 'Diesel Genset', model: 'C150', serial: 'CMN-C150-3367', ...SITES[4], lastServiceOffsetDays: 20, engineRuntimeHrs: 3890, abnormal: [] },
  { id: 'GEN-405', name: 'Caterpillar C9 Genset', type: 'Diesel Genset', model: 'C9', serial: 'CAT-C9-8821', ...SITES[2], lastServiceOffsetDays: 83, engineRuntimeHrs: 9640, abnormal: [
    { key: 'coolantTemp', targetZ: 2.5, startDaysAgo: 19 },
    { key: 'fuelEfficiency', targetZ: 2.3, startDaysAgo: 17 },
    { key: 'oilPressure', targetZ: -1.9, startDaysAgo: 12 },
  ] },
  { id: 'CMP-503', name: 'Kaeser ASD Compressor', type: 'Air Compressor', model: 'ASD', serial: 'KSR-ASD-5541', ...SITES[3], lastServiceOffsetDays: 44, engineRuntimeHrs: 4750, abnormal: [
    { key: 'oilTemp', targetZ: 1.8, startDaysAgo: 10 },
  ] },
  { id: 'DZR-603', name: 'CAT D6 Bulldozer', type: 'Bulldozer', model: 'D6', serial: 'CAT-D6-2260', ...SITES[1], lastServiceOffsetDays: 36, engineRuntimeHrs: 5540, abnormal: [
    { key: 'coolantTemp', targetZ: 1.6, startDaysAgo: 8 },
  ] },
  { id: 'EXC-105', name: 'Liebherr R936 Excavator', type: 'Excavator', model: 'R936', serial: 'LBH-R936-6602', ...SITES[5], lastServiceOffsetDays: 10, engineRuntimeHrs: 2870, abnormal: [] },
  { id: 'CRN-304', name: 'Terex RT555 Rough Terrain Crane', type: 'Mobile Crane', model: 'RT555', serial: 'TRX-RT555-9915', ...SITES[0], lastServiceOffsetDays: 55, engineRuntimeHrs: 6330, abnormal: [
    { key: 'hydraulicOilTemp', targetZ: 2.0, startDaysAgo: 14 },
    { key: 'oilPressure', targetZ: -1.6, startDaysAgo: 9 },
  ] },
];

export const MACHINES: Machine[] = MACHINE_SEEDS.map(generateMachine);

export function getMachine(id: string): Machine | undefined {
  return MACHINES.find((m) => m.id === id);
}

// ---------------------------------------------------------------------------
// Fleet risk trend (90 days) — average composite risk across the fleet,
// trending up over the last ~6 weeks as more signals start drifting.
// ---------------------------------------------------------------------------

export const FLEET_RISK_TREND_90D: { daysAgo: number; avgRisk: number }[] = (() => {
  const rng = mulberry32(hashString('fleet-risk-trend'));
  const points: { daysAgo: number; avgRisk: number }[] = [];
  const base = 22;
  for (let daysAgo = 89; daysAgo >= 0; daysAgo--) {
    const progress = 1 - daysAgo / 89;
    const eased = progress * progress;
    const noise = (rng() - 0.5) * 3;
    const avgRisk = base + eased * 14 + noise;
    points.push({ daysAgo, avgRisk: Math.max(8, Math.round(avgRisk * 10) / 10) });
  }
  return points;
})();

// ---------------------------------------------------------------------------
// Fuel theft detection
// ---------------------------------------------------------------------------

export const FUEL_THEFT_EVENTS: FuelTheftEvent[] = [
  { id: 'FT-001', machineId: 'GEN-401', machineName: 'Cummins PowerCommand C500 Genset', site: 'CBM Central Works', windowStart: '10 Sep 2026, 23:40', windowEnd: '11 Sep 2026, 00:05', fuelDropPct: 34, fuelDropLiters: 142, ignitionStatus: 'Off', gpsStatus: 'Stationary', status: 'Suspected' },
  { id: 'FT-002', machineId: 'EXC-101', machineName: 'Volvo EC210 Crawler Excavator', site: 'Lucknow Infrastructure Plant', windowStart: '09 Sep 2026, 02:10', windowEnd: '09 Sep 2026, 02:35', fuelDropPct: 28, fuelDropLiters: 87, ignitionStatus: 'Off', gpsStatus: 'Stationary', status: 'Confirmed' },
  { id: 'FT-003', machineId: 'DZR-601', machineName: 'Komatsu D65 Bulldozer', site: 'Lucknow Infrastructure Plant', windowStart: '06 Sep 2026, 21:55', windowEnd: '06 Sep 2026, 22:20', fuelDropPct: 19, fuelDropLiters: 54, ignitionStatus: 'Off', gpsStatus: 'Stationary', status: 'Suspected' },
  { id: 'FT-004', machineId: 'GEN-405', machineName: 'Caterpillar C9 Genset', site: 'CBM Central Works', windowStart: '04 Sep 2026, 03:15', windowEnd: '04 Sep 2026, 03:50', fuelDropPct: 41, fuelDropLiters: 168, ignitionStatus: 'Off', gpsStatus: 'Stationary', status: 'Confirmed' },
  { id: 'FT-005', machineId: 'CRN-301', machineName: 'Liebherr LTM 1090-4.2 Crane', site: 'Lucknow Infrastructure Plant', windowStart: '02 Sep 2026, 01:05', windowEnd: '02 Sep 2026, 01:22', fuelDropPct: 15, fuelDropLiters: 61, ignitionStatus: 'Off', gpsStatus: 'Stationary', status: 'Dismissed' },
  { id: 'FT-006', machineId: 'LDR-204', machineName: 'Volvo L120 Wheel Loader', site: 'Chennai Port Works', windowStart: '31 Aug 2026, 22:40', windowEnd: '31 Aug 2026, 23:10', fuelDropPct: 22, fuelDropLiters: 73, ignitionStatus: 'Off', gpsStatus: 'Stationary', status: 'Suspected' },
  { id: 'FT-007', machineId: 'GEN-403', machineName: 'Kirloskar Green 500kVA Genset', site: 'Pune Automotive Plant', windowStart: '29 Aug 2026, 00:30', windowEnd: '29 Aug 2026, 01:00', fuelDropPct: 26, fuelDropLiters: 96, ignitionStatus: 'Off', gpsStatus: 'Stationary', status: 'Suspected' },
];

// ---------------------------------------------------------------------------
// Utilization reporting
// ---------------------------------------------------------------------------

export const UTILIZATION_ROWS: UtilizationRow[] = MACHINES.map((m, i) => {
  const rng = mulberry32(hashString(`util-${m.id}`));
  const productiveHrs = Math.round((10 + rng() * 8) * 10) / 10;
  const idleHrs = Math.round((1.5 + rng() * 3.5) * 10) / 10;
  const offHrs = Math.round((24 - productiveHrs - idleHrs) * 10) / 10;
  const utilizationPct = Math.round((productiveHrs / 24) * 1000) / 10;
  return { machineId: m.id, machineName: m.name, site: m.site, productiveHrs, idleHrs, offHrs: Math.max(0, offHrs), utilizationPct };
});

// ---------------------------------------------------------------------------
// Geofencing
// ---------------------------------------------------------------------------

export const GEOFENCE_EVENTS: GeofenceEvent[] = [
  { id: 'GF-001', machineId: 'EXC-101', machineName: 'Volvo EC210 Crawler Excavator', site: 'Lucknow Infrastructure Plant', type: 'Boundary Exit', timestamp: '10 Sep 2026, 19:22', location: '2.4 km outside geofence', status: 'Open' },
  { id: 'GF-002', machineId: 'GEN-401', machineName: 'Cummins PowerCommand C500 Genset', site: 'CBM Central Works', type: 'After-Hours Movement', timestamp: '10 Sep 2026, 23:41', location: 'Site yard — off-shift', status: 'Open' },
  { id: 'GF-003', machineId: 'DZR-602', machineName: 'BEML BD80 Bulldozer', site: 'Ahmedabad Logistics Yard', type: 'Unauthorized Relocation', timestamp: '08 Sep 2026, 05:12', location: 'Moved 14 km overnight', status: 'Acknowledged' },
  { id: 'GF-004', machineId: 'CRN-303', machineName: 'Sany STC250 Mobile Crane', site: 'Lucknow Infrastructure Plant', type: 'Boundary Exit', timestamp: '05 Sep 2026, 14:03', location: '0.8 km outside geofence', status: 'Resolved' },
  { id: 'GF-005', machineId: 'LDR-202', machineName: 'Komatsu WA380 Wheel Loader', site: 'Chennai Port Works', type: 'After-Hours Movement', timestamp: '03 Sep 2026, 22:18', location: 'Yard — off-shift', status: 'Resolved' },
  { id: 'GF-006', machineId: 'GEN-403', machineName: 'Kirloskar Green 500kVA Genset', site: 'Pune Automotive Plant', type: 'Unauthorized Relocation', timestamp: '01 Sep 2026, 04:47', location: 'Moved 6 km overnight', status: 'Acknowledged' },
];

// ---------------------------------------------------------------------------
// Device health (fleet-of-devices — distinct from equipment PM)
// ---------------------------------------------------------------------------

export const DEVICE_HEALTH_ROWS: DeviceHealthRow[] = MACHINES.map((m, i) => {
  const rng = mulberry32(hashString(`dev-${m.id}`));
  const gsmSignalPct = Math.round(35 + rng() * 60);
  const packetDropPct = Math.round(rng() * (gsmSignalPct < 55 ? 18 : 5) * 10) / 10;
  const serialGapCount = rng() < 0.18 ? Math.ceil(rng() * 6) : 0;
  const lastSeenMins = Math.round(rng() * (gsmSignalPct < 40 ? 600 : 25));
  const lastSeen = lastSeenMins < 60 ? `${lastSeenMins || 1} min ago` : `${Math.round(lastSeenMins / 60)} hr ago`;
  const status: DeviceHealthRow['status'] = lastSeenMins > 180 ? 'Offline' : gsmSignalPct < 45 || packetDropPct > 8 || serialGapCount > 2 ? 'Degraded' : 'Healthy';
  return {
    deviceId: `DEV-${1000 + i}`,
    imei: `3567891${(45900731 + i * 137).toString().slice(0, 8)}`,
    machineName: m.name,
    site: m.site,
    gsmSignalPct,
    packetDropPct,
    lastSeen,
    serialGapCount,
    status,
  };
});

// ---------------------------------------------------------------------------
// Reports — Operator Scoring
// ---------------------------------------------------------------------------

const OPERATOR_NAMES = [
  'Rajesh Sharma', 'Priya Deshmukh', 'Kavita Mehta', 'Arun Kumar', 'Sunil Yadav',
  'Meena Iyer', 'Vikram Rathore', 'Deepak Nair', 'Anjali Verma', 'Suresh Pillai',
];

export const OPERATOR_SCORES: OperatorScore[] = MACHINES.slice(0, 10).map((m, i) => {
  const rng = mulberry32(hashString(`op-${m.id}`));
  const harshEvents = Math.round(rng() * 14);
  const idleRatioPct = Math.round(10 + rng() * 35);
  const throttleLoadRatio = Math.round((0.7 + rng() * 0.8) * 100) / 100;
  const score = Math.max(35, Math.round(100 - harshEvents * 2.4 - idleRatioPct * 0.6));
  return {
    operatorId: `OP-${200 + i}`,
    operatorName: OPERATOR_NAMES[i],
    site: m.site,
    machineName: m.name,
    harshEvents,
    idleRatioPct,
    throttleLoadRatio,
    score,
  };
}).sort((a, b) => b.score - a.score);

// ---------------------------------------------------------------------------
// Reports — Fleet Benchmarking (procurement view: fuel/hour by model)
// ---------------------------------------------------------------------------

export const BENCHMARK_ROWS: BenchmarkRow[] = (() => {
  const byModel = new Map<string, Machine[]>();
  MACHINES.forEach((m) => {
    const list = byModel.get(m.model) ?? [];
    list.push(m);
    byModel.set(m.model, list);
  });
  const rows: BenchmarkRow[] = [];
  byModel.forEach((list, model) => {
    const rng = mulberry32(hashString(`bench-${model}`));
    const fuelPerHour = Math.round((7 + rng() * 9) * 10) / 10;
    rows.push({ model, unitsCount: list.length, fuelPerHour, fleetAvgFuelPerHour: 0, deltaPct: 0 });
  });
  const fleetAvg = Math.round((rows.reduce((s, r) => s + r.fuelPerHour, 0) / rows.length) * 10) / 10;
  return rows
    .map((r) => ({ ...r, fleetAvgFuelPerHour: fleetAvg, deltaPct: Math.round(((r.fuelPerHour - fleetAvg) / fleetAvg) * 1000) / 10 }))
    .sort((a, b) => b.fuelPerHour - a.fuelPerHour);
})();

// ---------------------------------------------------------------------------
// Reports — Emissions (fuel -> estimated CO2 by site)
// ---------------------------------------------------------------------------

const CO2_KG_PER_LITER_DIESEL = 2.68;

export const EMISSIONS_ROWS: EmissionsRow[] = SITES.map(({ site }) => {
  const machinesAtSite = MACHINES.filter((m) => m.site === site);
  const rng = mulberry32(hashString(`emissions-${site}`));
  const fuelConsumedLiters = Math.round(machinesAtSite.length * (900 + rng() * 500));
  const estimatedCO2Tons = Math.round((fuelConsumedLiters * CO2_KG_PER_LITER_DIESEL) / 1000 * 10) / 10;
  return { site, machinesCount: machinesAtSite.length, fuelConsumedLiters, estimatedCO2Tons };
});

// ---------------------------------------------------------------------------
// Reports — Warranty Audit Trail
// ---------------------------------------------------------------------------

export const WARRANTY_RECORDS: WarrantyRecord[] = [
  { id: 'WR-001', machineId: 'EXC-101', machineName: 'Volvo EC210 Crawler Excavator', incidentDate: '18 Aug 2026', description: 'Hydraulic pump seal failure reported by site technician.', loadAtIncidentPct: 92, tempAtIncidentC: 74, withinNormalBounds: false, verdict: 'Genuine Defect' },
  { id: 'WR-002', machineId: 'GEN-401', machineName: 'Cummins PowerCommand C500 Genset', incidentDate: '22 Aug 2026', description: 'Engine shutdown on overload alarm.', loadAtIncidentPct: 104, tempAtIncidentC: 91, withinNormalBounds: false, verdict: 'Under Investigation' },
  { id: 'WR-003', machineId: 'DZR-601', machineName: 'Komatsu D65 Bulldozer', incidentDate: '29 Aug 2026', description: 'Track drive motor replaced under claim.', loadAtIncidentPct: 61, tempAtIncidentC: 68, withinNormalBounds: true, verdict: 'Normal Operation' },
  { id: 'WR-004', machineId: 'CRN-301', machineName: 'Liebherr LTM 1090-4.2 Crane', incidentDate: '02 Sep 2026', description: 'Slew bearing noise complaint.', loadAtIncidentPct: 88, tempAtIncidentC: 71, withinNormalBounds: true, verdict: 'Normal Operation' },
  { id: 'WR-005', machineId: 'EXC-102', machineName: 'CAT 320D Excavator', incidentDate: '05 Sep 2026', description: 'Turbocharger failure claim.', loadAtIncidentPct: 97, tempAtIncidentC: 96, withinNormalBounds: false, verdict: 'Genuine Defect' },
  { id: 'WR-006', machineId: 'GEN-405', machineName: 'Caterpillar C9 Genset', incidentDate: '08 Sep 2026', description: 'Alternator winding fault.', loadAtIncidentPct: 66, tempAtIncidentC: 79, withinNormalBounds: true, verdict: 'Under Investigation' },
];
