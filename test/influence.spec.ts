import {
  influenceModelFrom, InfluenceModel, scoreInfluence, Sample,
} from '../src/prediction/services/influence';

/**
 * Scoring against physics instead of against a machine's own past (task P4-02).
 *
 * Worked through with the example Things Alive gave: load rises, oil temperature
 * rises with it — expected. Oil temperature rises while load is flat — not expected,
 * and visible on the first shift rather than after thirty days of baseline.
 */
const OIL: InfluenceModel = {
  target: 'oil_temperature',
  // A cold-ish machine sits at 70 degC and gains 0.4 degC per percent of load, so a
  // fully loaded engine is expected around 110.
  intercept: 70,
  terms: [{ signal: 'engine_load', coefficient: 0.4 }],
  warnAbove: 8,
  criticalAbove: 15,
};

const at = (minutes: number) => new Date(`2026-09-14T0${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:00Z`).getTime();

const s = (signal: string, value: number, minutes: number): Sample =>
  ({ signal, value, at: at(minutes) });

describe('scoring against an influence model', () => {
  it('says nothing when the machine is exactly where load says it should be', () => {
    // Load climbs from 20% to 90% and oil temperature climbs with it. Every reading
    // is hotter than the last, and none of it is a fault.
    const samples = [
      s('engine_load', 20, 10), s('oil_temperature', 78, 10),
      s('engine_load', 55, 70), s('oil_temperature', 92, 70),
      s('engine_load', 90, 130), s('oil_temperature', 106, 130),
    ];
    const outcome = scoreInfluence(OIL, samples);

    expect(outcome.scored).toBe(true);
    expect(outcome.severityLevel).toBe('none');
    // A baseline scorer watching oil temperature alone would have seen a 28-degree
    // climb and called it abnormal. The load is what makes it ordinary.
    expect(Math.abs(outcome.worst!.residual)).toBeLessThan(1);
  });

  it('catches the temperature that rose while the load did not', () => {
    // The case that ends in a coolant problem and a breakdown: the same oil
    // temperature, and nothing asking for it.
    const samples = [
      s('engine_load', 20, 10), s('oil_temperature', 78, 10),
      s('engine_load', 22, 70), s('oil_temperature', 95, 70),
      s('engine_load', 21, 130), s('oil_temperature', 104, 130),
    ];
    const outcome = scoreInfluence(OIL, samples);

    expect(outcome.severityLevel).toBe('critical');
    // 104 where 78.4 was expected: 25 degrees of heat nothing accounts for, on the
    // first shift, with no history at all.
    expect(Math.round(outcome.worst!.residual)).toBe(26);
    expect(outcome.worst!.influences).toEqual({ engine_load: 21 });
  });

  it('warns before it escalates', () => {
    const samples = [s('engine_load', 50, 10), s('oil_temperature', 100, 10)];
    // Expected 90, actual 100: ten degrees over, past the warning and short of
    // critical. The gap between the two thresholds is where somebody still has time.
    expect(scoreInfluence(OIL, samples).severityLevel).toBe('warning');
  });

  it('keeps every residual, not just the verdict', () => {
    const samples = [
      s('engine_load', 30, 10), s('oil_temperature', 82, 10),
      s('engine_load', 30, 70), s('oil_temperature', 99, 70),
    ];
    const outcome = scoreInfluence(OIL, samples);
    // An alert that says a machine is off its curve and cannot say by how much, at
    // what load, and when, is one somebody walks out to and finds nothing obvious.
    expect(outcome.residuals).toHaveLength(2);
    expect(outcome.residuals[0]).toMatchObject({ actual: 82, expected: 82 });
  });

  describe('when the readings do not line up', () => {
    it('refuses to pair a target with an influence from hours earlier', () => {
      // A stale influence is worse than a missing one: the residual would be entirely
      // an artefact of the gap, and it looks exactly like a fault.
      const samples = [s('engine_load', 20, 10), s('oil_temperature', 104, 180)];
      const outcome = scoreInfluence({ ...OIL, alignmentSeconds: 300 }, samples);

      expect(outcome.scored).toBe(false);
      expect(outcome.reason).toBe('no-influences');
    });

    it('pairs readings that are merely a few minutes apart', () => {
      const samples = [s('engine_load', 50, 10), s('oil_temperature', 91, 13)];
      expect(scoreInfluence(OIL, samples).scored).toBe(true);
    });

    it('says the answer is partial when much of the shift could not be paired', () => {
      const samples = [
        s('engine_load', 50, 10), s('oil_temperature', 91, 10),
        s('oil_temperature', 93, 100), s('oil_temperature', 94, 160),
      ];
      const outcome = scoreInfluence(OIL, samples);
      // The answer stands, and whoever reads it should know it was built from part of
      // the shift rather than all of it.
      expect(outcome.scored).toBe(true);
      expect(outcome.confidence).toBe('partial');
    });
  });

  describe('staying inside the range the model was fitted for', () => {
    const warmOnly: InfluenceModel = {
      ...OIL,
      validWhen: [{ signal: 'engine_load', min: 15 }],
    };

    it('ignores a machine idling below the range', () => {
      // Oil temperature against load says nothing useful while the engine is warming
      // up, and extrapolating a straight line into a regime nobody characterised
      // produces a confident number about something the model has never seen.
      const samples = [s('engine_load', 3, 10), s('oil_temperature', 60, 10)];
      const outcome = scoreInfluence(warmOnly, samples);
      expect(outcome.scored).toBe(false);
      expect(outcome.reason).toBe('out-of-range');
    });

    it('tells "not reporting the influence" apart from "running outside the model"', () => {
      // One is a commissioning question and the other is a modelling one, and they
      // want different people.
      const noInfluence = scoreInfluence(warmOnly, [s('oil_temperature', 95, 10)]);
      expect(noInfluence.reason).toBe('no-influences');
    });
  });

  it('scores nothing, loudly, when a scenario carries no model', () => {
    expect(scoreInfluence(null, [s('oil_temperature', 200, 10)]))
      .toMatchObject({ scored: false, reason: 'no-model', confidence: 'none' });
  });

  it('combines several influences', () => {
    const withAmbient: InfluenceModel = {
      ...OIL,
      terms: [
        { signal: 'engine_load', coefficient: 0.4 },
        { signal: 'ambient_temperature', coefficient: 0.5 },
      ],
      intercept: 55,
    };
    // A machine in a hot yard is expected to run hotter, and holding it to the same
    // number as one in a cold shed is how a fleet learns to ignore the alerts.
    const samples = [
      s('engine_load', 50, 10), s('ambient_temperature', 40, 10), s('oil_temperature', 95, 10),
    ];
    expect(scoreInfluence(withAmbient, samples).severityLevel).toBe('none');
  });

  describe('reading a model off a scenario', () => {
    it('takes one from the scenario parameters', () => {
      const model = influenceModelFrom([{ key: 'influence_model', default: OIL }]);
      expect(model?.target).toBe('oil_temperature');
    });

    it('lets an asset override the fleet default', () => {
      // One generator in a hot yard, or one that has always run warm, without
      // rewriting the scenario for everybody else.
      const model = influenceModelFrom(
        [{ key: 'influence_model', default: OIL }],
        { influence_model: { ...OIL, warnAbove: 20 } },
      );
      expect(model?.warnAbove).toBe(20);
    });

    it('refuses a model with nothing to compute from', () => {
      expect(influenceModelFrom([{ key: 'influence_model', default: { target: 'x', terms: [] } }]))
        .toBeNull();
      expect(influenceModelFrom(null)).toBeNull();
    });
  });
});
