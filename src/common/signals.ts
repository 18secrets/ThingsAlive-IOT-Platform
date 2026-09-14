/**
 * The signal vocabulary the existing fleet actually reports (task P4-03).
 *
 * Taken from Things Alive's use-case map rather than invented: these are the fields
 * already parsed and stored per device. Naming them once, here, is what keeps a
 * scenario, an alert rule and an influence model talking about the same thing — the
 * failure otherwise is a rule configured against `oil_temp` that silently never fires
 * because the fleet reports `engine_oil_temperature`.
 *
 * Not an enum in the database. A customer's fleet may report signals nobody here has
 * heard of, and a closed list would refuse them; this is the shared vocabulary for the
 * ones Things Alive ships scenarios for.
 */
export const SIGNALS = {
  latitude: 'latitude',
  longitude: 'longitude',
  gsmSignalStrength: 'gsm_signal_strength',
  fuelLevel: 'fuel_level',
  fuelConsumption: 'fuel_consumption',
  coolantTemperature: 'engine_coolant_temperature',
  oilPressure: 'engine_oil_pressure',
  oilTemperature: 'engine_oil_temperature',
  hydraulicOilTemperature: 'hydraulic_oil_temperature',
  torque: 'torque',
  throttlePosition: 'throttle_position',
  engineLoad: 'engine_load',
  ignitionStatus: 'ignition_status',
  engineRunningStatus: 'engine_running_status',
  utilizationStatus: 'utilization_status',
  engineRuntime: 'engine_runtime',
  serialNumber: 'serial_number',
} as const;

export type KnownSignal = (typeof SIGNALS)[keyof typeof SIGNALS];

export const ALL_KNOWN_SIGNALS: readonly string[] = Object.values(SIGNALS);
