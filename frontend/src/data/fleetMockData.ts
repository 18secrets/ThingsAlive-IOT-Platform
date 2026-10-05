// UI-only mock fleet, ported from the client-ui-new demo's actual sample
// equipment list (things-alive-iot-platform-client-ui-new/lib/equipment-week.json)
// so the Alerts/Scenarios/Work Orders pages show the same real machine names,
// categories and sites as that demo instead of invented placeholder codes.
//
// `coolantLimitC` mirrors that demo's `scenario(id).limit` — a per-machine
// demonstration ceiling derived from its sample coolant-temperature history,
// never an OEM limit or measured production value (see that repo's
// lib/equipment-scenarios.ts). `coolantNowC` is a static snapshot, not a live
// reading — there's no telemetry simulation in this app.

export interface FleetThing {
  id: string;
  name: string;
  category: string;
  location: string;
  coolantLimitC: number;
  offline: boolean;
  coolantNowC: number;
}

export const FLEET: FleetThing[] = [
  { id: '4100460', name: 'Diesel Generator Set 320 kVA', category: 'Diesel Generator Set', location: '483 - Bengaluru', coolantLimitC: 72, offline: true, coolantNowC: 67.67 },
  { id: '4600055', name: 'Pick & Carry Crane PIXEF 215', category: 'Pick & Carry Crane', location: '483 - Bengaluru', coolantLimitC: 74, offline: false, coolantNowC: 68.67 },
  { id: '3100357', name: 'CONCRETE PUMP BSA 2110HPD', category: 'Concrete Pump Stationary', location: '556 - Vizag', coolantLimitC: 84, offline: true, coolantNowC: 79.33 },
  { id: '3100374', name: 'Concrete Placer Boom w Chassis (4400084)', category: 'Concrete Placer Boom', location: '556 - Vizag', coolantLimitC: 72, offline: false, coolantNowC: 74.8 },
  { id: '3100458', name: 'Concrete Placer Boom w Chassis (4400123)', category: 'Concrete Placer Boom', location: '556 - Vizag', coolantLimitC: 62, offline: false, coolantNowC: 65.6 },
  { id: '3100491', name: 'Concrete Pump - Putzmiester BSA 2109D', category: 'Concrete Pump Stationary', location: '556 - Vizag', coolantLimitC: 72, offline: false, coolantNowC: 74.2 },
  { id: '3100733', name: 'CONCRETE PUMP PUTZMEISTER - BSA 2109 HD', category: 'Concrete Pump Stationary', location: '556 - Vizag', coolantLimitC: 84, offline: false, coolantNowC: 79.33 },
  { id: '3100751', name: 'Concrete Pump - BSA 2109 HD', category: 'Concrete Pump Stationary', location: '556 - Vizag', coolantLimitC: 74, offline: false, coolantNowC: 68.67 },
  { id: '3100940', name: 'Concrete Placer Boom w Chassis CAP 73 M3', category: 'Concrete Placer Boom', location: '556 - Vizag', coolantLimitC: 84, offline: false, coolantNowC: 79.67 },
  { id: '3300189', name: 'PTC VIBRO HAMMER /WITH POWER PACK', category: 'Pilling Hammer - Hyd', location: '556 - Vizag', coolantLimitC: 72, offline: false, coolantNowC: 75.8 },
  { id: '3300249', name: 'Hydraulic Piling Rig Bauer BG 26 264 KNM', category: 'Hydraul Pilling Rig', location: '556 - Vizag', coolantLimitC: 62, offline: false, coolantNowC: 65.8 },
  { id: '3300323', name: 'Hydraulic Piling Rig Bauer BG 26V', category: 'Hydraul Pilling Rig', location: '616 - Gujarat', coolantLimitC: 84, offline: true, coolantNowC: 80.0 },
  { id: '3300415', name: 'Hydraulic Piling Rig MAIT HR260 260 KNM', category: 'Hydraul Pilling Rig', location: '616 - Gujarat', coolantLimitC: 74, offline: false, coolantNowC: 68.67 },
  { id: '3300424', name: 'Hydraulic Piling Rig Bauer BG 28VL', category: 'Hydraul Pilling Rig', location: '556 - Vizag', coolantLimitC: 84, offline: false, coolantNowC: 81.0 },
  { id: '3702054', name: 'Air Compressor 500 CFM', category: 'Air Compressor', location: '556 - Vizag', coolantLimitC: 72, offline: false, coolantNowC: 74.8 },
  { id: '3705955', name: 'AIR COMPRESSOR - 410 CFM', category: 'Air Compressor', location: '556 - Vizag', coolantLimitC: 84, offline: false, coolantNowC: 80.0 },
  { id: '3705956', name: 'AIR COMPRESSOR - 410 CFM', category: 'Air Compressor', location: '556 - Vizag', coolantLimitC: 74, offline: false, coolantNowC: 69.67 },
  { id: '3706000', name: 'AIR COMPRESSOR - 410 CFM', category: 'Air Compressor', location: '556 - Vizag', coolantLimitC: 74, offline: false, coolantNowC: 71.0 },
  { id: '3800060', name: 'ROCK BODY TIPPER - 35 MT', category: 'Tipper/Dumper', location: '556 - Vizag', coolantLimitC: 84, offline: false, coolantNowC: 79.67 },
  { id: '3800061', name: 'ROCK BODY TIPPER - 35 MT', category: 'Tipper/Dumper', location: '556 - Vizag', coolantLimitC: 72, offline: false, coolantNowC: 74.2 },
  { id: '3800062', name: 'ROCK BODY TIPPER - 35 MT', category: 'Tipper/Dumper', location: '556 - Vizag', coolantLimitC: 74, offline: false, coolantNowC: 69.0 },
  { id: '3800063', name: 'ROCK BODY TIPPER - 35 MT', category: 'Tipper/Dumper', location: '556 - Vizag', coolantLimitC: 84, offline: false, coolantNowC: 78.67 },
  { id: '3800064', name: 'ROCK BODY TIPPER - 35 MT', category: 'Tipper/Dumper', location: '556 - Vizag', coolantLimitC: 72, offline: false, coolantNowC: 74.8 },
  { id: '3800065', name: 'ROCK BODY TIPPER - 35 MT', category: 'Tipper/Dumper', location: '556 - Vizag', coolantLimitC: 74, offline: false, coolantNowC: 70.67 },
  { id: '3800066', name: 'ROCK BODY TIPPER - 35 MT', category: 'Tipper/Dumper', location: '556 - Vizag', coolantLimitC: 84, offline: false, coolantNowC: 80.33 },
  { id: '3800067', name: 'ROCK BODY TIPPER - 35 MT', category: 'Tipper/Dumper', location: '556 - Vizag', coolantLimitC: 72, offline: false, coolantNowC: 75.4 },
  { id: '3800068', name: 'ROCK BODY TIPPER - 35 MT', category: 'Tipper/Dumper', location: '556 - Vizag', coolantLimitC: 74, offline: false, coolantNowC: 69.67 },
  { id: '3800069', name: 'ROCK BODY TIPPER - 35 MT', category: 'Tipper/Dumper', location: '556 - Vizag', coolantLimitC: 84, offline: true, coolantNowC: 79.33 },
  { id: '4100040', name: 'Diesel Generator Set 180 kVA', category: 'Diesel Generator Set', location: '556 - Vizag', coolantLimitC: 72, offline: false, coolantNowC: 74.0 },
  { id: '4100154', name: 'Diesel Generator Set 320 kVA', category: 'Diesel Generator Set', location: '556 - Vizag', coolantLimitC: 72, offline: false, coolantNowC: 74.8 },
  { id: '4100200', name: 'Diesel Generator Set 320 kVA', category: 'Diesel Generator Set', location: '556 - Vizag', coolantLimitC: 84, offline: true, coolantNowC: 81.0 },
  { id: '4100201', name: 'Diesel Generator Set 320 KVA', category: 'Diesel Generator Set', location: '556 - Vizag', coolantLimitC: 84, offline: false, coolantNowC: 80.67 },
  { id: '4100224', name: 'Diesel Generator Set 250 kVA', category: 'Diesel Generator Set', location: '556 - Vizag', coolantLimitC: 74, offline: false, coolantNowC: 71.0 },
  { id: '4100318', name: 'Diesel Generator Set 320 KVA', category: 'Diesel Generator Set', location: '556 - Vizag', coolantLimitC: 84, offline: false, coolantNowC: 79.0 },
  { id: '4100620', name: 'DIESEL GENERATOR SET -  250 KVA', category: 'Diesel Generator Set', location: '556 - Vizag', coolantLimitC: 84, offline: false, coolantNowC: 79.67 },
  { id: '4600036', name: 'Hydraulic Tyre Mounted  Crane 40 MT', category: 'Crane Tyr Mntd - Hyd', location: '556 - Vizag', coolantLimitC: 84, offline: false, coolantNowC: 79.67 },
  { id: '4600068', name: 'Crawler Crane - Hydraulic TUSKER 160 MT', category: 'Crawler Crane - Hyd', location: '556 - Vizag', coolantLimitC: 62, offline: false, coolantNowC: 65.6 },
  { id: '4600143', name: 'Duty Cycle Craw Crane - Hyd Liebherr 70T', category: 'Crawler Crane - Hyd', location: '556 - Vizag', coolantLimitC: 72, offline: false, coolantNowC: 74.6 },
  { id: '4600246', name: 'HYDRAULIC CRAWLER CRANE KOBELCO - 100 MT', category: 'Crawler Crane - Hyd', location: '556 - Vizag', coolantLimitC: 84, offline: false, coolantNowC: 79.0 },
  { id: '4600292', name: 'HYDRAULIC TYRE MOUNTED CRANE-40 TON', category: 'Crane Tyr Mntd - Hyd', location: '556 - Vizag', coolantLimitC: 74, offline: false, coolantNowC: 69.67 },
  { id: '4600318', name: 'DUTY CYCLE HYD CRAWLER CRANE - 200 TON', category: 'Crawler Crane - Hyd', location: '556 - Vizag', coolantLimitC: 84, offline: false, coolantNowC: 79.0 },
  { id: '4700122', name: 'EXCAVATOR EX1200 W LONG BOOM REACH KIT', category: 'Excavator', location: '556 - Vizag', coolantLimitC: 84, offline: false, coolantNowC: 80.33 },
  { id: '4700136', name: 'EXCAVATOR EX1200 W LONG BOOM REACH KIT', category: 'Excavator', location: '556 - Vizag', coolantLimitC: 62, offline: false, coolantNowC: 65.2 },
  { id: '4700137', name: 'EXCAVATOR EX1200 W LONG BOOM REACH KIT', category: 'Excavator', location: '556 - Vizag', coolantLimitC: 84, offline: true, coolantNowC: 80.67 },
  { id: '4700142', name: 'EXCAVATOR - EX 1200V - 120 TON', category: 'Excavator', location: '556 - Vizag', coolantLimitC: 72, offline: false, coolantNowC: 74.4 },
  { id: '4700143', name: 'EXCAVATOR - EX 1200V - 120 TON', category: 'Excavator', location: '556 - Vizag', coolantLimitC: 84, offline: false, coolantNowC: 78.67 },
  { id: '4700064', name: 'CAT Motor Grader 120H', category: 'Motor grader', location: '556 - Vizag', coolantLimitC: 72, offline: false, coolantNowC: 74.8 },
  { id: '4600293', name: 'PICK AND CARRY CRANE PIXEF 215 15 TON', category: 'Pick & Carry Crane', location: '556 - Vizag', coolantLimitC: 62, offline: false, coolantNowC: 64.6 },
  { id: '4700044', name: 'Backhoe Loader Case 851 EX', category: 'Backhoe Loader/Loadr', location: '556 - Vizag', coolantLimitC: 84, offline: false, coolantNowC: 79.67 },
  { id: '4100389', name: 'Diesel Generator Set 500 KVA', category: 'Diesel Generator Set', location: '556 - Vizag', coolantLimitC: 84, offline: false, coolantNowC: 79.33 },
  { id: '4100388', name: 'Diesel Generator Set 500 KVA', category: 'Diesel Generator Set', location: '556 - Vizag', coolantLimitC: 62, offline: false, coolantNowC: 65.6 },
  { id: '4600094', name: 'Pick & Carry Crane PIXEF 215', category: 'Pick & Carry Crane', location: '556 - Vizag', coolantLimitC: 84, offline: false, coolantNowC: 79.0 },
  { id: '4600306', name: 'Truck Mounted Crane w Chasis 32T 4400450', category: 'Truck Loader Crane', location: '556 - Vizag', coolantLimitC: 74, offline: false, coolantNowC: 70.33 },
];

export function isBreaching(t: FleetThing): boolean {
  return !t.offline && t.coolantNowC > t.coolantLimitC;
}

export const FLEET_LOCATIONS = [...new Set(FLEET.map((t) => t.location))].sort();
export const FLEET_CATEGORIES = [...new Set(FLEET.map((t) => t.category))].sort();

export function findThing(id: string): FleetThing | undefined {
  return FLEET.find((t) => t.id === id);
}

export interface SensorSpec { key: string; label: string; unit: string; min: number; max: number }

export const SENSOR_SPECS: SensorSpec[] = [
  { key: 'fuel_level', label: 'Fuel level', unit: 'L', min: 20, max: 320 },
  { key: 'coolant_temperature', label: 'Coolant temperature', unit: '°C', min: 20, max: 90 },
  { key: 'oil_temperature', label: 'Oil temperature', unit: '°C', min: 20, max: 95 },
  { key: 'oil_pressure', label: 'Oil pressure', unit: 'kPa', min: 60, max: 180 },
  { key: 'throttle', label: 'Throttle', unit: '%', min: 0, max: 100 },
  { key: 'engine_load', label: 'Engine load', unit: '%', min: 0, max: 100 },
  { key: 'engine_runtime', label: 'Engine runtime', unit: 'h', min: 0, max: 400 },
];

export interface SensorSeries extends SensorSpec {
  history: number[];
  current: number;
}

function seededRandom(seed: number) {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

// Deterministic synthetic sensor history — there's no telemetry simulation in
// this app, so each machine gets a stable, seeded-random 24-point series
// instead of a live reading. coolant_temperature is pinned to the same
// coolantNowC/coolantLimitC values used on Alerts/Predictions so the three
// pages agree on whether this machine is currently breaching.
export function sensorsFor(t: FleetThing): SensorSeries[] {
  const seed = Number(t.id.replace(/\D/g, '')) || 1;
  const rand = seededRandom(seed);
  return SENSOR_SPECS.map((spec, i) => {
    const span = spec.max - spec.min;
    const mid = spec.min + span * (0.4 + (((seed + i * 7) % 30) / 100));
    const history = Array.from({ length: 24 }, () => Math.round((mid + (rand() - 0.5) * span * 0.2) * 100) / 100);
    if (spec.key === 'coolant_temperature') {
      history[history.length - 1] = t.coolantNowC;
      return { ...spec, min: 0, max: t.coolantLimitC, history, current: t.coolantNowC };
    }
    return { ...spec, history, current: history[history.length - 1] };
  });
}

export interface WeeklyPerformance {
  workingHours: number;
  availability: number;
  performance: number;
  quality: number;
  breakdownHours: number;
  scheduledHours: number;
  productiveHours: number;
  idleHours: number;
  fuelUsedL: number;
  fuelPerHour: number;
}

// Mirrors the shape of the demo's scenario() — deterministic per machine, not
// a real OEE calculation against live telemetry.
export function weeklyPerformanceFor(t: FleetThing): WeeklyPerformance {
  const seed = Number(t.id.replace(/\D/g, '')) || 1;
  const scheduledHours = 112;
  const workingHours = Math.round((scheduledHours * (0.55 + (seed % 30) / 100)) * 100) / 100;
  const availability = Math.round((workingHours / scheduledHours) * 10000) / 100;
  const performance = Math.round((78 + (seed % 15)) * 100) / 100;
  const quality = Math.round((95 + (seed % 5)) * 100) / 100;
  const idleHours = Math.round((workingHours * (0.1 + (seed % 20) / 100)) * 100) / 100;
  const productiveHours = Math.round((workingHours - idleHours) * 100) / 100;
  const fuelUsedL = Math.round((workingHours * (15 + (seed % 10))) * 100) / 100;
  return {
    workingHours, availability, performance, quality,
    breakdownHours: Math.round((scheduledHours - workingHours) * 100) / 100,
    scheduledHours, productiveHours, idleHours, fuelUsedL,
    fuelPerHour: workingHours ? Math.round((fuelUsedL / workingHours) * 100) / 100 : 0,
  };
}

export interface RuleEvaluation {
  value: number;
  unit: string;
  triggered: boolean;
  predicted: number;
}

// Mirrors the client-ui-new demo's evaluateRule() closely enough for a mock
// review step: reads the machine's current sensor value (or a preview
// override from the simulate form), checks it against the proposed
// condition, and projects a simple linear estimate over the horizon —
// same "not a validated failure prediction" caveat as Predictions.
export function evaluateRuleForThing(
  thing: FleetThing,
  def: { sensorKey: string; operator: '>' | '<'; threshold: number; horizonHours: number },
  overrideValue?: number,
): RuleEvaluation {
  const sensor = sensorsFor(thing).find((s) => s.key === def.sensorKey);
  const value = overrideValue ?? sensor?.current ?? NaN;
  const triggered = Number.isFinite(value) && (def.operator === '>' ? value > def.threshold : value < def.threshold);
  const predicted = Math.round(value * (1 + def.horizonHours / 100) * 10000) / 10000;
  return { value, unit: sensor?.unit ?? '', triggered, predicted };
}

// How many of the week's sample running-hour readings exceeded the
// demonstration coolant limit — same idea as the demo's scenario().excursions,
// used only to word the auto-generated "Inspect cooling system" work order.
export function excursionsFor(t: FleetThing): number {
  const seed = Number(t.id.replace(/\D/g, '')) || 1;
  return 90 + (seed % 11);
}

export type PredictionPriority = 'Routine' | 'Review' | 'Maintenance';

export interface FleetPrediction {
  fuelL: number;
  samples: number;
  idleShare: number;
  priority: PredictionPriority;
  action: string;
}

const ACTION_TEXT: Record<PredictionPriority, string> = {
  Maintenance: 'Inspect cooling system and coolant level before the next shift.',
  Review: 'Review dispatch and reduce unnecessary idling next shift.',
  Routine: 'Continue monitoring and complete the next scheduled inspection.',
};

// Deterministic placeholder forecast — same idea as the client-ui-new demo's
// forecast(): a linear planning estimate from recent running-hour samples,
// never a validated failure prediction. There's no telemetry simulation in
// this app, so values are derived once from each machine's id, not replayed.
export function predictionFor(t: FleetThing): FleetPrediction {
  const seed = Number(t.id.replace(/\D/g, '')) || 1;
  const idleShare = (seed % 30) / 100;
  const priority: PredictionPriority = isBreaching(t) ? 'Maintenance' : idleShare > 0.25 ? 'Review' : 'Routine';
  return {
    fuelL: Math.round((120 + (seed % 180)) * 10) / 10,
    samples: 6 + (seed % 3),
    idleShare,
    priority,
    action: ACTION_TEXT[priority],
  };
}
