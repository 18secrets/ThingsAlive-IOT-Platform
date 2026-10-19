import { DataSource } from 'typeorm';

/**
 * The 1.0 fleet as it stands: machines, loggers and which measurement each logger
 * channel carries (task QSYNC1).
 *
 * Every 1.0 table and column 2.0 depends on for this is named in this file and nowhere
 * else, read from IoT Platform 1.0's own entities (`iot_platform_backend`:
 * `equipment_master`, `devices`, `device_sensors`, `device_sensor_measurements`,
 * `sensors`, `sensor_measurements`). When 1.0 renames a column, this is the one file to
 * change, and the fixture in `test/legacy-fleet-sync.spec.ts` is built from the same
 * names so the two cannot quietly disagree.
 *
 * Plain SQL with explicit columns, not entities, for the reason `legacy-source.ts`
 * gives: 2.0 does not carry a copy of somebody else's model. `SELECT *` is avoided for
 * the same reason — a column 1.0 adds should not change what 2.0 mirrors, and a column
 * it drops should fail here, loudly, in the one query that names it.
 *
 * Values are passed through as 1.0 holds them. Turning 1.0's measurement names into
 * canonical signals is `signal_alias`'s job, downstream; doing it here as well would be
 * a second mapping that drifts from the first.
 */
export interface LegacyEquipmentRow {
  id: number;
  client_id: number | null;
  equipment: string | null;
  plant_id: number | null;
  equipment_category: string | null;
  equipment_category_txt: string | null;
  equipment_type_txt: string | null;
  manufacturer: string | null;
  model_number: string | null;
  manuf_serial_no: string | null;
  engine_type: string | null;
  ccl_number: string | null;
  description: string | null;
  license_plate: string | null;
  vin: string | null;
  updated_at: Date | null;
}

export interface LegacyDeviceRow {
  id: number;
  client_id: number | null;
  imei_number: string | null;
  tool_name: string | null;
  type: string | null;
  equipment_id: number | null;
  updated_at: Date | null;
}

export interface LegacySensorMapRow {
  /** `device_sensor_measurements.id` — the id 1.0's telemetry log rows carry. */
  id: number;
  client_id: number | null;
  imei_number: string | null;
  device_id: number;
  sensor_name: string | null;
  measurement_name: string | null;
  unit: string | null;
  is_kpi: boolean | null;
  calibration_offset: number | null;
  threshold_min: number | null;
  threshold_max: number | null;
  updated_at: Date | null;
}

export interface LegacyFleet {
  equipment: LegacyEquipmentRow[];
  devices: LegacyDeviceRow[];
  sensorMap: LegacySensorMapRow[];
}

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

export async function readLegacyFleet(legacy: DataSource, schema = 'public'): Promise<LegacyFleet> {
  // Interpolated, so held to a plain identifier. It comes from configuration, never a request.
  if (!IDENTIFIER.test(schema)) throw new Error(`LEGACY_DB_SCHEMA "${schema}" is not a plain identifier.`);
  const t = (table: string) => `"${schema}"."${table}"`;

  // One read-only transaction, so the three reads see one moment of 1.0: a logger
  // moved between the equipment read and the device read would otherwise point at a
  // machine the snapshot does not hold.
  return legacy.transaction('REPEATABLE READ', async (m) => {
    const equipment: LegacyEquipmentRow[] = await m.query(`
      SELECT id, client_id, equipment, plant_id, equipment_category, equipment_category_txt, equipment_type_txt,
             manufacturer, model_number, manuf_serial_no, engine_type, ccl_number, description, license_plate, vin,
             updated_at
        FROM ${t('equipment_master')}
       ORDER BY id`);
    const devices: LegacyDeviceRow[] = await m.query(`
      SELECT id, client_id, imei_number, tool_name, type, equipment_id, updated_at
        FROM ${t('devices')}
       ORDER BY id`);
    const sensorMap: LegacySensorMapRow[] = await m.query(`
      SELECT dsm.id, d.client_id, d.imei_number, d.id AS device_id, s.sensor_name, sm.name AS measurement_name, sm.unit,
             dsm.is_kpi, dsm.calibration_offset, dsm.threshold_min, dsm.threshold_max, dsm.updated_at
        FROM ${t('device_sensor_measurements')} dsm
        JOIN ${t('device_sensors')} ds ON ds.id = dsm.device_sensor_id
        JOIN ${t('devices')} d ON d.id = ds.device_id
        JOIN ${t('sensors')} s ON s.id = ds.sensor_id
        JOIN ${t('sensor_measurements')} sm ON sm.id = dsm.sensor_measurement_id
       ORDER BY dsm.id`);
    return { equipment, devices, sensorMap };
  });
}
