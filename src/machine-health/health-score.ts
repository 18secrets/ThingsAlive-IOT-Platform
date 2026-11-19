import { Severity } from '../common/severity';
import { LinkState } from '../device-health/services/link-health';
import { Confidence } from '../prediction/services/tier1';
import { ServiceStatus } from '../service/services/service-forecast';

/**
 * A machine's health score, 0 to 100 (D63, decided 2026-11-19).
 *
 * Deterministic, and built only from what 2.0 already measures: the alerts open on the
 * machine, its live predictions, whether its service is due, and whether its logger is
 * reporting. It starts at 100 and loses a fixed, listed amount for each problem, and
 * every deduction is kept with its reason, so a screen — or Vani on the phone — can say
 * why a machine is at 70 and not just that it is.
 *
 * A machine with no device mapped, or whose logger is dark or not yet measured, has no
 * score at all: `unknown`, with the reason. Missing data must never read as healthy
 * (G04), and 100 is exactly what a machine with no data would otherwise get.
 */

/** What one open alert costs, by its severity. The worst counts in full, each further one half. */
export const ALERT_POINTS: Record<Severity, number> = {
  [Severity.Critical]: 40,
  [Severity.High]: 25,
  [Severity.Medium]: 10,
  [Severity.Low]: 5,
  [Severity.None]: 0,
};
/** The share of the highest live prediction risk (0–100) taken off. */
export const PREDICTION_WEIGHT = 0.3;
export const SERVICE_POINTS: Partial<Record<ServiceStatus, number>> = { overdue: 15, due: 5 };
export const BAND_GOOD = 80;
export const BAND_WATCH = 60;
/** A link measurement older than this says nothing about the machine now. */
export const STALE_LINK_HOURS = 48;

/** Logger states that still score, but with the score marked as resting on partial data. */
const PARTIAL_LINK: ReadonlySet<LinkState> = new Set<LinkState>(['partial', 'intermittent']);
/** Logger states that mean the machine cannot be scored at all. */
const NO_LINK: ReadonlySet<LinkState> = new Set<LinkState>(['dark', 'unknown']);

export interface HealthInput {
  /** At least one device is mapped to the machine (`onboardedMachines`). */
  onboarded: boolean;
  /** The machine's latest logger link state, or null when none has been measured. */
  link: LinkState | null;
  /** When that state was measured (the end of its window). */
  linkMeasuredAt: Date | null;
  now: Date;
  /** Every unresolved (open or acknowledged) alert on the machine. */
  alerts: { severity: Severity; title: string }[];
  /** The latest live score of each scenario from the last week. */
  predictions: { scenario: string; riskScore: number; confidence: Confidence }[];
  /** Null when the forecast cannot say (no interval, no meter). */
  service: ServiceStatus | null;
}

export type HealthBand = 'good' | 'watch' | 'act' | 'unknown';
export type UnknownReason = 'not_onboarded' | 'no_link_measured' | 'logger_stale' | 'logger_dark' | 'logger_unknown';

export interface Deduction {
  kind: 'alert' | 'prediction' | 'service';
  points: number;
  /** What it is about, in words: the alert's title, the scenario, the service status. */
  about: string;
}

export interface HealthScore {
  score: number | null;
  band: HealthBand;
  deductions: Deduction[];
  /** The logger is reporting only some of the time; the score is real but thin. */
  partialData: boolean;
  unknownReason?: UnknownReason;
}

export function scoreHealth(input: HealthInput): HealthScore {
  const unknown = (reason: UnknownReason): HealthScore =>
    ({ score: null, band: 'unknown', deductions: [], partialData: false, unknownReason: reason });
  if (!input.onboarded) return unknown('not_onboarded');
  if (input.link === null) return unknown('no_link_measured');
  // A "healthy" measured two days ago is not a healthy logger today.
  if (!input.linkMeasuredAt || input.now.getTime() - input.linkMeasuredAt.getTime() > STALE_LINK_HOURS * 3_600_000) {
    return unknown('logger_stale');
  }
  if (NO_LINK.has(input.link)) return unknown(input.link === 'dark' ? 'logger_dark' : 'logger_unknown');

  const deductions: Deduction[] = [];

  // Worst first, so "worst in full, the rest at half" is the order they are listed in.
  const alerts = [...input.alerts].sort((a, b) => ALERT_POINTS[b.severity] - ALERT_POINTS[a.severity]);
  alerts.forEach((a, i) => {
    const full = ALERT_POINTS[a.severity] ?? 0;
    const points = i === 0 ? full : full / 2;
    if (points > 0) deductions.push({ kind: 'alert', points, about: a.title });
  });

  // A prediction with no confidence has nothing behind it; it neither costs nor clears.
  const counted = input.predictions.filter((p) => p.confidence !== 'none');
  if (counted.length) {
    const worst = counted.reduce((a, b) => (b.riskScore > a.riskScore ? b : a));
    const points = Math.round(worst.riskScore * PREDICTION_WEIGHT);
    if (points > 0) deductions.push({ kind: 'prediction', points, about: worst.scenario });
  }

  const servicePoints = input.service ? SERVICE_POINTS[input.service] : undefined;
  if (servicePoints) deductions.push({ kind: 'service', points: servicePoints, about: input.service! });

  const total = deductions.reduce((sum, d) => sum + d.points, 0);
  const score = Math.max(0, Math.min(100, Math.round(100 - total)));
  return {
    score,
    band: score >= BAND_GOOD ? 'good' : score >= BAND_WATCH ? 'watch' : 'act',
    deductions,
    partialData: PARTIAL_LINK.has(input.link),
  };
}

/**
 * The score as one sentence Vani can say: the number, then why. Null for an unknown
 * score — Vani says nothing about health rather than something that sounds like a
 * reading. Every word is a deduction already listed; nothing is added.
 */
export function healthCardSentence(h: HealthScore): string | null {
  if (h.score === null) return null;
  const why: string[] = [];
  const alerts = h.deductions.filter((d) => d.kind === 'alert');
  if (alerts.length === 1) why.push('one open alert');
  else if (alerts.length > 1) why.push(`${alerts.length} open alerts`);
  if (h.deductions.some((d) => d.kind === 'prediction')) why.push('a prediction showing rising risk');
  const service = h.deductions.find((d) => d.kind === 'service');
  if (service) why.push(service.about === 'overdue' ? 'service overdue' : 'service due');
  const reasons = why.length ? `: ${why.join(', ')}` : ', with nothing open against it';
  const thin = h.partialData ? ' The logger is only reporting part of the time.' : '';
  return `Health score ${h.score} of 100${reasons}.${thin}`;
}
