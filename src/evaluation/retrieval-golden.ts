import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

/**
 * The retrieval golden set (QEVAL1 §3, question 3): questions, each with the library
 * entries a correct answer must find. Written by people who maintain this equipment,
 * never by a model — a golden set from the model under test measures agreement with
 * itself. The format is documented in `docs/ai/eval/retrieval/README.md`.
 *
 * Expected entries are named by their library keys (class slug, failure-mode code, and
 * for a recommendation its action text), not by row ids: every account holds its own
 * copy of the library with its own ids, and one golden set has to be scored in each.
 */
export const GOLDEN_FORMAT = 'ta2.retrieval-golden@1';

export type GoldenKind = 'smoke' | 'authored';

export type GoldenExpectation =
  | { kind: 'failure_mode'; classSlug: string; code: string }
  | { kind: 'recommendation'; classSlug: string; code: string; action: string };

export interface GoldenQuery {
  id: string;
  /** The class the question is asked about. The search is filtered to it, as it is when a
   * machine's page asks; omitted, the whole library is searched. */
  classSlug?: string;
  text: string;
  expect: GoldenExpectation[];
}

export interface GoldenSet {
  format: typeof GOLDEN_FORMAT;
  name: string;
  version: string;
  kind: GoldenKind;
  authoredBy: string;
  authoredAt: string;
  queries: GoldenQuery[];
}

export class GoldenSetInvalid extends Error {}

/** Reads and checks a golden set; the hash identifies the exact file a run scored. */
export function loadGoldenSet(path: string): { set: GoldenSet; sha256: string } {
  const raw = readFileSync(path, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new GoldenSetInvalid(`${path} is not JSON: ${(err as Error).message}`);
  }
  return { set: validateGoldenSet(parsed), sha256: createHash('sha256').update(raw, 'utf8').digest('hex') };
}

/**
 * Hand-checked rather than schema-checked: `ajv` is a test dependency only. Every refusal
 * names what is wrong, because the people fixing a golden set are not the people who
 * wrote this file.
 */
export function validateGoldenSet(input: unknown): GoldenSet {
  const fail = (msg: string): never => { throw new GoldenSetInvalid(msg); };
  const str = (v: unknown, where: string): string =>
    (typeof v === 'string' && v.trim() ? v : fail(`${where} must be a non-empty string`));
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('a golden set is a JSON object');
  const o = input as Record<string, unknown>;
  if (o.format !== GOLDEN_FORMAT) fail(`format must be "${GOLDEN_FORMAT}", not ${JSON.stringify(o.format)}`);
  if (o.kind !== 'smoke' && o.kind !== 'authored') fail('kind must be "smoke" or "authored"');
  const set: GoldenSet = {
    format: GOLDEN_FORMAT, name: str(o.name, 'name'), version: str(o.version, 'version'), kind: o.kind as GoldenKind,
    authoredBy: str(o.authoredBy, 'authoredBy'), authoredAt: str(o.authoredAt, 'authoredAt'), queries: [],
  };
  if (!Array.isArray(o.queries) || !o.queries.length) fail('queries must be a non-empty array');
  const ids = new Set<string>();
  for (const [i, q] of (o.queries as unknown[]).entries()) {
    const where = `queries[${i}]`;
    if (!q || typeof q !== 'object') fail(`${where} must be an object`);
    const r = q as Record<string, unknown>;
    const id = str(r.id, `${where}.id`);
    if (ids.has(id)) fail(`${where}.id "${id}" is used twice`);
    ids.add(id);
    const classSlug = r.classSlug === undefined ? undefined : str(r.classSlug, `${where}.classSlug`);
    if (!Array.isArray(r.expect) || !r.expect.length) fail(`${where}.expect must list at least one entry`);
    const expect = (r.expect as unknown[]).map((e, j): GoldenExpectation => {
      const w = `${where}.expect[${j}]`;
      const x = (e ?? {}) as Record<string, unknown>;
      const cls = str(x.classSlug, `${w}.classSlug`);
      const code = str(x.code, `${w}.code`);
      if (x.kind === 'failure_mode') return { kind: 'failure_mode', classSlug: cls, code };
      if (x.kind === 'recommendation') return { kind: 'recommendation', classSlug: cls, code, action: str(x.action, `${w}.action`) };
      return fail(`${w}.kind must be "failure_mode" or "recommendation"`);
    });
    set.queries.push({ id, ...(classSlug ? { classSlug } : {}), text: str(r.text, `${where}.text`), expect });
  }
  return set;
}
