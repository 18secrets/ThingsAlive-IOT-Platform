/**
 * A motor logger, simulated: sends what a SIM800L motor logger sends, the way it sends
 * it, so the receiver, the one-minute KPIs and the alerts can be exercised end to end
 * before the real device is wired.
 *
 *   npx ts-node scripts/motor-logger-sim.ts --url https://<api-host> --device MOTOR_001 \
 *     --key <X-Device-Key> --scenario overload --backfill 30
 *
 *   --url        the receiver (motor_logger_http_server.py, default http://localhost:8080);
 *                the path is the firmware's own, /api/sensor-data/bulk
 *   --device     device_id (default MOTOR_001)
 *   --key        optional X-Device-Key header (or MOTOR_DEVICE_KEY); the receiver,
 *                motor_logger_http_server.py, does not check one yet
 *   --scenario   normal | overload | low-voltage | high-voltage | dry-run | cycling
 *   --backfill N generate the last N minutes and send them now (default 10)
 *   --end-ago M  end that history M minutes ago instead of now: to place a scenario inside
 *                a shift window that has already closed (the shift runner scores closed
 *                windows). device_now is still the clock at send time, so the readings land
 *                where they were taken, not shifted to now.
 *   --live       keep running: every --interval seconds (default 300, the device's own
 *                five minutes) send the readings taken since the last send
 *   --lost-total N  report this lost_total (records overwritten when flash was full), to
 *                exercise the logger-health signal and alert; default 0
 *   --print      print the first batch instead of sending anything
 *
 * The wire format is the logger contract's: ≤ 50 records a POST, one reading a second,
 * single-line JSON, plain decimals at the contract's precision, `device_now` (the clock at
 * send time) and the X-Device-Key header. On anything but a 200 it backs off 10 s, 20 s,
 * 40 s … as the firmware does; on 413 it halves the batch.
 *
 * The readings come from the Crompton workbook's own physics (sheet "Universal
 * Parameters & Formulas"), for the POC motor, a Crompton Mini 1 HP:
 *   F2  P = V × I × PF
 *   F3  λ = I / I_rated
 *   F4  N = N_sync × (1 − s_rated × λ), N_sync = 120 f / p
 *   F5  T → T_amb + ΔT_rated × λ², first order with time constant τ
 * Scenarios are the POC test plan's (T3 dry run, T6 voltage band, T7 overload, T8
 * cycling) with the RCA matrix's signatures.
 *
 * Simulated data, never a measurement: every number here is a model of a motor, and
 * the slip, power-factor curve and time constant below are illustrative, not datasheet
 * figures. Point it at a test account.
 */

export interface MotorModel {
  ratedVoltage: number;   // V
  ratedCurrent: number;   // A
  frequency: number;      // Hz
  poles: number;
  ratedSlip: number;      // fraction of synchronous speed
  ratedPf: number;        // power factor at rated load
  tempRise: number;       // degC above ambient at rated load
  ambient: number;        // degC
  timeConstant: number;   // s
}

/**
 * Crompton Mini 1 HP (0.75 kW, 220 V single-phase). Rated current from the workbook's
 * worked example (~5.5 A); 2-pole 50 Hz; ΔT 40 over 30 °C as in the firmware review
 * (V-04). Slip, PF and τ are assumptions for a small single-phase motor, not catalogue values.
 */
export const MINI_1HP: MotorModel = {
  ratedVoltage: 220, ratedCurrent: 5.5, frequency: 50, poles: 2, ratedSlip: 0.04,
  ratedPf: 0.85, tempRise: 40, ambient: 30, timeConstant: 900,
};

export const SCENARIOS = ['normal', 'overload', 'low-voltage', 'high-voltage', 'dry-run', 'cycling'] as const;
export type Scenario = (typeof SCENARIOS)[number];

export interface SimRecord {
  seq: number; timestamp: number; voltage: number; current: number; power_factor: number; temperature: number; rpm: number;
  /** The added sensors (firmware, 9 Nov), sent only when the run asks for them. */
  ambient_c?: number; vibration_mm_s?: number; load_pct?: number;
}

/** The receiver's request limit (MOTOR_MAX_BODY_BYTES, default 8192). */
export const MAX_BODY_BYTES = 8192;

/** Deterministic noise, so a run can be reproduced: the same second gives the same wobble. */
const noise = (seed: number, scale: number) => {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return (x - Math.floor(x) - 0.5) * 2 * scale;
};
const round = (v: number, dp: number) => Math.round(v * 10 ** dp) / 10 ** dp;

/**
 * What the motor is doing at fraction `p` (0 → 1) of the run: supply voltage and the
 * load ratio λ it would draw at rated voltage, plus whether it is switched on.
 */
interface OperatingPoint { v: number; lambda: number; on: boolean; pfFactor: number; constantPower?: boolean }

function operatingPoint(scenario: Scenario, p: number, secondOfRun: number): OperatingPoint {
  const nominalV = 230;
  switch (scenario) {
    case 'overload': // T7 / RCA 7: current climbing at the same duty, past 1.2 × rated
      return { v: nominalV, lambda: 0.85 + 0.5 * p, on: true, pfFactor: 1 };
    case 'low-voltage': // T6 / RCA 2: supply sags through the warning line into the fault band
      return { v: nominalV - 58 * p, lambda: 0.85, on: true, pfFactor: 1, constantPower: true };
    case 'high-voltage': // T6, upper side: above 250 (warning) towards 260 (fault)
      return { v: nominalV + 34 * p, lambda: 0.85, on: true, pfFactor: 1 };
    case 'dry-run': // T3 / RCA 1: after a third of the run, current drops ~30% and PF falls
      return p < 1 / 3
        ? { v: nominalV, lambda: 0.85, on: true, pfFactor: 1 }
        : { v: nominalV, lambda: 0.85 * 0.65, on: true, pfFactor: 0.65 };
    case 'cycling': // T8 / RCA 10: 90 s on, 30 s off — dozens of starts an hour
      return { v: nominalV, lambda: 0.85, on: secondOfRun % 120 < 90, pfFactor: 1 };
    default:
      return { v: nominalV, lambda: 0.85, on: true, pfFactor: 1 };
  }
}

/**
 * One reading a second for `seconds` seconds ending at `endUnix`. `seq` is the reading's
 * Unix second (unique per device, increasing across runs, inside the contract's uint32);
 * `timestamp` is seconds since the simulated boot, the device clock the contract describes.
 */
export function simulate(
  scenario: Scenario, seconds: number, endUnix: number, bootUnix: number, m: MotorModel = MINI_1HP, sensors = false,
): SimRecord[] {
  const nSync = (120 * m.frequency) / m.poles;
  let temperature = m.ambient;
  const out: SimRecord[] = [];
  for (let i = 0; i < seconds; i += 1) {
    const unix = endUnix - seconds + 1 + i;
    const p = seconds > 1 ? i / (seconds - 1) : 1;
    const op = operatingPoint(scenario, p, i);
    const voltage = op.v + noise(unix, 1.5);
    // At constant shaft load a sagging supply draws more current (P ≈ V·I·PF held).
    const lambda = !op.on ? 0 : (op.constantPower ? op.lambda * (230 / voltage) : op.lambda) * (1 + noise(unix + 7, 0.02));
    const current = lambda * m.ratedCurrent;
    // Power factor falls at light load; illustrative, clamped to the contract's 0-1.
    const pf = !op.on ? 0 : Math.min(1, Math.max(0, m.ratedPf * (0.6 + 0.4 * Math.min(lambda, 1.2)) * op.pfFactor + noise(unix + 3, 0.01)));
    // F5, first order: the winding heats towards T_amb + ΔT·λ² with time constant τ.
    const target = m.ambient + m.tempRise * lambda * lambda;
    temperature += (target - temperature) * (1 / m.timeConstant);
    // F4: slip grows with load; stopped is 0.
    const rpm = !op.on ? 0 : Math.min(nSync, nSync * (1 - m.ratedSlip * lambda));
    const record: SimRecord = {
      seq: unix, timestamp: unix - bootUnix,
      voltage: round(Math.max(0, voltage), 1), current: round(Math.max(0, current), 2),
      power_factor: round(pf, 2), temperature: round(temperature, 1), rpm: Math.round(rpm),
    };
    if (sensors) {
      // Ambient: a day's swing of ±3 °C about the model's ambient, warmest mid-afternoon IST.
      const hourIst = ((unix / 3600 + 5.5) % 24 + 24) % 24;
      record.ambient_c = round(m.ambient + 3 * Math.sin(((hourIst - 9) / 24) * 2 * Math.PI) + noise(unix + 11, 0.2), 1);
      // Vibration velocity, ISO 10816 class I terms: ~1.1 mm/s healthy (zone A/B); load
      // past rated shakes it towards 2.8; a dry-running pump rattles into zone C/D.
      const vib = !op.on ? 0.05
        : scenario === 'dry-run' && op.pfFactor < 1 ? 3.6
          : 1.1 + 2.5 * Math.max(0, lambda - 0.9);
      record.vibration_mm_s = round(Math.max(0, vib + noise(unix + 13, 0.08)), 2);
      record.load_pct = round(lambda * 100, 1);
    }
    out.push(record);
  }
  return out;
}

/**
 * Splits readings into the contract's batches: ≤ `size` records and ≤ 8 KiB, oldest
 * first. With the added sensors a record is ~190 bytes, so 50 no longer fit in 8 KiB;
 * the firmware has to size by bytes as well (or halve on 413, as it does).
 */
export function batches(deviceId: string, records: SimRecord[], deviceNow: number, size = 50, lostTotal = 0, boot = 1) {
  const out = [];
  for (let i = 0; i < records.length;) {
    let n = Math.min(size, records.length - i);
    const make = (k: number) => {
      const chunk = records.slice(i, i + k);
      return {
        device_id: deviceId,
        batch_id: `${deviceId}-${chunk[0].seq}-${chunk[chunk.length - 1].seq}`,
        first_seq: chunk[0].seq,
        last_seq: chunk[chunk.length - 1].seq,
        count: chunk.length,
        boot,
        lost_total: lostTotal,
        dropped_total: 0,
        device_now: deviceNow,
        records: chunk,
      };
    };
    let batch = make(n);
    while (n > 1 && JSON.stringify(batch).length > MAX_BODY_BYTES) batch = make(--n);
    out.push(batch);
    i += n;
  }
  return out;
}

// ------------------------------------------------------------------------------ CLI

function arg(name: string, argv: string[]): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : undefined;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One POST, retried the firmware's way. Returns when ACKed, or throws after `maxRetries`. */
async function send(url: string, key: string, batch: ReturnType<typeof batches>[number], maxRetries = 5): Promise<void> {
  let backoff = 10_000;
  for (let attempt = 0; ; attempt += 1) {
    const body = JSON.stringify(batch);
    const res = await fetch(`${url}/api/sensor-data/bulk`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': batch.batch_id, ...(key ? { 'X-Device-Key': key } : {}) },
      body,
      signal: AbortSignal.timeout(120_000),
    }).catch((e: Error) => ({ status: 0, text: async () => e.message }) as unknown as Response);
    const text = await res.text();
    if (res.status === 200) {
      const ack = JSON.parse(text) as { ack_seq: number };
      if (ack.ack_seq !== batch.last_seq) throw new Error(`Unexpected ACK ${text} for ${batch.batch_id}`);
      console.log(`ACK ${batch.batch_id} (${batch.count} records, ${body.length} bytes)`);
      return;
    }
    if (res.status === 413 && batch.records.length > 1) {
      // The firmware halves its chunk and retries in 2 s.
      const half = Math.ceil(batch.records.length / 2);
      console.warn(`413 for ${batch.batch_id}; halving to ${half}`);
      await sleep(2000);
      for (const part of batches(batch.device_id, batch.records, batch.device_now, half, batch.lost_total, batch.boot)) await send(url, key, part, maxRetries);
      return;
    }
    if (res.status === 401) throw new Error(`401: the receiver refused the device (${text})`);
    if (attempt >= maxRetries) throw new Error(`Gave up on ${batch.batch_id} after ${attempt + 1} tries: ${res.status} ${text}`);
    console.warn(`${res.status || 'no response'} for ${batch.batch_id}: ${text.slice(0, 200)}; retrying in ${backoff / 1000} s`);
    await sleep(backoff);
    backoff = Math.min(backoff * 2, 300_000);
  }
}

async function main(argv = process.argv.slice(2)): Promise<number> {
  const url = (arg('url', argv) ?? 'http://localhost:8080').replace(/\/+$/, '');
  const device = arg('device', argv) ?? 'MOTOR_001';
  const key = arg('key', argv) ?? process.env.MOTOR_DEVICE_KEY ?? '';
  const scenario = (arg('scenario', argv) ?? 'normal') as Scenario;
  const backfillMin = Number(arg('backfill', argv) ?? 10);
  const interval = Number(arg('interval', argv) ?? 300);
  const endAgo = Number(arg('end-ago', argv) ?? 0);
  const lostTotal = Number(arg('lost-total', argv) ?? 0);
  const live = argv.includes('--live');
  if (!SCENARIOS.includes(scenario)) {
    console.error(`--scenario must be one of: ${SCENARIOS.join(', ')}`);
    return 1;
  }
  const now = () => Math.floor(Date.now() / 1000);
  // The simulated device booted just before its history.
  const bootUnix = now() - endAgo * 60 - backfillMin * 60 - 120;

  const run = async (seconds: number, endsAgoSeconds = 0) => {
    const end = now() - endsAgoSeconds;
    const records = simulate(scenario, seconds, end, bootUnix, MINI_1HP, !argv.includes('--no-sensors'));
    // Each run is its own simulated boot, with its own device clock. A real logger counts
    // its boots; two runs both saying boot 1 had their clocks anchored together, and the
    // second run's readings landed a day early.
    const list = batches(device, records, now() - bootUnix, 50, lostTotal, bootUnix % 1_000_000);
    if (argv.includes('--print')) {
      console.log(JSON.stringify(list[0]));
      return;
    }
    for (const b of list) await send(url, key, b);
  };

  console.log(`Simulating ${device} (${scenario}) → ${url}/api/sensor-data/bulk`);
  await run(Math.max(1, Math.round(backfillMin * 60)), Math.round(endAgo * 60));
  while (live && !argv.includes('--print')) {
    await sleep(interval * 1000);
    await run(interval);
  }
  return 0;
}

if (require.main === module) {
  main().then((code) => process.exit(code)).catch((e: Error) => {
    console.error(e.message);
    process.exit(1);
  });
}
