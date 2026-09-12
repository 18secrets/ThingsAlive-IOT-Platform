import { Severity } from '../src/common/severity';
import {
  DEFAULT_MINIMUM_SAMPLES, SignalBaseline, SignalObservation, compositeRisk, scoreTier1,
} from '../src/prediction/services/tier1';

/**
 * The Tier 1 scorer, without a database (task P1-14).
 *
 * The scorer is a pure function, so these tests state the rules directly: a z-score
 * band, a composite, five severity levels and the three-signal flag. When the browser
 * source becomes available, the parity suite (P1-15) replaces the judgement calls
 * here with recorded fixtures — but the structural rules below hold either way, and
 * they are the ones that decide whether an operator is called out.
 */
describe('tier 1 scorer', () => {
  const at = new Date('2026-09-12T00:00:00.000Z');
  const obs = (signal: string, value: number): SignalObservation => ({ signal, value, at });
  const base = (signal: string, mean: number, stddev: number, n = 100): SignalBaseline =>
    ({ signal, mean, stddev, sampleCount: n });

  it('bands a signal by how far it sits from its own normal', () => {
    const score = (value: number) => scoreTier1({
      requiredSignals: ['coolant_temp'],
      observations: [obs('coolant_temp', value)],
      baselines: [base('coolant_temp', 80, 2)],
    }).signals[0];

    expect(score(81).state).toBe('normal');    // 0.5σ
    expect(score(83.5).state).toBe('warning'); // 1.75σ
    expect(score(86).state).toBe('critical');  // 3.0σ
    // Symmetric. A coolant temperature far below normal is as much a fault as one
    // above it — a failed thermostat reads cold, and an absolute threshold misses it.
    expect(score(74).state).toBe('critical');
  });

  it('refuses to score a signal that never varies, instead of calling it normal', () => {
    const out = scoreTier1({
      requiredSignals: ['oil_pressure'],
      observations: [obs('oil_pressure', 4.2)],
      baselines: [base('oil_pressure', 4.2, 0)],
    });

    // A standard deviation of zero usually means a sensor stuck on one number. Scored
    // as normal it would be invisible; scored as an anomaly it would cry wolf on
    // genuinely constant signals. Unscored with a reason is the only honest answer.
    expect(out.signals[0]).toMatchObject({ state: 'unscored', reason: 'no-variance', z: null });
    expect(out.confidence).toBe('none');
  });

  it('refuses a baseline built from too few readings', () => {
    const out = scoreTier1({
      requiredSignals: ['coolant_temp'],
      observations: [obs('coolant_temp', 200)],
      baselines: [base('coolant_temp', 80, 2, DEFAULT_MINIMUM_SAMPLES - 1)],
    });
    expect(out.signals[0].reason).toBe('too-few-samples');
    // Even at 60σ. A baseline from a handful of readings makes every value extreme,
    // which is how a newly commissioned machine alarms for a week.
    expect(out.severity).toBe(Severity.None);
  });

  it('distinguishes a quiet machine from one nobody can see', () => {
    const healthy = scoreTier1({
      requiredSignals: ['coolant_temp'],
      observations: [obs('coolant_temp', 80)],
      baselines: [base('coolant_temp', 80, 2)],
    });
    const blind = scoreTier1({
      requiredSignals: ['coolant_temp'],
      observations: [],
      baselines: [base('coolant_temp', 80, 2)],
    });

    // Identical severity, and they must not be identical outcomes.
    expect(healthy.severity).toBe(Severity.None);
    expect(blind.severity).toBe(Severity.None);
    expect(healthy.confidence).toBe('full');
    expect(blind.confidence).toBe('none');
    expect(blind.signals[0].reason).toBe('no-reading');
  });

  it('reports partial confidence when some signals are scorable and some are not', () => {
    const out = scoreTier1({
      requiredSignals: ['coolant_temp', 'oil_pressure'],
      observations: [obs('coolant_temp', 86)],
      baselines: [base('coolant_temp', 80, 2)],
    });
    expect(out.confidence).toBe('partial');
    expect(out.scoredCount).toBe(1);
    expect(out.unscoredCount).toBe(1);
    // The one signal that could be read still produces a verdict. Withholding the
    // whole outcome because half the sensors are missing would suppress real faults
    // on exactly the assets that are hardest to see.
    expect(out.severity).toBe(Severity.Critical);
  });

  it('raises the flag at three abnormal signals, and not at two', () => {
    const spread = (n: number) => scoreTier1({
      requiredSignals: ['a', 'b', 'c', 'd'],
      observations: ['a', 'b', 'c', 'd'].map((s, i) => obs(s, i < n ? 84 : 80)),
      baselines: ['a', 'b', 'c', 'd'].map((s) => base(s, 80, 2)),
    });

    expect(spread(2).highPriority).toBe(false);
    expect(spread(3).highPriority).toBe(true);
    // The flag says how broad, severity says how bad. Three signals drifting mildly
    // is high priority and not critical; one signal at 5σ is the reverse.
    expect(spread(3).severity).not.toBe(Severity.Critical);
    expect(spread(3).abnormalCount).toBe(3);
  });

  it('lets a scenario move its own thresholds', () => {
    const input = {
      requiredSignals: ['vibration_velocity'],
      observations: [obs('vibration_velocity', 4.4)],
      baselines: [base('vibration_velocity', 4, 0.2)],
    };
    // 2σ: warning by default, critical for a scenario that says so.
    expect(scoreTier1(input).signals[0].state).toBe('warning');
    expect(scoreTier1({ ...input, criticalSigma: 1.8 }).signals[0].state).toBe('critical');
  });

  it('weights the worst signal without ignoring how many are drifting', () => {
    const one = compositeRisk([1]);
    const four = compositeRisk([1, 1, 1, 1]);
    const oneAmongQuiet = compositeRisk([1, 0, 0, 0]);

    // Breadth matters: four signals at the critical line score higher than one.
    expect(four).toBeGreaterThan(oneAmongQuiet);
    // But a single severe signal is never diluted into irrelevance by quiet ones.
    expect(oneAmongQuiet).toBeGreaterThanOrEqual(0.7 * one);
    expect(compositeRisk([])).toBe(0);
    expect(four).toBe(100);
  });

  it('never returns a score outside the band it promises', () => {
    // A z-score has no upper bound and a risk score does. Clamping in one place is
    // the difference between "risk 100" and "risk 4300" reaching a screen.
    const out = scoreTier1({
      requiredSignals: ['x'],
      observations: [obs('x', 100_000)],
      baselines: [base('x', 0, 1)],
    });
    expect(out.riskScore).toBe(100);
    expect(out.severity).toBe(Severity.Critical);
  });
});
