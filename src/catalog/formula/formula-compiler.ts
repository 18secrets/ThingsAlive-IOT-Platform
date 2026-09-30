import { FormulaCompileError } from './errors';
import { lookupOperator } from './operator-registry';
import { MAX_DEPTH, MAX_NODES, parseExpression, RawNode } from './parser';
import { divideUnits, multiplyUnits, parseUnitString, renderUnit, Unit, unitsEqual, DIMENSIONLESS } from './units';

export { FormulaCompileError } from './errors';

/** Bumped whenever the emitted plan shape or the unit/composition rules change, so a
 * plan compiled by an older compiler is detectable rather than silently trusted.
 * qce1.1.0: literal unit polymorphism in +/-, and #formula_key composition. */
export const COMPILER_VERSION = 'qce1.1.0';

/** How many `#ref` hops deep a formula may compose (task QCE1.1) — a chain of
 * formulas each referencing the next, six deep, is refused even if every one of
 * them individually is small. */
export const MAX_COMPOSITION_DEPTH = 5;

export type ValueKind = 'scalar' | 'series';

/** A node in the compiled plan. Every node carries its inferred kind and unit,
 * rendered to the same textual form `display_unit` uses, so the stored plan is
 * self-describing without a second lookup against the registry. */
export type PlanNode =
  | { type: 'const'; kind: 'scalar'; unit: string; value: number }
  | { type: 'signal'; kind: 'series'; unit: string; name: string }
  | { type: 'param'; kind: 'scalar'; unit: string; name: string }
  | { type: 'formula_ref'; kind: ValueKind; unit: string; formulaKey: string }
  | { type: 'unary'; kind: ValueKind; unit: string; op: '-'; operand: PlanNode }
  | { type: 'binary'; kind: ValueKind; unit: string; op: '+' | '-' | '*' | '/'; left: PlanNode; right: PlanNode }
  | { type: 'call'; kind: 'scalar'; unit: string; name: string; args: PlanNode[] };

export interface DeclaredSignal {
  signal: string;
  unit: string | null;
}

/** One formula belonging to the same class+version as its siblings — the unit a
 * `#ref` resolves against (task QCE1.1). Nothing cross-class, nothing
 * cross-version: a caller assembles this list from formulas it already knows share
 * scope, the compiler never widens it on its own. */
export interface FormulaInput {
  formulaKey: string;
  expression: string;
  /** Omit at import dry-run, where no column declares these yet; supply at publish,
   * where `equipment_class_formula.result_kind` / `display_unit` do. */
  declaredResultKind?: ValueKind;
  declaredDisplayUnit?: string | null;
}

export interface CompiledFormula {
  plan: PlanNode;
  resultKind: ValueKind;
  resultUnit: string;
  /** Derived by walking the plan — never author-supplied. The transitive closure:
   * a composed formula requires everything its `#ref`s require, too. */
  requiredSignals: string[];
  /** Derived from `@name` references — what QPARAM1 reads. Transitive, same reason. */
  requiredParameters: string[];
  /** Derived from `#key` references — every formula anywhere in this one's
   * dependency subtree, not just the ones it names directly. */
  requiredFormulas: string[];
  compilerVersion: string;
}

export type ClassFormulaResult =
  | { status: 'ok'; compiled: CompiledFormula }
  | { status: 'error'; error: FormulaCompileError };

export interface CompileClassFormulasInput {
  classSlug: string;
  expectedSignals: DeclaredSignal[];
  formulas: FormulaInput[];
}

export interface CompileFormulaInput {
  /** Named in every refusal message, so a publish blocking on several formulas can
   * say which ones. */
  formulaKey: string;
  expression: string;
  classSlug: string;
  expectedSignals: DeclaredSignal[];
  declaredResultKind?: ValueKind;
  declaredDisplayUnit?: string | null;
  /** Other formulas in the same class+version, for `#ref` resolution. Omit if this
   * formula has none — a `#ref` with no siblings supplied is refused as unknown,
   * same as a `#ref` to a key genuinely absent from the class. */
  siblingFormulas?: FormulaInput[];
}

/** What a `#ref` resolves against once its target has already compiled — enough to
 * reuse its kind/unit and fold its transitive requirements in without re-inferring
 * or re-walking its whole subtree. */
interface ResolvedSibling {
  kind: ValueKind;
  unit: string;
  requiredSignals: string[];
  requiredParameters: string[];
  requiredFormulas: string[];
  expandedNodes: number;
  expandedDepth: number;
  compositionDepth: number;
}

interface InferContext {
  formulaKey: string;
  classSlug: string;
  signalUnits: Map<string, Unit | null>;
  byKey: Map<string, FormulaInput>;
  resolved: Map<string, ResolvedSibling>;
  results: Map<string, ClassFormulaResult>;
}

/**
 * Compiles every formula in a class+version together (task QCE1.1), so `#key`
 * references resolve within the set rather than one at a time. Returns a result
 * (ok or refused) for every formula passed in, including ones that only fail
 * because something they reference failed first — a caller that wants just one
 * formula's outcome reads it out of the map instead of getting a thrown error.
 */
export function compileClassFormulas(input: CompileClassFormulasInput): Map<string, ClassFormulaResult> {
  const { classSlug, expectedSignals, formulas } = input;
  const byKey = new Map(formulas.map((f) => [f.formulaKey, f]));
  const results = new Map<string, ClassFormulaResult>();

  const signalUnits = new Map<string, Unit | null>();
  for (const s of expectedSignals) {
    signalUnits.set(s.signal, s.unit && s.unit.trim() ? parseUnitString(s.unit) : null);
  }

  // 1. Parse every formula up front. A parse failure is that formula's own error,
  // and cannot be resolved as anyone's dependency — a reference to it later
  // surfaces as "depends on a formula which failed to compile", not a second parse
  // attempt.
  const parsed = new Map<string, RawNode>();
  for (const f of formulas) {
    try {
      parsed.set(f.formulaKey, withFormula(f.formulaKey, () => parseExpression(f.expression)));
    } catch (err) {
      results.set(f.formulaKey, { status: 'error', error: toCompileError(err, f.formulaKey) });
    }
  }

  // 2. Direct #ref dependencies, from whatever parsed.
  const directRefs = new Map<string, Set<string>>();
  for (const [key, raw] of parsed) {
    directRefs.set(key, collectFormulaRefs(raw));
  }

  // 3. Cycle detection by DFS colour-marking. Everything in a cycle gets its own
  // refusal naming the cycle, and is excluded from the topological order below —
  // there is no valid compile order for a cycle, so it is not merely "compiled
  // last".
  const color = new Map<string, 'white' | 'gray' | 'black'>();
  for (const key of parsed.keys()) color.set(key, 'white');
  const cyclic = new Set<string>();
  const stack: string[] = [];

  const visit = (key: string): void => {
    const state = color.get(key);
    if (state === undefined || state === 'black') return;
    if (state === 'gray') {
      const start = stack.indexOf(key);
      const cyclePath = [...stack.slice(start), key];
      for (const k of cyclePath) {
        cyclic.add(k);
        if (!results.has(k)) {
          results.set(k, {
            status: 'error',
            error: new FormulaCompileError(
              `formula "${k}": participates in a dependency cycle (${cyclePath.join(' -> ')}).`,
            ),
          });
        }
      }
      return;
    }
    color.set(key, 'gray');
    stack.push(key);
    for (const dep of directRefs.get(key) ?? []) {
      if (parsed.has(dep)) visit(dep);
    }
    stack.pop();
    color.set(key, 'black');
  };
  for (const key of parsed.keys()) visit(key);

  // 4. Topological order over everything parsed, non-cyclic, and not already
  // errored.
  const remaining = [...parsed.keys()].filter((k) => !cyclic.has(k) && !results.has(k));
  const order = topoSort(remaining, directRefs);

  // 5. Compile in dependency order, threading resolved siblings forward.
  const resolved = new Map<string, ResolvedSibling>();
  for (const key of order) {
    if (results.has(key)) continue;
    const f = byKey.get(key)!;
    const raw = parsed.get(key)!;
    try {
      const ctx: InferContext = { formulaKey: key, classSlug, signalUnits, byKey, resolved, results };
      const compiled = compileOne(f, raw, ctx);
      resolved.set(key, {
        kind: compiled.resultKind,
        unit: compiled.resultUnit,
        requiredSignals: compiled.requiredSignals,
        requiredParameters: compiled.requiredParameters,
        requiredFormulas: compiled.requiredFormulas,
        expandedNodes: (compiled as InternalCompiled).expandedNodes,
        expandedDepth: (compiled as InternalCompiled).expandedDepth,
        compositionDepth: (compiled as InternalCompiled).compositionDepth,
      });
      results.set(key, { status: 'ok', compiled });
    } catch (err) {
      results.set(key, { status: 'error', error: toCompileError(err, key) });
    }
  }

  return results;
}

/**
 * Compiles a single formula. A thin wrapper over `compileClassFormulas`: it
 * assembles a one-plus-siblings set, compiles the set, and returns (or throws)
 * this formula's own outcome. Existing callers that never use `#ref` are
 * unaffected — `siblingFormulas` defaults to none, and a bare `#ref` with no
 * siblings supplied is refused as unknown, same as a genuinely absent key.
 */
export function compileFormula(input: CompileFormulaInput): CompiledFormula {
  const siblings = (input.siblingFormulas ?? []).filter((f) => f.formulaKey !== input.formulaKey);
  const results = compileClassFormulas({
    classSlug: input.classSlug,
    expectedSignals: input.expectedSignals,
    formulas: [
      ...siblings,
      {
        formulaKey: input.formulaKey,
        expression: input.expression,
        declaredResultKind: input.declaredResultKind,
        declaredDisplayUnit: input.declaredDisplayUnit,
      },
    ],
  });
  const result = results.get(input.formulaKey)!;
  if (result.status === 'error') throw result.error;
  return result.compiled;
}

/** The bookkeeping `compileClassFormulas` needs internally (expanded node/depth
 * counts, composition depth) but that has no place in the public `CompiledFormula`
 * shape — those are a property of position in the dependency graph, not of the
 * formula in isolation. */
interface InternalCompiled extends CompiledFormula {
  expandedNodes: number;
  expandedDepth: number;
  compositionDepth: number;
}

function compileOne(f: FormulaInput, raw: RawNode, ctx: InferContext): InternalCompiled {
  return withFormula(f.formulaKey, () => {
    const plan = infer(raw, ctx);

    if (f.declaredResultKind && f.declaredResultKind !== plan.kind) {
      throw new FormulaCompileError(
        `formula "${f.formulaKey}": declared result_kind "${f.declaredResultKind}" `
          + `does not match the inferred kind "${plan.kind}".`,
      );
    }

    if (f.declaredDisplayUnit && f.declaredDisplayUnit.trim()) {
      const inferredUnit = parseUnitStringFromRendered(plan.unit);
      const declaredUnit = parseUnitString(f.declaredDisplayUnit);
      if (!unitsEqual(inferredUnit, declaredUnit)) {
        throw new FormulaCompileError(
          `formula "${f.formulaKey}": declared display_unit "${f.declaredDisplayUnit}" `
            + `does not match the inferred unit "${plan.unit}".`,
        );
      }
    }

    const expansion = computeExpansion(plan, ctx.resolved);
    if (expansion.nodes > MAX_NODES) {
      throw new FormulaCompileError(
        `formula "${f.formulaKey}": expands to more than ${MAX_NODES} nodes once its `
          + `#referenced formulas are inlined.`,
      );
    }
    if (expansion.depth > MAX_DEPTH) {
      throw new FormulaCompileError(
        `formula "${f.formulaKey}": expands to more than depth ${MAX_DEPTH} once its `
          + `#referenced formulas are inlined.`,
      );
    }

    const compositionDepth = computeCompositionDepth(plan, ctx.resolved);
    if (compositionDepth > MAX_COMPOSITION_DEPTH) {
      throw new FormulaCompileError(
        `formula "${f.formulaKey}": composes formulas ${compositionDepth} levels deep; `
          + `the limit is ${MAX_COMPOSITION_DEPTH}.`,
      );
    }

    const required = collectRequired(plan, ctx.resolved);
    const canonicalPlan = canonicalise(plan) as PlanNode;

    return {
      plan: canonicalPlan,
      resultKind: plan.kind,
      resultUnit: plan.unit,
      requiredSignals: [...required.signals].sort(),
      requiredParameters: [...required.parameters].sort(),
      requiredFormulas: [...required.formulas].sort(),
      compilerVersion: COMPILER_VERSION,
      expandedNodes: expansion.nodes,
      expandedDepth: expansion.depth,
      compositionDepth,
    };
  });
}

function withFormula<T>(formulaKey: string, fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof FormulaCompileError && !err.message.startsWith(`formula "${formulaKey}"`)) {
      throw new FormulaCompileError(`formula "${formulaKey}": ${err.message}`);
    }
    throw err;
  }
}

function toCompileError(err: unknown, formulaKey: string): FormulaCompileError {
  if (err instanceof FormulaCompileError) return err;
  return new FormulaCompileError(`formula "${formulaKey}": ${err instanceof Error ? err.message : String(err)}`);
}

function collectFormulaRefs(node: RawNode): Set<string> {
  const out = new Set<string>();
  const walk = (n: RawNode): void => {
    if (n.type === 'formula_ref') out.add(n.name);
    else if (n.type === 'unary') walk(n.operand);
    else if (n.type === 'binary') { walk(n.left); walk(n.right); }
    else if (n.type === 'call') n.args.forEach(walk);
  };
  walk(node);
  return out;
}

/** Kahn's algorithm restricted to `keys`; edges leaving that set (to a cyclic,
 * errored, or missing formula) are ignored here — those surface as their own
 * refusal when `infer` actually tries to resolve the reference. */
function topoSort(keys: string[], directRefs: Map<string, Set<string>>): string[] {
  const keySet = new Set(keys);
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const k of keys) inDegree.set(k, 0);
  for (const k of keys) {
    for (const dep of directRefs.get(k) ?? []) {
      if (!keySet.has(dep)) continue;
      inDegree.set(k, (inDegree.get(k) ?? 0) + 1);
      const list = dependents.get(dep) ?? [];
      list.push(k);
      dependents.set(dep, list);
    }
  }
  const queue = keys.filter((k) => (inDegree.get(k) ?? 0) === 0).sort();
  const order: string[] = [];
  while (queue.length) {
    const k = queue.shift()!;
    order.push(k);
    for (const dependent of (dependents.get(k) ?? []).slice().sort()) {
      inDegree.set(dependent, (inDegree.get(dependent) ?? 0) - 1);
      if (inDegree.get(dependent) === 0) queue.push(dependent);
    }
  }
  for (const k of keys) if (!order.includes(k)) order.push(k);
  return order;
}

/** A raw AST node this narrow: only a bare numeral (or a chain of unary minuses over
 * one) counts as "a numeric literal" for +/- unit polymorphism — a computed
 * sub-expression that happens to evaluate to a constant (`105 + 3`) does not. The
 * grammar's own `number` production is the line; nothing does constant-folding to
 * find more of them. */
function isLiteral(node: PlanNode): boolean {
  if (node.type === 'const') return true;
  if (node.type === 'unary' && node.op === '-') return isLiteral(node.operand);
  return false;
}

function infer(node: RawNode, ctx: InferContext): PlanNode {
  switch (node.type) {
    case 'number':
      return { type: 'const', kind: 'scalar', unit: renderUnit(DIMENSIONLESS), value: node.value };

    case 'param':
      return { type: 'param', kind: 'scalar', unit: renderUnit(DIMENSIONLESS), name: node.name };

    case 'formula_ref': {
      if (!ctx.byKey.has(node.name)) {
        throw new FormulaCompileError(
          `references formula "#${node.name}", which does not exist in class "${ctx.classSlug}".`,
        );
      }
      const sib = ctx.resolved.get(node.name);
      if (!sib) {
        const failure = ctx.results.get(node.name);
        const reason = failure?.status === 'error' ? failure.error.message : 'it failed to compile.';
        throw new FormulaCompileError(
          `references formula "#${node.name}", which failed to compile: ${reason}`,
        );
      }
      return { type: 'formula_ref', kind: sib.kind, unit: sib.unit, formulaKey: node.name };
    }

    case 'signal': {
      if (!ctx.signalUnits.has(node.name)) {
        throw new FormulaCompileError(
          `references "${node.name}", which is not one of class "${ctx.classSlug}"'s expected_signals.`,
        );
      }
      const unit = ctx.signalUnits.get(node.name);
      if (unit === null || unit === undefined) {
        throw new FormulaCompileError(
          `references "${node.name}", whose canonical unit cannot be resolved.`,
        );
      }
      return { type: 'signal', kind: 'series', unit: renderUnit(unit), name: node.name };
    }

    case 'unary': {
      const operand = infer(node.operand, ctx);
      return { type: 'unary', kind: operand.kind, unit: operand.unit, op: '-', operand };
    }

    case 'binary': {
      const left = infer(node.left, ctx);
      const right = infer(node.right, ctx);
      const kind: ValueKind = left.kind === 'series' || right.kind === 'series' ? 'series' : 'scalar';

      if (node.op === '+' || node.op === '-') {
        const leftLiteral = isLiteral(left);
        const rightLiteral = isLiteral(right);
        let unit: string;
        if (leftLiteral && rightLiteral) {
          unit = renderUnit(DIMENSIONLESS);
        } else if (leftLiteral) {
          unit = right.unit;
        } else if (rightLiteral) {
          unit = left.unit;
        } else {
          const leftUnit = parseUnitStringFromRendered(left.unit);
          const rightUnit = parseUnitStringFromRendered(right.unit);
          if (!unitsEqual(leftUnit, rightUnit)) {
            throw new FormulaCompileError(
              `"${node.op}" combines "${left.unit}" and "${right.unit}", which are different units.`,
            );
          }
          unit = left.unit;
        }
        return { type: 'binary', kind, unit, op: node.op, left, right };
      }

      if (node.op === '/' && right.type === 'const' && right.value === 0) {
        throw new FormulaCompileError('divides by the literal 0.');
      }

      const leftUnit = parseUnitStringFromRendered(left.unit);
      const rightUnit = parseUnitStringFromRendered(right.unit);
      const unit = node.op === '*' ? multiplyUnits(leftUnit, rightUnit) : divideUnits(leftUnit, rightUnit);
      return { type: 'binary', kind, unit: renderUnit(unit), op: node.op, left, right };
    }

    case 'call': {
      const entry = lookupOperator(node.name);
      if (!entry) {
        throw new FormulaCompileError(`calls unknown function "${node.name}".`);
      }
      if (node.args.length !== entry.argKinds.length) {
        throw new FormulaCompileError(
          `calls "${node.name}" with ${node.args.length} argument(s); it takes ${entry.argKinds.length}.`,
        );
      }
      const args = node.args.map((a) => infer(a, ctx));
      args.forEach((a, i) => {
        const expected = entry.argKinds[i];
        if (a.kind !== expected) {
          throw new FormulaCompileError(
            `calls "${node.name}" with argument ${i + 1} as ${a.kind}; it takes ${expected}.`,
          );
        }
      });

      if (node.name === 'fraction_within') {
        const seriesUnit = parseUnitStringFromRendered(args[0].unit);
        const [lo, hi] = [args[1], args[2]];
        const loOk = isLiteral(lo) || unitsEqual(parseUnitStringFromRendered(lo.unit), seriesUnit);
        const hiOk = isLiteral(hi) || unitsEqual(parseUnitStringFromRendered(hi.unit), seriesUnit);
        if (!loOk || !hiOk) {
          throw new FormulaCompileError(
            `calls "fraction_within" with bounds ("${lo.unit}", "${hi.unit}") that do not `
              + `carry the series' unit ("${args[0].unit}").`,
          );
        }
      }

      const argUnits = args.map((a) => parseUnitStringFromRendered(a.unit));
      const unit = entry.unitRule(argUnits);
      return { type: 'call', kind: entry.resultKind, unit: renderUnit(unit), name: node.name, args };
    }

    default: {
      const exhaustive: never = node;
      throw new FormulaCompileError(`unrecognised node: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/** `PlanNode.unit` is already a rendered string (so the stored plan needs no second
 * lookup) — re-parsed here purely for the algebra, never for display.
 * `parseUnitString` already recognises the literal "dimensionless" `renderUnit`
 * produces. */
function parseUnitStringFromRendered(rendered: string): Unit {
  return parseUnitString(rendered);
}

function collectRequired(
  node: PlanNode,
  resolved: Map<string, ResolvedSibling>,
): { signals: Set<string>; parameters: Set<string>; formulas: Set<string> } {
  const signals = new Set<string>();
  const parameters = new Set<string>();
  const formulas = new Set<string>();
  const walk = (n: PlanNode): void => {
    if (n.type === 'signal') signals.add(n.name);
    else if (n.type === 'param') parameters.add(n.name);
    else if (n.type === 'formula_ref') {
      formulas.add(n.formulaKey);
      const sib = resolved.get(n.formulaKey);
      if (sib) {
        sib.requiredSignals.forEach((s) => signals.add(s));
        sib.requiredParameters.forEach((p) => parameters.add(p));
        sib.requiredFormulas.forEach((k) => formulas.add(k));
      }
    } else if (n.type === 'unary') walk(n.operand);
    else if (n.type === 'binary') { walk(n.left); walk(n.right); }
    else if (n.type === 'call') n.args.forEach(walk);
  };
  walk(node);
  return { signals, parameters, formulas };
}

/** Node/depth counts as they would be if every `#ref` were inlined in place,
 * recursively — the caps (`MAX_NODES`/`MAX_DEPTH`) are applied to this, not to the
 * written expression's own size, so five small formulas chained through `#ref`
 * cannot add up to a node-count bomb the parser's own per-formula limit never saw. */
function computeExpansion(node: PlanNode, resolved: Map<string, ResolvedSibling>): { nodes: number; depth: number } {
  switch (node.type) {
    case 'formula_ref': {
      const sib = resolved.get(node.formulaKey)!;
      return { nodes: 1 + sib.expandedNodes, depth: 1 + sib.expandedDepth };
    }
    case 'const':
    case 'signal':
    case 'param':
      return { nodes: 1, depth: 1 };
    case 'unary': {
      const c = computeExpansion(node.operand, resolved);
      return { nodes: 1 + c.nodes, depth: 1 + c.depth };
    }
    case 'binary': {
      const l = computeExpansion(node.left, resolved);
      const r = computeExpansion(node.right, resolved);
      return { nodes: 1 + l.nodes + r.nodes, depth: 1 + Math.max(l.depth, r.depth) };
    }
    case 'call': {
      const cs = node.args.map((a) => computeExpansion(a, resolved));
      return { nodes: 1 + cs.reduce((sum, c) => sum + c.nodes, 0), depth: 1 + Math.max(0, ...cs.map((c) => c.depth)) };
    }
    default: {
      const exhaustive: never = node;
      throw new FormulaCompileError(`unrecognised node: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/** How many `#ref` hops deep this formula's dependency tree goes — distinct from
 * expanded node/depth, which measure size; this measures composition chain length
 * on its own, so a long chain of tiny formulas is caught even if it never gets
 * near the node/depth caps. */
function computeCompositionDepth(node: PlanNode, resolved: Map<string, ResolvedSibling>): number {
  switch (node.type) {
    case 'formula_ref': {
      const sib = resolved.get(node.formulaKey)!;
      return 1 + sib.compositionDepth;
    }
    case 'const':
    case 'signal':
    case 'param':
      return 0;
    case 'unary':
      return computeCompositionDepth(node.operand, resolved);
    case 'binary':
      return Math.max(computeCompositionDepth(node.left, resolved), computeCompositionDepth(node.right, resolved));
    case 'call':
      return Math.max(0, ...node.args.map((a) => computeCompositionDepth(a, resolved)));
    default: {
      const exhaustive: never = node;
      throw new FormulaCompileError(`unrecognised node: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/** Sorts object keys recursively — an explicit, independent guarantee of canonical
 * key order, not merely a hope that every node literal above stays consistent. */
function canonicalise(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalise);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonicalise((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/** `MAX_NODES` / `MAX_DEPTH`, re-exported so callers (and tests) name one source. */
export { MAX_DEPTH, MAX_NODES };
