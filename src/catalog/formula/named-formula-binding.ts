import { parseUnitString, unitsEqual } from './units';

/** One role a named formula declares, written against — never a signal name directly
 * (task QCE3). `dimension` is a unit string in exactly the vocabulary `units.ts`
 * already parses (`degC`, `kPa`, `L/h`...) — there is no separate dimension taxonomy
 * in this system, and inventing one would duplicate what `parseUnitString` already
 * does. A role's "dimension" and a signal's "unit" are the same kind of value; the
 * name differs only to say which side of the binding it is declaring. */
export interface RoleInput {
  role: string;
  dimension: string;
  description?: string;
  /** Optional, and a warning rather than a constraint (§4) — the list of
   * `sensor_role_capability.parameter_key` values this role expects its bound
   * signal to measure. Catches "right unit, wrong physical quantity" (coolant vs.
   * oil temperature, both `degC`), which dimensional checking cannot. */
  expectedParameters?: string[];
}

export interface BindingPair { role: string; signal: string; }

export type FormulaMode = 'expression' | 'bind';

export type BindingErrorCode =
  | 'formula_mode_conflict' | 'formula_mode_missing'
  | 'unknown_role' | 'unbound_role' | 'named_formula_not_found';

export class BindingError extends Error {
  constructor(public readonly code: BindingErrorCode, message: string) {
    super(message);
  }
}

/** Two modes, mutually exclusive, per row (§3). Decided from the raw cell text, not
 * from anything already parsed — the same two cells a workbook author filled in. */
export function formulaMode(cells: { expression: string; namedFormula: string }): FormulaMode {
  const hasExpression = cells.expression.trim() !== '';
  const hasBind = cells.namedFormula.trim() !== '';
  if (hasExpression && hasBind) {
    throw new BindingError(
      'formula_mode_conflict', 'names both "expression" and "named_formula"; a row is one or the other.',
    );
  }
  if (!hasExpression && !hasBind) {
    throw new BindingError(
      'formula_mode_missing', 'names neither "expression" nor "named_formula"; a formula row must be one.',
    );
  }
  return hasBind ? 'bind' : 'expression';
}

/** `role=signal` pairs, semicolon-separated (§3): `fuel_rate=fuel_consumption; power_output=engine_power`.
 * Blank segments (a trailing semicolon, repeated whitespace) are ignored rather than
 * refused — the shape of the list matters, not incidental formatting. */
export function parseBindings(raw: string): BindingPair[] {
  return raw.split(';')
    .map((segment) => segment.trim())
    .filter(Boolean)
    .map((segment) => {
      const [role, signal] = segment.split('=').map((s) => s.trim());
      return { role: role ?? '', signal: signal ?? '' };
    });
}

/** Every role the named formula declares must be bound exactly once, and nothing
 * else — the two remaining structural codes §3 names. Checked together because a
 * role present in both sets is impossible to produce from a correct bindings list;
 * each list-membership failure has exactly one way to happen. */
export function checkRolesBound(roles: RoleInput[], bindings: BindingPair[]): void {
  const declared = new Set(roles.map((r) => r.role));
  const bound = new Set(bindings.map((b) => b.role));

  const unknown = bindings.map((b) => b.role).filter((role) => !declared.has(role));
  if (unknown.length) {
    throw new BindingError(
      'unknown_role',
      `names role(s) ${[...new Set(unknown)].join(', ')} this named formula does not declare.`,
    );
  }

  const unbound = [...declared].filter((role) => !bound.has(role));
  if (unbound.length) {
    throw new BindingError('unbound_role', `does not bind declared role(s): ${unbound.join(', ')}.`);
  }
}

/** Substitutes every bare role identifier in a named formula's expression with its
 * bound signal name, so the result compiles through the ordinary expression path
 * unchanged (§5) — the same compiler, the same checks, nothing downstream aware a
 * binding ever happened. Guards `@param` and `#formula_ref` identifiers with a
 * negative lookbehind so a role name that happens to collide with a parameter or
 * formula-key spelling is never rewritten — those sigils mean something else
 * entirely and are never role references. Does not guard against a role name
 * colliding with an operator name (`avg`, `rate`...); none of the seeded formulas'
 * roles do, and the operator vocabulary is closed and small enough to check by eye. */
export function substituteExpression(expression: string, bindings: BindingPair[]): string {
  const bySignal = new Map(bindings.map((b) => [b.role, b.signal]));
  return expression.replace(/(?<![@#])\b[A-Za-z_][A-Za-z0-9_]*\b/g, (ident) => bySignal.get(ident) ?? ident);
}

export interface DimensionMismatch {
  role: string;
  signal: string;
  expectedDimension: string;
  actualUnit: string;
}

/** §4: the bound signal's unit must be dimensionally compatible with the role's
 * declared dimension. "Compatible" here means the same thing `units.ts` already
 * means by equal — this system does no unit conversion anywhere, so compatible and
 * identical are the same question asked in binding's vocabulary instead of a
 * formula's. Stated once, deliberately: this catches a pressure bound where a
 * temperature belongs. It cannot catch a wrong signal of the right dimension —
 * coolant temperature and oil temperature are both `degC`, and nothing here can
 * tell them apart. That is what `expectedParameters` below exists for. */
export function checkDimensions(
  roles: RoleInput[], bindings: BindingPair[], signalUnits: Map<string, string | null>,
): DimensionMismatch[] {
  const bindingBySignalRole = new Map(bindings.map((b) => [b.role, b.signal]));
  const mismatches: DimensionMismatch[] = [];
  for (const role of roles) {
    const signal = bindingBySignalRole.get(role.role);
    if (!signal) continue; // already refused by checkRolesBound; nothing further to say here
    const actualUnit = signalUnits.get(signal) ?? null;
    const expected = parseUnitString(role.dimension);
    const actual = parseUnitString(actualUnit);
    if (!unitsEqual(expected, actual)) {
      mismatches.push({ role: role.role, signal, expectedDimension: role.dimension, actualUnit: actualUnit ?? '(no unit)' });
    }
  }
  return mismatches;
}

export interface SuspiciousBinding {
  role: string;
  signal: string;
  boundParameterKeys: string[];
  expectedParameters: string[];
}

/** §4: a role that declares `expectedParameters` and binds a signal whose catalogued
 * capability measures something else, by `parameter_key`. Absence is not evidence
 * (the same reasoning D21 applies to a tenant's missing history): a signal nobody
 * has registered a `sensor_role_capability` for is not flagged, because there is
 * nothing to be suspicious of yet — only a capability that actively disagrees does. */
export function checkSuspiciousBindings(
  roles: RoleInput[], bindings: BindingPair[], parameterKeysBySignal: Map<string, string[]>,
): SuspiciousBinding[] {
  const bindingBySignalRole = new Map(bindings.map((b) => [b.role, b.signal]));
  const suspicious: SuspiciousBinding[] = [];
  for (const role of roles) {
    if (!role.expectedParameters?.length) continue;
    const signal = bindingBySignalRole.get(role.role);
    if (!signal) continue;
    const keys = parameterKeysBySignal.get(signal) ?? [];
    if (!keys.length) continue; // no capability registered — nothing to be suspicious of
    const disagrees = keys.every((k) => !role.expectedParameters!.includes(k));
    if (disagrees) {
      suspicious.push({
        role: role.role, signal, boundParameterKeys: keys, expectedParameters: role.expectedParameters,
      });
    }
  }
  return suspicious;
}
