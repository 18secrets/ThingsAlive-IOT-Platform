const { Client } = require('pg');

const DATABASE_URL = 'postgresql://postgres:CdhlqhgUKSBzboKMRAItBDaYHJiMgYsI@crossover.proxy.rlwy.net:47609/railway';
const TENANT_ID = 'demo-construction';
const IMEI = '358000000000500';

function local(t) {
  const d = new Date(t);
  const utc = d.getTime() + d.getTimezoneOffset() * 60000;
  const ist = new Date(utc + 3600000 * 5.5);
  return { hour: ist.getHours(), dow: ist.getDay() };
}

function running(t) {
  return true; // 24/7 continuous operation
}

function prng(seed) {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

function demoValue(signal, t, now, noise) {
  const on = running(t);
  const { hour } = local(t);
  const n = (scale) => (noise() - 0.5) * 2 * scale;
  const cycle = Math.sin((2 * Math.PI * (hour - 8)) / 10);
  switch (signal) {
    case 'engine_running_status': return 1;
    case 'engine_load': return Math.min(100, Math.max(5, 58 + 12 * cycle + n(4)));
    case 'engine_oil_pressure': return 390 + 15 * cycle + n(6);
    case 'hydraulic_oil_temperature': return 62 + 5 * cycle + n(1.5);
    case 'fuel_level': return Math.min(98, Math.max(5, 55 + 30 * Math.sin((2 * Math.PI * t) / (3.2 * 86400000)) + n(0.8)));
    case 'engine_coolant_temperature': return 84 + 3 * cycle + n(1.2);
    case 'fuel_consumption': return 12.4 + n(1.5);
    default: return 50;
  }
}

const SIGNALS = [
  { signal: 'engine_running_status', unit: 'state' },
  { signal: 'engine_coolant_temperature', unit: 'degC' },
  { signal: 'engine_oil_pressure', unit: 'kPa' },
  { signal: 'hydraulic_oil_temperature', unit: 'degC' },
  { signal: 'fuel_level', unit: '%' },
  { signal: 'engine_load', unit: '%' },
  { signal: 'fuel_consumption', unit: 'L/h' },
];

async function run() {
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  console.log('Connected to DB as superuser.');

  // Partitions
  await client.query(`SELECT ensure_telemetry_partition('2026-09-01'::date)`);
  await client.query(`SELECT ensure_telemetry_partition('2026-10-01'::date)`);

  const now = Date.now();
  const DAY_MS = 86_400_000;
  const STEP_MS = 600_000; // 10 minutes
  const start = now - 40 * DAY_MS;
  const end = now - 1800_000;

  const times = [];
  for (let t = start; t <= end; t += STEP_MS) times.push(t);
  const dates = times.map((t) => new Date(t));
  console.log(`Generating ${times.length} ticks across 40 days for EX-05...`);

  for (const [index, s] of SIGNALS.entries()) {
    const noise = prng(505 + index * 17);
    const values = times.map((t) => demoValue(s.signal, t, now, noise));

    for (let i = 0; i < times.length; i += 1500) {
      const sliceDates = dates.slice(i, i + 1500);
      const sliceValues = values.slice(i, i + 1500);
      await client.query(`
        INSERT INTO telemetry_reading (tenant_id, imei, signal, value, unit, source_timestamp, received_at, source)
        SELECT $1, $2, $3, v, $4, ts, ts, 'simulated'
          FROM unnest($5::timestamptz[], $6::double precision[]) AS r(ts, v)
        ON CONFLICT DO NOTHING
      `, [TENANT_ID, IMEI, s.signal, s.unit, sliceDates, sliceValues]);
    }
    console.log(`Seeded signal: ${s.signal}`);
  }

  // Ensure binding valid_from is 2026-01-01
  await client.query(`
    UPDATE signal_binding_version
       SET valid_from = '2026-01-01 00:00:00+00', expected_period_seconds = 600
     WHERE tenant_id = $1 AND external_id = 'EX-05' AND status = 'active'
  `, [TENANT_ID]);

  // Ensure shift is 24/7
  await client.query(`
    UPDATE equipment_shift
       SET start_minute = 0, end_minute = 1440, days = ARRAY[0,1,2,3,4,5,6], scored_through = NOW(), arrivals_through = NOW()
     WHERE tenant_id = $1 AND external_id = 'EX-05'
  `, [TENANT_ID]);

  console.log('EX-05 40-day telemetry seeded successfully.');
  await client.end();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
