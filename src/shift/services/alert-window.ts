import { runningStatusFor } from './running-status';

/** One reading as a window carries it: which logger, which signal, when. */
export interface WindowSourceReading {
  imei: string;
  signal: string;
  value: number;
  unit?: string | null;
  sourceTimestamp: string;
}

export interface AlertWindowReading {
  imei: string;
  signal: string;
  value: number;
  unit: string | null;
  sourceTimestamp: string;
}

/**
 * What a shift window gives the alert rules, decided once (task QGEN1, G10).
 *
 * The shift runner and the replay both call this. A replay that built its windows
 * differently from production would be replaying a different rule, and its fire count
 * would be a number about nothing that runs — so the decision lives here, not in two
 * places that agree today.
 *
 * `evaluate` is false only when the machine said it never ran: the runner scores no
 * alerts for that window, and neither may a replay of it. A window with no readings at
 * all is still evaluated, with none — that is what a `no-telemetry` rule exists for.
 */
export function alertWindow(rows: WindowSourceReading[]): { evaluate: boolean; readings: AlertWindowReading[] } {
  const readings = rows.map((r) => ({
    imei: r.imei, signal: r.signal, value: r.value, unit: r.unit ?? null, sourceTimestamp: r.sourceTimestamp,
  }));
  return { evaluate: readings.length === 0 || runningStatusFor(readings) !== 'not-running', readings };
}

/**
 * Whether a reading belongs to a window, the way the runner's pull selects it:
 * after the start, up to and including the end (`LegacyTelemetryReader.pull`).
 */
export function inPulledWindow(at: Date, window: { start: Date; end: Date }): boolean {
  return at.getTime() > window.start.getTime() && at.getTime() <= window.end.getTime();
}
