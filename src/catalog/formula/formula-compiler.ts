import { FormulaCompileError } from './errors';
import { lookupOperator } from './operator-registry';
import { MAX_DEPTH, MAX_NODES, parseExpression, RawNode } from './parser';
import { divideUnits, multiplyUnits, parseUnitString, renderUnit, Unit, unitsEqual, DIMENSIONLESS } from './units';

export { FormulaCompileError } from './errors';

/** Bumped whenever the emitted plan shape or the operator registry changes, so a
 * plan compiled by an older compiler is detectable rather than silently trusted. */
export const COMPILER_VERSION = 'qce1.0.0';

export type ValueKind = 'scalar' | 'series';

/** A node in the compiled plan. Every node carries its inferred kind and unit,
 * rendered to the same textual form `display_unit` uses, so the stored plan is
 * self-describing without a second lookup against the registry. */
export type PlanNode =
  | { type: 'const'; kind: 'scalar'; unit: string; value: number }
  | { type: 'signal'; kind: 'series'; unit: string; name: string }
  | { type: 'param'; kind: 'scalar'; unit: string; name: string }
  | { type: 'unary'; kind: ValueKind; unit: string; op: '-'; operand: PlanNode }
  | { type: 'binary'; kind: ValueKind; unit: string; op: '+' | '-' | '*' | '/'; left: PlanNode; right: PlanNode }
  | { type: 'call'; kind: 'scalar'; unit: string; name: string; args: PlanNode[] };

export interface DeclaredSignal {
  signal: string;
  unit: string | null;
}

export interface CompileFormulaInput {
  /** Named in every refusal message, so a publish blocking on several formulas can
   * say which ones. */
  formulaKey: string;
  expression: string;
  classSlug: string;
  expectedSignals: DeclaredSignal[];
  /** Omit at import dry-run, where no column declares these yet; supply at publish,
   * where `equipment_class_formula.result_kind` / `display_unit` do. */
  declaredResultKind?: ValueKind;
  declaredDisplayUnit?: string | null;
}

export interface CompiledFormula {
  plan: PlanNode;
  resultKind: ValueKind;
  resultUnit: string;
  /** Derived by walking the plan — never author-supplied. */
  requiredSignals: string[];
  /** Derived from `@name` references — what QPARAM1 reads. */
  requiredParameters: string[];
  compilerVersion: string;
}

interface InferContext {
  formulaKey: string;
  classSlug: string;
  signalUnits: Map<string, Unit | null>;
}

/**
 * Turns a formula expression into a compiled plan, or refuses it (task QCE1).
 * Deterministic: the same expression, against the same declared signals, produces
 * byte-identical output every time — every node is built with the same fixed key
 * order, and `canonicalise` sorts keys again as a second, independent guarantee of
 * it, not merely a hope that construction order never drifts.
 */
export function compileFormula(input: CompileFormulaInput): CompiledFormula {
  const raw = withFormula(input.formulaKey, () => parseExpression(input.expression));

  const signalUnits = new Map<string, Unit | null>();
  for (const s of input.expectedSignals) {
    signalUnits.set(s.signal, s.unit && s.unit.trim() ? parseUnitString(s.unit) : null);
  }
  const ctx: InferContext = { formulaKey: input.formulaKey, classSlug: input.classSlug, signalUnits };

  const plan = withFormula(input.formulaKey, () => infer(raw, ctx));

  if (input.declaredResultKind && input.declaredResultKind !== plan.kind) {
    throw new FormulaCompileError(
      `formula "${input.formulaKey}": declared result_kind "${input.declaredResultKind}" `
        + `does not match the inferred kind "${plan.kind}".`,
    );
  }

  const inferredUnit = parseUnitStringFromRendered(plan.unit);
  if (input.declaredDisplayUnit && input.declaredDisplayUnit.trim()) {
    const declaredUnit = parseUnitString(input.declaredDisplayUnit);
    if (!unitsEqual(inferredUnit, declaredUnit)) {
      throw new FormulaCompileError(
        `formula "${input.formulaKey}": declared display_unit "${input.declaredDisplayUnit}" `
          + `does not match the inferred unit "${plan.unit}".`,
      );
    }
  }

  const required = collectRequired(plan);
  const canonicalPlan = canonicalise(plan) as PlanNode;

  return {
    plan: canonicalPlan,
    resultKind: plan.kind,
    resultUnit: plan.unit,
    requiredSignals: [...required.signals].sort(),
    requiredParameters: [...required.parameters].sort(),
    compilerVersion: COMPILER_VERSION,
  };
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

function infer(node: RawNode, ctx: InferContext): PlanNode {
  switch (node.type) {
    case 'number':
      return { type: 'const', kind: 'scalar', unit: renderUnit(DIMENSIONLESS), value: node.value };

    case 'param':
      return { type: 'param', kind: 'scalar', unit: renderUnit(DIMENSIONLESS), name: node.name };

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
      const leftUnit = parseUnitStringFromRendered(left.unit);
      const rightUnit = parseUnitStringFromRendered(right.unit);

      if (node.op === '+' || node.op === '-') {
        if (!unitsEqual(leftUnit, rightUnit)) {
          throw new FormulaCompileError(
            `"${node.op}" combines "${left.unit}" and "${right.unit}", which are different units.`,
          );
        }
        return { type: 'binary', kind, unit: left.unit, op: node.op, left, right };
      }

      if (node.op === '/' && right.type === 'const' && right.value === 0) {
        throw new FormulaCompileError('divides by the literal 0.');
      }

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
        const loUnit = parseUnitStringFromRendered(args[1].unit);
        const hiUnit = parseUnitStringFromRendered(args[2].unit);
        if (!unitsEqual(seriesUnit, loUnit) || !unitsEqual(seriesUnit, hiUnit)) {
          throw new FormulaCompileError(
            `calls "fraction_within" with bounds ("${args[1].unit}", "${args[2].unit}") that do not `
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

function collectRequired(node: PlanNode): { signals: Set<string>; parameters: Set<string> } {
  const signals = new Set<string>();
  const parameters = new Set<string>();
  const walk = (n: PlanNode): void => {
    if (n.type === 'signal') signals.add(n.name);
    else if (n.type === 'param') parameters.add(n.name);
    else if (n.type === 'unary') walk(n.operand);
    else if (n.type === 'binary') { walk(n.left); walk(n.right); }
    else if (n.type === 'call') n.args.forEach(walk);
  };
  walk(node);
  return { signals, parameters };
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
