import {
  CausalChain,
  ChainNode,
  diagnoseChain,
  projectChain,
  topologicalOrder,
} from '../src/intelligence/services/causal-chain';
import { Sample } from '../src/prediction/services/influence';

/**
 * The causal chain (task P4-01).
 *
 * Built around Things Alive's own example: load raises oil temperature, oil temperature
 * raises coolant temperature, and somewhere along there maintenance becomes due. The
 * tests that matter are the ones about *where* an anomaly is reported, because that is
 * the whole reason for chaining links rather than scoring them separately.
 */

const T0 = Date.parse('2026-09-14T08:00:00Z');
const at = (signal: string, value: number, offsetSeconds = 0): Sample =>
  ({ signal, value, at: T0 + offsetSeconds * 1000 });

/**
 * Oil runs at 40 degrees plus a third of a degree per percent of load, and coolant
 * tracks oil at 20 degrees plus 0.6 of it. At 60% load: oil 60, coolant 56.
 */
const OIL: ChainNode = {
  signal: 'engine_oil_temperature',
  label: 'Oil temperature under load',
  intercept: 40,
  drivers: [{ signal: 'engine_load', coefficient: 1 / 3, lagSeconds: 600 }],
  warnAbove: 8,
  criticalAbove: 16,
  limits: { warnAt: 105, criticalAt: 120 },
};
const COOLANT: ChainNode = {
  signal: 'engine_coolant_temperature',
  label: 'Coolant temperature from oil',
  intercept: 20,
  drivers: [{ signal: 'engine_oil_temperature', coefficient: 0.6, lagSeconds: 480 }],
  warnAbove: 6,
  criticalAbove: 12,
  limits: { warnAt: 95, criticalAt: 105 },
};

const chain: CausalChain = {
  slug: 'dg-thermal-path',
  outcome: 'cooling-system-maintenance',
  nodes: [COOLANT, OIL], // deliberately out of order; the evaluator sorts them
  alignmentSeconds: 900,
};

/** A machine at `load`, with oil and coolant exactly where the chain predicts. */
const healthy = (load = 60, oilOffset = 0, coolantOffset = 0): Sample[] => {
  const oil = 40 + load / 3 + oilOffset;
  const coolant = 20 + 0.6 * oil + coolantOffset;
  return [
    at('engine_load', load, -600),
    at('engine_oil_temperature', oil, -480),
    at('engine_coolant_temperature', coolant, 0),
  ];
};

describe('topologicalOrder', () => {
  it('puts a driver before what it drives, whatever order they were written in', () => {
    const order = topologicalOrder([COOLANT, OIL])!;
    expect(order.map((n) => n.signal))
      .toEqual(['engine_oil_temperature', 'engine_coolant_temperature']);
  });

  it('refuses a cycle rather than settling on an iteration order', () => {
    // Coolant cooling oil while oil heats coolant is physically true and is not a
    // predictive chain. Evaluating it would either not terminate or pick an answer
    // depending on which node happened to be first in the array.
    const a: ChainNode = { ...OIL, drivers: [{ signal: 'engine_coolant_temperature', coefficient: 1 }] };
    expect(topologicalOrder([a, COOLANT])).toBeNull();
  });

  it('treats an unmodelled driver as an input that is simply there', () => {
    expect(topologicalOrder([OIL])!.map((n) => n.signal)).toEqual(['engine_oil_temperature']);
  });
});

describe('diagnoseChain', () => {
  it('reports a machine on its curve as normal at every stage', () => {
    const d = diagnoseChain(chain, healthy());
    expect(d.evaluated).toBe(true);
    expect(d.confidence).toBe('full');
    expect(d.origin).toBeUndefined();
    expect(d.stages.map((s) => s.verdict)).toEqual(['normal', 'normal']);
  });

  it('does not flag a hot machine that is hot because it is working hard', () => {
    // 95% load: oil at 71.7, coolant at 63. Both far above where they sit at idle, and
    // nothing is wrong. A threshold on the raw signal would have fired twice here.
    const d = diagnoseChain(chain, healthy(95));
    expect(d.origin).toBeUndefined();
    expect(d.stages.every((s) => s.verdict === 'normal')).toBe(true);
  });

  it('names the stage where the fault entered, and only that stage', () => {
    // Oil 18 degrees above what the load explains. Coolant follows it up — and is
    // exactly what that oil temperature implies, so the coolant stage is clean.
    const d = diagnoseChain(chain, healthy(60, 18));

    expect(d.origin!.signal).toBe('engine_oil_temperature');
    expect(d.origin!.residual).toBeCloseTo(18, 5);
    expect(d.origin!.severity).toBe('critical');
    expect(d.additional).toEqual([]);

    const coolant = d.stages.find((s) => s.signal === 'engine_coolant_temperature')!;
    expect(coolant.verdict).toBe('normal');
    expect(coolant.residual).toBeCloseTo(0, 5);
  });

  it('says out loud that the downstream stage is explained by the one above it', () => {
    // "The coolant is also high" is the first thing somebody will say. This is the
    // answer to it, and it is the sentence that stops a second engineer being sent.
    const d = diagnoseChain(chain, healthy(60, 18));
    expect(d.explainedBy).toEqual([
      { signal: 'engine_coolant_temperature', because: 'engine_oil_temperature' },
    ]);
  });

  it('finds a fault that starts downstream, with the stage above it clean', () => {
    // Oil is exactly where the load puts it; the coolant is 9 degrees hotter than that
    // oil explains. A blocked radiator rather than an engine problem.
    const d = diagnoseChain(chain, healthy(60, 0, 9));
    expect(d.origin!.signal).toBe('engine_coolant_temperature');
    expect(d.stages.find((s) => s.signal === 'engine_oil_temperature')!.verdict).toBe('normal');
    expect(d.explainedBy).toBeUndefined();
  });

  it('reports a second fault as additional rather than as an echo of the first', () => {
    // Oil 18 above its curve *and* coolant 10 above what that oil explains. Two
    // separate things, and collapsing them into one would leave half the job undone.
    const d = diagnoseChain(chain, healthy(60, 18, 10));
    expect(d.origin!.signal).toBe('engine_oil_temperature');
    expect(d.additional.map((s) => s.signal)).toEqual(['engine_coolant_temperature']);
    expect(d.additional[0].residual).toBeCloseTo(10, 5);
  });

  it('reads each driver from before the lag, not from the same instant', () => {
    // The load moved ten minutes ago and the oil has responded. Pairing the two at the
    // same second would score the delay itself as a residual — largest exactly when
    // the machine is changing, which is when somebody is most likely to be looking.
    const samples: Sample[] = [
      at('engine_load', 30, -3600),
      at('engine_load', 90, -600),
      at('engine_oil_temperature', 40 + 90 / 3, 0),
      at('engine_coolant_temperature', 20 + 0.6 * (40 + 90 / 3), 480),
    ];
    const d = diagnoseChain({ ...chain, alignmentSeconds: 300 }, samples, T0);
    const oil = d.stages.find((s) => s.signal === 'engine_oil_temperature')!;
    expect(oil.drivers!.engine_load).toBe(90);
    expect(oil.residual).toBeCloseTo(0, 5);
  });

  it('respects the direction a fault runs in', () => {
    // Oil 18 degrees *below* its curve is a cold engine, not an overheating one. A
    // chain scoring magnitude alone would flag every machine warming up in winter.
    const d = diagnoseChain(chain, healthy(60, -18));
    expect(d.origin).toBeUndefined();

    const either = { ...chain, nodes: [{ ...OIL, direction: 'either' as const }, COOLANT] };
    expect(diagnoseChain(either, healthy(60, -18)).origin!.signal)
      .toBe('engine_oil_temperature');
  });

  it('scores a below-direction stage the other way round', () => {
    const pressure: ChainNode = {
      signal: 'engine_oil_pressure', intercept: 5,
      drivers: [{ signal: 'engine_load', coefficient: 0.02 }],
      warnAbove: 0.8, criticalAbove: 1.5, direction: 'below',
    };
    const low = [at('engine_load', 50), at('engine_oil_pressure', 5 + 1 - 1.2)];
    const d = diagnoseChain({ slug: 'oil-pressure', nodes: [pressure] }, low);
    expect(d.origin!.signal).toBe('engine_oil_pressure');
    expect(d.origin!.residual).toBeCloseTo(-1.2, 5);
    expect(d.origin!.exceedance).toBeCloseTo(1.5, 3);
  });

  it('will not score a stage whose driver nobody measured', () => {
    /*
     * The tempting alternative is to substitute what the chain expected the oil to be
     * and carry on. That swaps a measurement for an assumption, and the whole value
     * here rests on the difference — a residual against an assumed upstream cannot
     * tell "this stage is faulty" from "the stage above it was, unmeasured".
     */
    const d = diagnoseChain(chain, [
      at('engine_load', 60, -600),
      at('engine_coolant_temperature', 80, 0),
    ]);
    const coolant = d.stages.find((s) => s.signal === 'engine_coolant_temperature')!;
    expect(coolant.verdict).toBe('unevaluated');
    expect(coolant.reason).toBe('driver-missing');
    expect(coolant.missingDrivers).toEqual(['engine_oil_temperature']);
    // And the chain still reports what it could: the oil stage had no reading either.
    expect(d.evaluated).toBe(false);
    expect(d.reason).toBe('nothing-evaluable');
  });

  it('scores what it can and says the answer is partial', () => {
    const d = diagnoseChain(chain, [
      at('engine_load', 60, -600),
      at('engine_oil_temperature', 60, 0),
    ]);
    expect(d.evaluated).toBe(true);
    expect(d.confidence).toBe('partial');
    expect(d.stages.find((s) => s.signal === 'engine_coolant_temperature')!.reason)
      .toBe('no-target');
  });

  it('skips a stage outside the regime it was written for', () => {
    // A linear stage is true over the range it was characterised on. A warming engine
    // is not that range.
    const warmOnly: ChainNode = {
      ...OIL, validWhen: [{ signal: 'engine_coolant_temperature', min: 70 }],
    };
    const d = diagnoseChain({ slug: 'x', nodes: [warmOnly] }, [
      at('engine_load', 60, -600),
      at('engine_oil_temperature', 200, 0),
      at('engine_coolant_temperature', 30, 0),
    ]);
    expect(d.stages[0].verdict).toBe('unevaluated');
    expect(d.stages[0].reason).toBe('out-of-range');
  });

  it('refuses an empty chain and a cyclic one', () => {
    expect(diagnoseChain({ slug: 'x', nodes: [] }, []).reason).toBe('no-nodes');
    const a: ChainNode = { ...OIL, drivers: [{ signal: 'engine_coolant_temperature', coefficient: 1 }] };
    expect(diagnoseChain({ slug: 'x', nodes: [a, COOLANT] }, healthy()).reason).toBe('cycle');
  });
});

describe('projectChain', () => {
  it('says where the chain ends up, and how long each stage takes to get there', () => {
    // The lead time accumulates down the chain: oil responds ten minutes after the
    // load, and the coolant eight minutes after the oil.
    const p = projectChain(chain, { engine_load: 95 });
    expect(p.projected).toBe(true);

    const oil = p.stages.find((s) => s.signal === 'engine_oil_temperature')!;
    expect(oil.expected).toBeCloseTo(40 + 95 / 3, 3);
    expect(oil.leadSeconds).toBe(600);

    const coolant = p.stages.find((s) => s.signal === 'engine_coolant_temperature')!;
    expect(coolant.expected).toBeCloseTo(20 + 0.6 * (40 + 95 / 3), 3);
    expect(coolant.leadSeconds).toBe(1080);
  });

  it('degrades confidence with every hop, because each is another assumption', () => {
    const p = projectChain(chain, { engine_load: 95 });
    expect(p.stages.find((s) => s.depth === 0)!.confidence).toBe('full');
    expect(p.stages.find((s) => s.depth === 1)!.confidence).toBe('partial');
  });

  it('names the first stage to breach its rating, soonest first', () => {
    // Oil is rated to 105. At 220% load it gets there; the projection says so before
    // the machine has been anywhere near it.
    const p = projectChain(chain, { engine_load: 220 });
    expect(p.firstBreach!.signal).toBe('engine_oil_temperature');
    expect(p.firstBreach!.breach).toBe('warning');
    expect(p.firstBreach!.leadSeconds).toBe(600);
  });

  it('tells a stage within its rating apart from a stage with no rating', () => {
    // Not configured and within limits are different answers, and a screen showing
    // them alike reports a fleet as safe on the strength of nobody entering a number.
    const p = projectChain(chain, { engine_load: 60 });
    expect(p.stages.find((s) => s.signal === 'engine_oil_temperature')!.breach).toBe('none');

    const unrated = { ...chain, nodes: [{ ...OIL, limits: undefined }] };
    expect(projectChain(unrated, { engine_load: 60 }).stages[0].breach).toBeNull();
  });

  it('stops at the first stage it cannot compute rather than guessing past it', () => {
    // Nothing supplies the load, so the oil stage cannot be projected and the coolant
    // stage rests on it. A number on a screen resting on nothing is worse than a gap.
    const p = projectChain(chain, { ambient_temperature: 20 });
    expect(p.stages).toEqual([]);
    expect(p.projected).toBe(false);
  });

  it('refuses without inputs, and refuses a cycle', () => {
    expect(projectChain(chain, {}).reason).toBe('no-inputs');
    const a: ChainNode = { ...OIL, drivers: [{ signal: 'engine_coolant_temperature', coefficient: 1 }] };
    expect(projectChain({ slug: 'x', nodes: [a, COOLANT] }, { engine_load: 1 }).reason)
      .toBe('cycle');
  });
});
