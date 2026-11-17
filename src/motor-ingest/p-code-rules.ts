import { Severity } from '../common/severity';

// No other imports, on purpose: scripts/motor-logger-sim.ts uses these rules to print what
// the device would raise, and that script is compiled on its own for the Railway demo
// service (deploy/README.md), where nothing else in src/ can be resolved.

/**
 * The pump logger's fault codes, worked out from its readings by the device's own rules.
 *
 * The logger raises these six itself but tells only the mobile app, over Bluetooth
 * (`/faults`); its HTTP upload carries readings and no codes. Deriving them here gives the
 * machine page the same answer the app shows, without a firmware change. The rules are
 * the hardware team's (Motor Logger Bluetooth API guide, 30 Oct 2026), word for word:
 *
 * - a code becomes active after its condition holds for 3 samples in a row;
 * - it clears on the first sample without the condition;
 * - the current-based codes (P401, P702, P708) are not judged in the first 5 s after the
 *   pump starts, when inrush current would read as a locked rotor and a slow prime as a
 *   dry run;
 * - the pump is running when current > 0.04 A and voltage > 30 V.
 *
 * One difference, on purpose: the device judges current against the rated current it
 * was flashed with; this judges it against the machine's own rating (nameplate, then
 * model). A machine with no rated current gets no current-based codes at all, never a
 * guessed rating (G07). The voltage and temperature lines are the device's fixed ones,
 * for a 230 V pump.
 */

/** Only the two lamps the guide's warning and critical map to; both are DtcLamp values. */
export interface PCode { code: string; title: string; lamp: 'amber_warning' | 'red_stop'; severity: Severity; currentBased: boolean }

/** Kept in step with the master rows MotorPCodes1765200000000 seeds, which carry the full text. */
export const P_CODES: readonly PCode[] = [
  { code: 'P101', title: 'Low voltage', lamp: 'amber_warning', severity: Severity.High, currentBased: false },
  { code: 'P102', title: 'High voltage', lamp: 'amber_warning', severity: Severity.High, currentBased: false },
  { code: 'P207', title: 'Winding overheating', lamp: 'red_stop', severity: Severity.Critical, currentBased: false },
  { code: 'P401', title: 'Dry run', lamp: 'red_stop', severity: Severity.Critical, currentBased: true },
  { code: 'P702', title: 'Overload', lamp: 'amber_warning', severity: Severity.High, currentBased: true },
  { code: 'P708', title: 'Locked rotor', lamp: 'red_stop', severity: Severity.Critical, currentBased: true },
];

export const ACTIVE_AFTER_SAMPLES = 3;
export const START_GRACE_SECONDS = 5;
/**
 * Two readings further apart than this are not "in a row": what the pump did in between
 * is not known. The same five seconds the start count uses (MotorIngestService).
 */
export const MAX_SAMPLE_GAP_SECONDS = 5;
/**
 * Readings read before the first new one, so a streak or a start that began in the last
 * pass is still seen whole. Far more than 3 samples or 5 s need; cheap at one a second.
 */
export const FAULT_LOOKBACK_SECONDS = 60;

export interface FaultSample { at: Date; voltage: number; current: number; temperature: number }

const isRunning = (s: FaultSample) => s.current > 0.04 && s.voltage > 30;

function condition(code: string, s: FaultSample, rated: number | null): boolean {
  switch (code) {
    case 'P101': return s.voltage > 30 && s.voltage < 190; // supply present, but low
    case 'P102': return s.voltage > 250;
    case 'P207': return s.temperature > 70;
    case 'P401': return rated !== null && isRunning(s) && s.current < 0.8 * rated;
    case 'P702': return rated !== null && isRunning(s) && s.current > 1.2 * rated;
    case 'P708': return rated !== null && isRunning(s) && s.current >= 3 * rated;
    default: return false;
  }
}

/**
 * Which codes the device would hold active at each sample, oldest first. Pure, so the
 * simulator can print what the device would say about the readings it sends.
 */
export function deviceFaults(samples: readonly FaultSample[], ratedCurrent: number | null): { at: Date; active: Set<string> }[] {
  const streak = new Map<string, number>();
  let startedAt: number | null = null;
  let prev: FaultSample | null = null;
  const out: { at: Date; active: Set<string> }[] = [];
  for (const s of samples) {
    const t = s.at.getTime();
    const contiguous = prev !== null && t - prev.at.getTime() <= MAX_SAMPLE_GAP_SECONDS * 1000;
    if (!contiguous) streak.clear();
    if (isRunning(s) && !(contiguous && prev && isRunning(prev))) startedAt = t;
    if (!isRunning(s)) startedAt = null;
    const inGrace = startedAt !== null && t - startedAt < START_GRACE_SECONDS * 1000;
    const active = new Set<string>();
    for (const p of P_CODES) {
      const holds = !(p.currentBased && inGrace) && condition(p.code, s, ratedCurrent);
      const n = holds ? (streak.get(p.code) ?? 0) + 1 : 0;
      streak.set(p.code, n);
      if (n >= ACTIVE_AFTER_SAMPLES) active.add(p.code);
    }
    out.push({ at: s.at, active });
    prev = s;
  }
  return out;
}
