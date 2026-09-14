import { Confidence } from '../../prediction/services/tier1';
import { Sample } from '../../prediction/services/influence';

/**
 * The physical layer: a chain of causes, not a single relation (task P4-01).
 *
 * Things Alive described the thing this is for exactly: *"load increase raises the oil
 * temperature, and therefore it will affect the oil temperature and coolant and will
 * trigger the maintenance"*. That is a chain, and the influence model shipped in MR !21
 * is one link of it — influences in, one target out, residual scored.
 *
 * Chaining the links buys two things that a single relation cannot give at any price.
 *
 * **It says where the fault is.** When coolant temperature is high, the useful question
 * is not "is it high" but "is it high *because* the oil is hot, which is hot *because*
 * the machine is working hard". Each stage is scored against what its own upstream
 * readings predict, so a stage whose rise is fully accounted for by the stage before it
 * has a residual near zero — and the earliest stage that is *not* accounted for is
 * where the fault entered. That is a diagnosis rather than an alarm: "the load is
 * normal, the oil is 18 degrees hotter than that load explains, and the coolant is
 * exactly what that oil temperature implies" points at one component.
 *
 * **It buys lead time.** Every link carries the delay between a cause moving and its
 * effect appearing. Given where the load is heading, the chain says what the oil will
 * do and when, and what the coolant will do after that — before either has moved.
 *
 * Neither needs history. The coefficients are physics and machine specification rather
 * than a regression over weeks of telemetry, which is the point: this works on a fleet
 * that started reporting yesterday. Fitting them from data later refines the numbers;
 * it does not replace the structure, and the structure is what carries the meaning.
 */

/** Which way a residual has to go before it is a fault. */
export type Direction = 'above' | 'below' | 'either';

export interface ChainDriver {
  /** An upstream stage's signal, or an exogenous input like load or ambient. */
  signal: string;
  /** Units of this stage per unit of the driver. Oil degC per percent of load. */
  coefficient: number;
  /**
   * How long the driver takes to show up here.
   *
   * Oil does not heat the instant the load rises. Pairing a target with an influence
   * from the same second would score the delay itself as a residual, and the residual
   * would be largest exactly when the machine was changing — which is when somebody is
   * most likely to be looking.
   */
  lagSeconds?: number;
}

export interface ChainNode {
  /** The signal this stage predicts. */
  signal: string;
  /** A name somebody can read on a screen: "Oil temperature under load". */
  label?: string;
  /** Expected value when every driver reads zero. */
  intercept: number;
  drivers: ChainDriver[];
  /** Residual magnitude at which this stage is off its curve. */
  warnAbove: number;
  criticalAbove: number;
  /**
   * Which direction is the fault.
   *
   * Not cosmetic. Oil temperature above its expectation is a fault and below it is a
   * cold engine; fuel pressure below its expectation is a fault and above it is
   * nothing. A chain that scored magnitude alone would flag every machine warming up
   * on a winter morning, and that alarm gets muted within a week.
   */
  direction?: Direction;
  /**
   * The machine's own rating for this signal, if it has one.
   *
   * Separate from `warnAbove`, and the difference matters. The residual thresholds
   * catch a stage misbehaving *relative to its conditions* — oil hotter than this load
   * explains — which is the early warning, and it fires while every absolute number is
   * still comfortable. A limit catches the signal exceeding what the machine is rated
   * for, which is a different fault and the only one a projection can speak to at all,
   * because a projection has no observation to take a residual against.
   */
  limits?: { warnAt?: number; criticalAt?: number };
  /** Ignore the stage entirely outside these ranges. */
  validWhen?: { signal: string; min?: number; max?: number }[];
}

export interface CausalChain {
  slug: string;
  /** What the far end of the chain is watching for. */
  outcome?: string;
  nodes: ChainNode[];
  /** How far apart two readings may be and still describe the same moment. */
  alignmentSeconds?: number;
}

export const DEFAULT_ALIGNMENT_SECONDS = 300;

export type StageVerdict =
  /** Scored, and within what its drivers predict. */
  | 'normal'
  /** Scored, off its curve, and the earliest stage that is. */
  | 'origin'
  /** Scored, off its curve, downstream of an origin — a second, separate fault. */
  | 'additional'
  /** Not scored. `reason` says what was missing. */
  | 'unevaluated';

export interface StageResult {
  signal: string;
  label?: string;
  verdict: StageVerdict;
  reason?: 'no-target' | 'driver-missing' | 'out-of-range';
  /** Which drivers could not be paired, when that is why. */
  missingDrivers?: string[];
  at?: number;
  actual?: number;
  expected?: number;
  /** actual - expected. Signed, so the direction is readable. */
  residual?: number;
  /** Residual over warnAbove, in the fault direction. 1 is exactly at the threshold. */
  exceedance?: number;
  severity?: 'none' | 'warning' | 'critical';
  /** What each driver read, after lag alignment. */
  drivers?: Record<string, number>;
  /** Hops from the nearest exogenous input. Depth in the chain. */
  depth: number;
}

export interface ChainDiagnosis {
  slug: string;
  evaluated: boolean;
  reason?: 'no-nodes' | 'cycle' | 'nothing-evaluable';
  confidence: Confidence;
  stages: StageResult[];
  /** The earliest stage off its curve. The thing to go and look at. */
  origin?: StageResult;
  /** Faults downstream of the origin that the origin does not account for. */
  additional: StageResult[];
  /**
   * Stages downstream of the origin whose own residual is near zero — that is, whose
   * rise is fully explained by the fault above them. Named, because "the coolant is
   * also high" is the first thing somebody will say, and this is the answer to it.
   */
  explainedBy?: { signal: string; because: string }[];
}

/**
 * Order the stages so every driver comes before what it drives.
 *
 * Kahn's algorithm, and the cycle check is the reason it is here rather than a sort.
 * A chain with a cycle is a definition mistake — coolant cooling oil while oil heats
 * coolant is physically true and is not a predictive chain — and evaluating one would
 * either not terminate or settle on whichever answer the iteration order produced.
 */
export function topologicalOrder(nodes: ChainNode[]): ChainNode[] | null {
  const byTarget = new Map(nodes.map((n) => [n.signal, n]));
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();

  for (const node of nodes) {
    indegree.set(node.signal, 0);
  }
  for (const node of nodes) {
    for (const driver of node.drivers) {
      // Only drivers that are themselves stages create an ordering constraint.
      // Exogenous inputs are already there before anything runs.
      if (!byTarget.has(driver.signal)) continue;
      indegree.set(node.signal, (indegree.get(node.signal) ?? 0) + 1);
      dependents.set(driver.signal, [...(dependents.get(driver.signal) ?? []), node.signal]);
    }
  }

  const ready = nodes.filter((n) => (indegree.get(n.signal) ?? 0) === 0).map((n) => n.signal);
  const order: ChainNode[] = [];
  while (ready.length) {
    const signal = ready.shift()!;
    const node = byTarget.get(signal);
    if (node) order.push(node);
    for (const next of dependents.get(signal) ?? []) {
      const left = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, left);
      if (left === 0) ready.push(next);
    }
  }

  return order.length === nodes.length ? order : null;
}

/** How far each stage sits from the nearest exogenous input. */
function depths(order: ChainNode[]): Map<string, number> {
  const byTarget = new Set(order.map((n) => n.signal));
  const depth = new Map<string, number>();
  for (const node of order) {
    const upstream = node.drivers
      .filter((d) => byTarget.has(d.signal))
      .map((d) => depth.get(d.signal) ?? 0);
    depth.set(node.signal, upstream.length ? Math.max(...upstream) + 1 : 0);
  }
  return depth;
}

/** The reading of `signal` nearest to `at`, within tolerance. */
function nearest(
  samples: Sample[], signal: string, at: number, toleranceMs: number,
): Sample | null {
  let best: Sample | null = null;
  let bestGap = Infinity;
  for (const s of samples) {
    if (s.signal !== signal) continue;
    const gap = Math.abs(s.at - at);
    if (gap <= toleranceMs && gap < bestGap) { best = s; bestGap = gap; }
  }
  return best;
}

function inRange(
  node: ChainNode, samples: Sample[], at: number, toleranceMs: number,
): boolean {
  for (const rule of node.validWhen ?? []) {
    const sample = nearest(samples, rule.signal, at, toleranceMs);
    if (!sample) return false;
    if (rule.min !== undefined && sample.value < rule.min) return false;
    if (rule.max !== undefined && sample.value > rule.max) return false;
  }
  return true;
}

/** Residual in the fault direction, as a multiple of the warning threshold. */
function exceedanceOf(residual: number, node: ChainNode): number {
  const direction = node.direction ?? 'above';
  const faulty = direction === 'above' ? residual
    : direction === 'below' ? -residual
    : Math.abs(residual);
  if (node.warnAbove <= 0) return 0;
  return faulty / node.warnAbove;
}

/**
 * Score every stage against what its own upstream readings predict (task P4-01).
 *
 * The drivers are read from what was actually observed, not from what the chain
 * expected them to be, and that choice is what produces the diagnosis. If the oil is
 * 18 degrees hotter than the load explains, the coolant stage is scored against the
 * *real, elevated* oil temperature — so the coolant comes out normal, because it is
 * behaving exactly as that oil temperature implies. The anomaly stays at the stage it
 * entered instead of smearing down the chain and lighting up every screen below it.
 */
export function diagnoseChain(
  chain: CausalChain,
  samples: Sample[],
  at?: number,
): ChainDiagnosis {
  const empty = { slug: chain.slug, stages: [], additional: [], confidence: 'none' as Confidence };
  if (!chain.nodes.length) return { ...empty, evaluated: false, reason: 'no-nodes' };

  const order = topologicalOrder(chain.nodes);
  if (!order) return { ...empty, evaluated: false, reason: 'cycle' };

  const toleranceMs = (chain.alignmentSeconds ?? DEFAULT_ALIGNMENT_SECONDS) * 1000;
  const depth = depths(order);

  // Score at the moment of the newest reading unless told otherwise: the chain is
  // answering "what is wrong now", and the newest instant is the only one where every
  // stage can have something to say.
  const moment = at ?? Math.max(...samples.map((s) => s.at), 0);

  const stages: StageResult[] = [];
  for (const node of order) {
    const base = { signal: node.signal, label: node.label, depth: depth.get(node.signal) ?? 0 };

    const target = nearest(samples, node.signal, moment, toleranceMs);
    if (!target) {
      stages.push({ ...base, verdict: 'unevaluated', reason: 'no-target' });
      continue;
    }
    if (!inRange(node, samples, target.at, toleranceMs)) {
      // A linear stage is true over the regime it was written for. A warming engine is
      // not the regime, and extrapolating into it produces a confident number about a
      // machine state nobody characterised.
      stages.push({ ...base, verdict: 'unevaluated', reason: 'out-of-range', at: target.at });
      continue;
    }

    const driverValues: Record<string, number> = {};
    const missing: string[] = [];
    for (const driver of node.drivers) {
      // The driver is read from where it was `lagSeconds` *before* this stage, because
      // that is the reading this stage is a consequence of.
      const sample = nearest(
        samples, driver.signal, target.at - (driver.lagSeconds ?? 0) * 1000, toleranceMs,
      );
      if (!sample) { missing.push(driver.signal); continue; }
      driverValues[driver.signal] = sample.value;
    }

    if (missing.length) {
      /*
       * A stage whose driver is missing is not scored, and nothing downstream of it can
       * be either.
       *
       * The tempting alternative is to substitute what the chain *expected* the missing
       * driver to be and carry on. That would silently swap a measurement for an
       * assumption, and the whole diagnostic value here rests on the difference: a
       * residual computed against an assumed upstream cannot distinguish "this stage is
       * faulty" from "the stage above it was, and nobody measured it".
       */
      stages.push({ ...base, verdict: 'unevaluated', reason: 'driver-missing', missingDrivers: missing, at: target.at });
      continue;
    }

    const expected = node.drivers.reduce(
      (sum, d) => sum + d.coefficient * driverValues[d.signal], node.intercept,
    );
    const residual = target.value - expected;
    const exceedance = exceedanceOf(residual, node);
    const severity = exceedance >= (node.criticalAbove / Math.max(node.warnAbove, 1e-9))
      ? 'critical' : exceedance >= 1 ? 'warning' : 'none';

    stages.push({
      ...base,
      verdict: severity === 'none' ? 'normal' : 'origin',
      at: target.at,
      actual: target.value,
      expected: round(expected),
      residual: round(residual),
      exceedance: round(exceedance),
      severity,
      drivers: driverValues,
    });
  }

  const scored = stages.filter((s) => s.verdict !== 'unevaluated');
  if (!scored.length) {
    return { ...empty, evaluated: false, reason: 'nothing-evaluable', stages };
  }

  // The earliest stage off its curve is where the fault entered. Everything flagged
  // after it is a second fault rather than an echo of the first, because each was
  // already scored against its own observed upstream.
  const flagged = stages.filter((s) => s.verdict === 'origin');
  const origin = flagged[0];
  for (const stage of flagged.slice(1)) stage.verdict = 'additional';

  const explainedBy = origin
    ? stages
      .filter((s) => s.verdict === 'normal' && s.depth > origin.depth)
      .map((s) => ({ signal: s.signal, because: origin.signal }))
    : undefined;

  return {
    slug: chain.slug,
    evaluated: true,
    confidence: scored.length === chain.nodes.length ? 'full' : 'partial',
    stages,
    origin,
    additional: stages.filter((s) => s.verdict === 'additional'),
    explainedBy: explainedBy?.length ? explainedBy : undefined,
  };
}

export interface ProjectedStage {
  signal: string;
  label?: string;
  expected: number;
  /** Seconds from now before this stage has finished responding. */
  leadSeconds: number;
  depth: number;
  /**
   * Whether the projected value breaches this stage's rating, and null when the stage
   * has no rating to breach. Null rather than false: "not configured" and "within
   * limits" are different answers, and a screen showing them alike would report a
   * fleet as safe on the strength of nobody having entered a number.
   */
  breach: 'none' | 'warning' | 'critical' | null;
  /** Degrades with depth: a projection two stages out rests on two assumptions. */
  confidence: Confidence;
}

export interface ChainProjection {
  slug: string;
  projected: boolean;
  reason?: 'no-nodes' | 'cycle' | 'no-inputs';
  stages: ProjectedStage[];
  /** The first stage the chain says will breach its rating, and how long there is. */
  firstBreach?: ProjectedStage;
}

/**
 * Where the chain ends up if the inputs go where they are heading (task P4-01).
 *
 * The other half of the point, and the half that produces lead time. Diagnosis feeds
 * observed values forward and asks what is wrong now; projection feeds *assumed* ones
 * forward and asks what will be wrong shortly. The lag on each link accumulates down
 * the chain, so the answer carries a when as well as a what: put the load at 90% and
 * the oil reaches 112 degrees about twelve minutes later, and the coolant follows it
 * eight minutes after that.
 *
 * `inputs` are the exogenous signals, set to wherever the caller believes they are
 * going. Extrapolating that trend is deliberately somebody else's job: a chain that
 * guessed at where the load was heading would bury an assumption about the operator's
 * afternoon inside a statement about physics.
 */
export function projectChain(
  chain: CausalChain,
  inputs: Record<string, number>,
): ChainProjection {
  if (!chain.nodes.length) return { slug: chain.slug, projected: false, reason: 'no-nodes', stages: [] };
  const order = topologicalOrder(chain.nodes);
  if (!order) return { slug: chain.slug, projected: false, reason: 'cycle', stages: [] };
  if (!Object.keys(inputs).length) {
    return { slug: chain.slug, projected: false, reason: 'no-inputs', stages: [] };
  }

  const depth = depths(order);
  const value = new Map<string, number>(Object.entries(inputs));
  const lead = new Map<string, number>();
  for (const signal of Object.keys(inputs)) lead.set(signal, 0);

  const stages: ProjectedStage[] = [];
  for (const node of order) {
    let expected = node.intercept;
    let arrivesAt = 0;
    let known = true;
    for (const driver of node.drivers) {
      const driverValue = value.get(driver.signal);
      if (driverValue === undefined) { known = false; break; }
      expected += driver.coefficient * driverValue;
      // This stage cannot settle until its slowest driver has settled and then taken
      // its own delay to show up here.
      arrivesAt = Math.max(arrivesAt, (lead.get(driver.signal) ?? 0) + (driver.lagSeconds ?? 0));
    }
    // A stage with an unknown driver stops the chain there. Carrying on with a gap
    // would put a number on a screen that rests on nothing.
    if (!known) break;

    value.set(node.signal, expected);
    lead.set(node.signal, arrivesAt);

    const d = depth.get(node.signal) ?? 0;
    stages.push({
      signal: node.signal,
      label: node.label,
      expected: round(expected),
      leadSeconds: arrivesAt,
      depth: d,
      breach: breachOf(expected, node),
      confidence: d === 0 ? 'full' : d <= 2 ? 'partial' : 'none',
    });
  }

  // Soonest first, because the question a projection answers is how long there is.
  const breaching = stages
    .filter((s) => s.breach === 'warning' || s.breach === 'critical')
    .sort((a, b) => a.leadSeconds - b.leadSeconds);

  return {
    slug: chain.slug,
    projected: stages.length > 0,
    stages,
    firstBreach: breaching[0],
  };
}

/**
 * Whether a value is past the stage's rating, in the direction that counts as a fault.
 *
 * Null when no rating was given. A stage with no limit has not been declared safe; it
 * has been declared unspecified, and reporting that as `none` would let an unconfigured
 * chain read as a fleet in good order.
 */
function breachOf(value: number, node: ChainNode): 'none' | 'warning' | 'critical' | null {
  const { warnAt, criticalAt } = node.limits ?? {};
  if (warnAt === undefined && criticalAt === undefined) return null;
  const direction = node.direction ?? 'above';
  const past = (limit: number | undefined): boolean => {
    if (limit === undefined) return false;
    if (direction === 'below') return value <= limit;
    if (direction === 'either') return Math.abs(value) >= Math.abs(limit);
    return value >= limit;
  };
  if (past(criticalAt)) return 'critical';
  if (past(warnAt)) return 'warning';
  return 'none';
}

const round = (n: number): number => Math.round(n * 1000) / 1000;
