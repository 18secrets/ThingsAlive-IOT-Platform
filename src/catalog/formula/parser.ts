import { FormulaCompileError } from './errors';

export type RawNode =
  | { type: 'number'; value: number; pos: number }
  | { type: 'signal'; name: string; pos: number }
  | { type: 'param'; name: string; pos: number }
  | { type: 'unary'; op: '-'; operand: RawNode; pos: number }
  | { type: 'binary'; op: '+' | '-' | '*' | '/'; left: RawNode; right: RawNode; pos: number }
  | { type: 'call'; name: string; args: RawNode[]; pos: number };

/** A guard on an untrusted input path (task QCE1): formulas arrive from uploaded
 * spreadsheets, and a parser with no limit on its own output size is a denial of
 * service waiting for a sufficiently nested cell. */
export const MAX_NODES = 200;
export const MAX_DEPTH = 20;

type TokenType = 'number' | 'ident' | 'param' | '+' | '-' | '*' | '/' | '(' | ')' | ',' | 'eof';
interface Token { type: TokenType; text: string; pos: number }

/**
 * A hand-written recursive-descent parser for the small expression grammar (task
 * QCE1) — deliberately not a dependency. Formulas arrive from uploaded
 * spreadsheets, an untrusted input path, and a third-party parser is supply-chain
 * surface plus loss of control over refusal messages.
 *
 *   expression := term (('+' | '-') term)*
 *   term       := factor (('*' | '/') factor)*
 *   factor     := '-' factor | primary
 *   primary    := number | call | signal | param | '(' expression ')'
 *   call       := identifier '(' [ expression (',' expression)* ] ')'
 *   signal     := identifier
 *   param      := '@' identifier
 *   number     := digits [ '.' digits ]
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
    if (t.type === 'param') {
      advance();
      return makeNode({ type: 'param', name: t.text, pos: t.pos }, depth);
    }
    if (t.type === 'ident') {
      advance();
      if (peek().type === '(') {
        advance();
        const args: RawNode[] = [];
        if (peek().type !== ')') {
          args.push(parseExpr(depth + 1));
          while (peek().type === ',') {
            advance();
            args.push(parseExpr(depth + 1));
          }
        }
        expect(')');
        return makeNode({ type: 'call', name: t.text, args, pos: t.pos }, depth);
      }
      return makeNode({ type: 'signal', name: t.text, pos: t.pos }, depth);
    }
    if (t.type === '(') {
      advance();
      const inner = parseExpr(depth + 1);
      expect(')');
      return inner;
    }
    throw new FormulaCompileError(`unexpected ${describeToken(t)} at position ${t.pos}.`);
  }

  if (peek().type === 'eof') {
    throw new FormulaCompileError('the expression is empty.');
  }
  const root = parseExpr(1);
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
