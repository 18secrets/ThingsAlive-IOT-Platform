import { Client } from 'pg';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://postgres:CdhlqhgUKSBzboKMRAItBDaYHJiMgYsI@crossover.proxy.rlwy.net:47609/railway';
const TENANT_ID = 'demo-construction';
const USER_ID = '5cf45f74-f668-40d8-b064-83fad9862db5'; // tapas.m@thingsalive.io

const FLEET_DEFINITIONS = [
  { id: 'EX-01', source: 'seed-demo', name: 'CAT 320D3 Heavy Hydraulic Excavator (Unit 01)', classSlug: 'hydraulic-excavator', imei: '358000000000100', model: 'TA-OBD-CAN', plantCode: 'PUNE-01' },
  { id: 'EX-02', source: 'seed-demo', name: 'Komatsu PC210-10M0 Excavator (Unit 02)', classSlug: 'hydraulic-excavator', imei: '358000000000200', model: 'TA-OBD-CAN', plantCode: 'PUNE-01' },
  { id: 'EX-03', source: 'seed-demo', name: 'Hitachi ZX200-5G Heavy Excavator (Unit 03)', classSlug: 'hydraulic-excavator', imei: '358000000000300', model: 'TA-OBD-CAN', plantCode: 'PUNE-01' },
  { id: 'EX-04', source: 'seed-demo', name: 'Kobelco CKL-1000i Heavy Crawler Crane (Unit 04)', classSlug: 'heavy-crawler-crane', imei: '358000000000400', model: 'TA-OBD-CAN', plantCode: 'PUNE-02' },
  { id: 'EX-05', source: 'seed-demo', name: 'Cummins C320D5P Diesel Generator (Unit 05)', classSlug: 'prime-diesel-generator', imei: '358000000000500', model: 'TA-OBD-CAN', plantCode: 'PUNE-01' },
  { id: 'EX-06', source: 'seed-demo', name: 'Kaeser CSDX 162 Screw Compressor (Unit 06)', classSlug: 'screw-air-compressor', imei: '358000000000600', model: 'TA-OBD-CAN', plantCode: 'PUNE-01' },
  { id: 'EX-08', source: 'ta-2.0', name: 'Volvo EC210D Heavy Hydraulic Excavator (Unit 08)', classSlug: 'hydraulic-excavator', imei: '356938035643825', model: 'Volvo EC210D', plantCode: 'PUNE-01' },
  { id: 'EX-09', source: 'ta-2.0', name: 'JCB JS205 Heavy Hydraulic Excavator (Unit 09)', classSlug: 'hydraulic-excavator', imei: '356938035643833', model: 'JCB JS205', plantCode: 'PUNE-01' },
  { id: 'EX-10', source: 'ta-2.0', name: 'Tata Hitachi EX210LC Excavator (Unit 10)', classSlug: 'hydraulic-excavator', imei: '356938035643841', model: 'Tata Hitachi EX210LC', plantCode: 'PUNE-01' },
  { id: 'EX-11', source: 'ta-2.0', name: 'Komatsu PC210LC-10MO Excavator (Unit 11)', classSlug: 'hydraulic-excavator', imei: '356938035643858', model: 'Komatsu PC210LC-10MO', plantCode: 'PUNE-01' },
  { id: 'EX-12', source: 'ta-2.0', name: 'SANY SY215C Hydraulic Excavator (Unit 12)', classSlug: 'hydraulic-excavator', imei: '356938035643866', model: 'SANY SY215C', plantCode: 'PUNE-01' },
  { id: 'EX-13', source: 'ta-2.0', name: 'CASE CX210C Excavator (Unit 13)', classSlug: 'hydraulic-excavator', imei: '356938035643874', model: 'CASE CX210C', plantCode: 'PUNE-02' },
  { id: 'EX-14', source: 'ta-2.0', name: 'Doosan DX225LC Excavator (Unit 14)', classSlug: 'hydraulic-excavator', imei: '356938035643882', model: 'Doosan DX225LC', plantCode: 'PUNE-02' },
  { id: 'EXC-001', source: 'ta-2.0', name: 'Hyundai R215L Smart Plus', classSlug: 'hydraulic-excavator', imei: '356938035643809', model: 'Hyundai R215L', plantCode: 'PUNE-01' },
];

const SIGNALS = [
  { key: 'engine_running_status', unit: 'state' },
  { key: 'engine_coolant_temperature', unit: 'degC' },
  { key: 'engine_oil_pressure', unit: 'kPa' },
  { key: 'hydraulic_oil_temperature', unit: 'degC' },
  { key: 'fuel_level', unit: '%' },
  { key: 'engine_load', unit: '%' },
  { key: 'fuel_consumption', unit: 'L/h' },
];

const SCENARIOS = ['fuel-burn', 'hydraulic-heat', 'coolant-drift', 'engine-stress', 'oil-pressure'];

async function run() {
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  console.log('Connected to database. Starting complete fleet onboarding...');

  // Get Plant IDs
  const plantRes = await client.query(`SELECT id, code FROM plant WHERE tenant_id = $1`, [TENANT_ID]);
  const plantMap = new Map<string, string>(plantRes.rows.map((r: { code: string; id: string }) => [r.code, r.id]));

  // 1. Grant user access to all plants (Step 7: Access)
  for (const plantId of plantMap.values()) {
    await client.query(`
      INSERT INTO user_plant_access (id, tenant_id, user_id, plant_id, granted_by, granted_at)
      VALUES (gen_random_uuid(), $1, $2, $3, 'system', NOW())
      ON CONFLICT (tenant_id, user_id, plant_id) DO NOTHING
    `, [TENANT_ID, USER_ID, plantId]);
  }
  console.log('✅ Step 7 (User Access): Granted site permissions to operator.');

  // 2. Loop through every machine
  for (const m of FLEET_DEFINITIONS) {
    const plantId = plantMap.get(m.plantCode);

    // Step 1: Equipment Class & Profile
    await client.query(`
      UPDATE equipment_profile
      SET equipment_class_slug = $1,
          class_version = 1,
          plant_id = $2,
          readiness = '{}'
      WHERE tenant_id = $3 AND external_id = $4
    `, [m.classSlug, plantId, TENANT_ID, m.id]);

    // Step 2: Device inventory & projection
    await client.query(`
      INSERT INTO device_inventory (
        id, tenant_id, imei, model, state, equipment_external_id, claimed_at, created_at, updated_at
      ) VALUES (
        gen_random_uuid(), $1, $2, $3, 'assigned', $4, NOW(), NOW(), NOW()
      )
      ON CONFLICT (imei) DO UPDATE
        SET state = 'assigned', equipment_external_id = EXCLUDED.equipment_external_id, claimed_at = NOW()
    `, [TENANT_ID, m.imei, m.model, m.id]);

    await client.query(`
      INSERT INTO device_projection (
        id, source_system, external_id, tenant_id, imei, equipment_external_id, status, synced_at, checksum
      ) VALUES (
        gen_random_uuid(), $1, $2, $3, $4, $5, 'live', NOW(), 'manual-onboard'
      )
      ON CONFLICT (source_system, external_id) DO UPDATE
        SET imei = EXCLUDED.imei, equipment_external_id = EXCLUDED.equipment_external_id, status = 'live'
    `, [m.source, `dev-${m.imei}`, TENANT_ID, m.imei, m.id]);

    // Step 3: Signal Bindings
    for (const s of SIGNALS) {
      const existing = await client.query(`
        SELECT id FROM signal_binding_version
        WHERE tenant_id = $1 AND source_system = $2 AND external_id = $3 AND signal_key = $4 AND status = 'active'
      `, [TENANT_ID, m.source, m.id, s.key]);

      if (existing.rowCount === 0) {
        await client.query(`
          INSERT INTO signal_binding_version (
            id, tenant_id, source_system, external_id, signal_key, measurement_role, component_id,
            origin, imei, channel, canonical_unit, valid_from, expected_period_seconds,
            freshness_policy, quality_policy, is_primary, status, discovered_by, approved_by, approved_at
          ) VALUES (
            gen_random_uuid(), $1, $2, $3, $4, $4, '',
            'physical', $5, $4, $6, '2026-01-01 00:00:00+00', 600,
            '{}', '{}', true, 'active', 'manual', 'seed-demo', NOW()
          )
        `, [TENANT_ID, m.source, m.id, s.key, m.imei, s.unit]);
      }
    }

    // Step 4: Shift Schedules (24/7 continuous operations for OEE, Availability & Baselines)
    await client.query(`
      INSERT INTO equipment_shift (
        id, tenant_id, source_system, external_id, name, start_minute, end_minute, days, time_zone, status, scored_through, arrivals_through, created_by, updated_by
      ) VALUES (
        gen_random_uuid(), $1, $2, $3, 'Day shift', 0, 1440, ARRAY[0,1,2,3,4,5,6], 'Asia/Kolkata', 'active', NOW(), NOW(), 'system', 'system'
      )
      ON CONFLICT (tenant_id, source_system, external_id, name) DO UPDATE
        SET start_minute = 0, end_minute = 1440, days = ARRAY[0,1,2,3,4,5,6], scored_through = NOW(), arrivals_through = NOW()
    `, [TENANT_ID, m.source, m.id]);

    // Step 5: Activate Scenarios
    for (const sc of SCENARIOS) {
      await client.query(`
        INSERT INTO equipment_scenario (
          id, tenant_id, source_system, external_id, client_scenario_slug, state,
          parameter_overrides, blockers_at_activation, activated_by, activated_at, created_at, updated_at
        ) VALUES (
          gen_random_uuid(), $1, $2, $3, $4, 'active',
          '{}', '[]', $5, NOW(), NOW(), NOW()
        )
        ON CONFLICT (tenant_id, source_system, external_id, client_scenario_slug) DO UPDATE
          SET state = 'active'
      `, [TENANT_ID, m.source, m.id, sc, USER_ID]);
    }

    // Step 6: Bulk telemetry readings over past 6 hours
    const now = Date.now();
    const batchImeis: string[] = [];
    const batchSignals: string[] = [];
    const batchValues: number[] = [];
    const batchUnits: string[] = [];
    const batchTimestamps: Date[] = [];

    const noiseBase = Number(m.id.replace(/[^0-9]/g, '')) || 8;
    for (let t = now - 6 * 3600 * 1000; t <= now; t += 300 * 1000) {
      const ts = new Date(t);
      const readings = [
        { signal: 'engine_running_status', val: 1, unit: 'state' },
        { signal: 'engine_coolant_temperature', val: 82.0 + (noiseBase % 7) * 0.8, unit: 'degC' },
        { signal: 'engine_oil_pressure', val: 340.0 + (noiseBase % 5) * 10.0, unit: 'kPa' },
        { signal: 'hydraulic_oil_temperature', val: 61.0 + (noiseBase % 6) * 1.2, unit: 'degC' },
        { signal: 'fuel_level', val: 72.0 - ((now - t) / (3600 * 1000)) * 1.5, unit: '%' },
        { signal: 'engine_load', val: 55.0 + (noiseBase % 4) * 3.0, unit: '%' },
        { signal: 'fuel_consumption', val: 12.5 + (noiseBase % 3) * 0.4, unit: 'L/h' },
      ];
      for (const r of readings) {
        batchImeis.push(m.imei);
        batchSignals.push(r.signal);
        batchValues.push(r.val);
        batchUnits.push(r.unit);
        batchTimestamps.push(ts);
      }
    }

    await client.query(`
      INSERT INTO telemetry_reading (tenant_id, imei, signal, value, unit, source_timestamp, received_at, source)
      SELECT $1, u.imei, u.signal, u.val, u.unit, u.ts, u.ts, 'simulated'
        FROM unnest($2::text[], $3::text[], $4::double precision[], $5::text[], $6::timestamptz[]) AS u(imei, signal, val, unit, ts)
      ON CONFLICT DO NOTHING
    `, [TENANT_ID, batchImeis, batchSignals, batchValues, batchUnits, batchTimestamps]);

    console.log(`✅ Onboarded machine: ${m.id} (${m.name}) with IMEI ${m.imei}`);
  }

  console.log('🎉 All 14 machines onboarded successfully across all 7 steps!');
  await client.end();
}

run().catch(console.error);
