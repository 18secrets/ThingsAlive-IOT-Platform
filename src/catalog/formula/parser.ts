import { FormulaCompileError } from './errors';

export type RawNode =
  | { type: 'number'; value: number; pos: number }
  | { type: 'duration'; hours: number; pos: number }
  | { type: 'signal'; name: string; pos: number }
  | { type: 'param'; name: string; pos: number }
  | { type: 'formula_ref'; name: string; pos: number }
  | { type: 'unary'; op: '-'; operand: RawNode; pos: number }
  | { type: 'binary'; op: '+' | '-' | '*' | '/'; left: RawNode; right: RawNode; pos: number }
  | { type: 'compare'; op: CompareOp; left: RawNode; right: RawNode; pos: number }
  | { type: 'call'; name: string; args: RawNode[]; pos: number };

/** Ordering only (task QCE5). No `==`/`!=`: equality between two continuous
 * measurements is a coincidence, and state codes are categorical signals (QCAT1). */
export type CompareOp = '>' | '>=' | '<' | '<=';
const COMPARE_OPS: readonly string[] = ['>', '>=', '<', '<='];

/** A guard on an untrusted input path (task QCE1): formulas arrive from uploaded
 * spreadsheets, and a parser with no limit on its own output size is a denial of
 * service waiting for a sufficiently nested cell. */
export const MAX_NODES = 200;
export const MAX_DEPTH = 20;

type TokenType =
  | 'number' | 'duration' | 'ident' | 'param' | 'formularef'
  | '+' | '-' | '*' | '/' | '>' | '>=' | '<' | '<=' | '(' | ')' | ',' | 'eof';
interface Token { type: TokenType; text: string; pos: number }

/**
 * A hand-written recursive-descent parser for the small expression grammar (task
 * QCE1) — deliberately not a dependency. Formulas arrive from uploaded
 * spreadsheets, an untrusted input path, and a third-party parser is supply-chain
 * surface plus loss of control over refusal messages.
 *
 *   comparison  := expression [ ('>' | '>=' | '<' | '<=') expression ]   -- task QCE5;
 *                  non-associative: `a < b < c` is refused, since it reads as a range
 *   expression  := term (('+' | '-') term)*
 *   term        := factor (('*' | '/') factor)*
 *   factor      := '-' factor | primary
 *   primary     := number | duration | call | signal | param | formula_ref | '(' comparison ')'
 *   call        := identifier '(' [ comparison (',' comparison)* ] ')'
 *   signal      := identifier
 *   param       := '@' identifier
 *   formula_ref := '#' identifier
 *   number      := digits [ '.' digits ]
 *   duration    := digits [ '.' digits ] ( 'd' | 'h' )   -- e.g. 90d, 24h (task QCE4);
 *                  spelled like `equipment_class_formula.aggregation_window`'s tokens
 *                  (`24h`, `7d`, `30d`), the only other "window" vocabulary in the
 *                  codebase, but this is new expression grammar — that column is
 *                  formula-level metadata, never read by this parser before today.
 *
 * The tree this produces is data — plain objects, nothing callable. No `eval`, no
 * `new Function`, no `vm`, no template-string execution anywhere in this module or
 * the ones built on it.
 */
export function parseExpression(source: string): RawNode {
  const tokens = tokenize(source);
  let index = 0;
  let nodeCount = 0;

  const peek = (): Token => tokens[index];
  const advance = (): Token => tokens[index++];

  function expect(type: TokenType): Token {
    const t = peek();
    if (t.type !== type) {
      throw new FormulaCompileError(
        `unexpected ${describeToken(t)} at position ${t.pos}; expected ${type}.`,
      );
    }
    return advance();
  }

  function makeNode<N extends RawNode>(node: N, depth: number): N {
    nodeCount += 1;
    if (nodeCount > MAX_NODES) {
      throw new FormulaCompileError(`expression exceeds ${MAX_NODES} nodes.`);
    }
    if (depth > MAX_DEPTH) {
      throw new FormulaCompileError(`expression exceeds depth ${MAX_DEPTH}.`);
    }
    return node;
  }

  function parseComparison(depth: number): RawNode {
    const left = parseExpr(depth);
    const t = peek();
    if (!COMPARE_OPS.includes(t.type)) return left;
    advance();
    const right = parseExpr(depth + 1);
    const next = peek();
    if (COMPARE_OPS.includes(next.type)) {
      throw new FormulaCompileError(
        `comparisons do not chain ("${next.text}" at position ${next.pos}); write each one separately.`,
      );
    }
    return makeNode({ type: 'compare', op: t.type as CompareOp, left, right, pos: t.pos }, depth);
  }

  function parseExpr(depth: number): RawNode {
    let left = parseTerm(depth);
    for (;;) {
      const t = peek();
      if (t.type !== '+' && t.type !== '-') return left;
      advance();
      const right = parseTerm(depth + 1);
      left = makeNode({ type: 'binary', op: t.type, left, right, pos: t.pos }, depth);
    }
  }

  function parseTerm(depth: number): RawNode {
    let left = parseFactor(depth);
    for (;;) {
      const t = peek();
      if (t.type !== '*' && t.type !== '/') return left;
      advance();
      const right = parseFactor(depth + 1);
      left = makeNode({ type: 'binary', op: t.type, left, right, pos: t.pos }, depth);
    }
  }

  function parseFactor(depth: number): RawNode {
    const t = peek();
    if (t.type === '-') {
      advance();
      const operand = parseFactor(depth + 1);
      return makeNode({ type: 'unary', op: '-', operand, pos: t.pos }, depth);
    }
    return parsePrimary(depth);
  }

  function parsePrimary(depth: number): RawNode {
    const t = peek();
    if (t.type === 'number') {
      advance();
      return makeNode({ type: 'number', value: Number(t.text), pos: t.pos }, depth);
    }
    if (t.type === 'duration') {
      advance();
      const suffix = t.text.slice(-1);
      const magnitude = Number(t.text.slice(0, -1));
      const hours = suffix === 'd' ? magnitude * 24 : magnitude;
      return makeNode({ type: 'duration', hours, pos: t.pos }, depth);
    }
    if (t.type === 'param') {
      advance();
      return makeNode({ type: 'param', name: t.text, pos: t.pos }, depth);
    }
    if (t.type === 'formularef') {
      advance();
      return makeNode({ type: 'formula_ref', name: t.text, pos: t.pos }, depth);
    }
    if (t.type === 'ident') {
      advance();
      if (peek().type === '(') {
        advance();
        const args: RawNode[] = [];
        if (peek().type !== ')') {
          args.push(parseComparison(depth + 1));
          while (peek().type === ',') {
            advance();
            args.push(parseComparison(depth + 1));
          }
        }
        expect(')');
        return makeNode({ type: 'call', name: t.text, args, pos: t.pos }, depth);
      }
      return makeNode({ type: 'signal', name: t.text, pos: t.pos }, depth);
    }
    if (t.type === '(') {
      advance();
      const inner = parseComparison(depth + 1);
      expect(')');
      return inner;
    }
    throw new FormulaCompileError(`unexpected ${describeToken(t)} at position ${t.pos}.`);
  }

  if (peek().type === 'eof') {
    throw new FormulaCompileError('the expression is empty.');
  }
  const root = parseComparison(1);
  const trailing = peek();
  if (trailing.type !== 'eof') {
    throw new FormulaCompileError(`unexpected ${describeToken(trailing)} at position ${trailing.pos}.`);
  }
  return root;
}

function describeToken(t: Token): string {
  if (t.type === 'eof') return 'end of expression';
  return `"${t.text}"`;
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    if (/\s/.test(c)) { i += 1; continue; }
    if ((c === '=' || c === '!') && source[i + 1] === '=') {
      throw new FormulaCompileError(
        `"${c}=" at position ${i}: there is no equality comparison — measurements are compared by `
          + 'order (>, >=, <, <=); state codes are categorical signals.',
      );
    }
    if (c === '>' || c === '<') {
      const op = source[i + 1] === '=' ? `${c}=` : c;
      tokens.push({ type: op as TokenType, text: op, pos: i });
      i += op.length;
      continue;
    }
    if (c === '+' || c === '-' || c === '*' || c === '/' || c === '(' || c === ')' || c === ',') {
      tokens.push({ type: c as TokenType, text: c, pos: i });
      i += 1;
      continue;
    }
    if (/[0-9]/.test(c)) {
      const start = i;
      while (i < source.length && /[0-9]/.test(source[i])) i += 1;
      if (source[i] === '.' && /[0-9]/.test(source[i + 1] ?? '')) {
        i += 1;
        while (i < source.length && /[0-9]/.test(source[i])) i += 1;
      }
      // A bare 'd'/'h' suffix not followed by a further identifier character is a
      // duration literal (task QCE4); `90days` is not a duration misread as "90d" —
      // it falls through to a number token followed by its own unrelated ident token,
      // the same refusal this grammar already gave it.
      if ((source[i] === 'd' || source[i] === 'h') && !/[A-Za-z0-9_]/.test(source[i + 1] ?? '')) {
        i += 1;
        tokens.push({ type: 'duration', text: source.slice(start, i), pos: start });
        continue;
      }
      tokens.push({ type: 'number', text: source.slice(start, i), pos: start });
      continue;
    }
    if (c === '@') {
      const start = i;
      i += 1;
      const identStart = i;
      while (i < source.length && /[A-Za-z0-9_]/.test(source[i])) i += 1;
      if (i === identStart) {
        throw new FormulaCompileError(`expected a parameter name after "@" at position ${start}.`);
      }
      tokens.push({ type: 'param', text: source.slice(identStart, i), pos: start });
      continue;
    }
    if (c === '#') {
      const start = i;
      i += 1;
      const identStart = i;
      while (i < source.length && /[A-Za-z0-9_]/.test(source[i])) i += 1;
      if (i === identStart) {
        throw new FormulaCompileError(`expected a formula key after "#" at position ${start}.`);
      }
      tokens.push({ type: 'formularef', text: source.slice(identStart, i), pos: start });
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const start = i;
      while (i < source.length && /[A-Za-z0-9_]/.test(source[i])) i += 1;
      tokens.push({ type: 'ident', text: source.slice(start, i), pos: start });
      continue;
    }
    throw new FormulaCompileError(`unexpected character "${c}" at position ${i}.`);
  }
  tokens.push({ type: 'eof', text: '', pos: source.length });
  return tokens;
}
