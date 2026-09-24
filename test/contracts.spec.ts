import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const DIR = join(__dirname, '..', 'docs', 'ai', 'contracts');

/**
 * The shared contracts, guarded against being quietly loosened (task Q00).
 *
 * These five schemas are what every AI layer reads and writes: P05 produces
 * EquipmentContextV1, P08 produces RetrievalHitV1, P09 produces GroundedAnswerV1, and
 * P04's results and every error travel in the other two. A schema is only worth having
 * if it refuses things, and the specific refusals below are each a claim the platform
 * must never make by accident.
 *
 * The risk this suite exists for is not a malformed schema — a malformed schema fails
 * loudly the first time anything validates against it. It is a schema that still parses
 * after somebody has widened a type to make a failing test pass: `failure_probability`
 * becomes `["number", "null"]` because a model produced a plausible float, or
 * `additionalProperties` quietly disappears from an object somebody wanted to extend.
 * Both of those are green everywhere else and change what the platform is allowed to
 * assert about a customer's machine.
 *
 * Derived rather than listed wherever possible, so a sixth contract added next month is
 * covered the moment it lands rather than when somebody remembers this file.
 */

type Schema = Record<string, any>;

const files = readdirSync(DIR).filter((f) => f.endsWith('.json')).sort();
const schemas = new Map<string, Schema>();
for (const f of files) {
  schemas.set(f, JSON.parse(readFileSync(join(DIR, f), 'utf8')));
}
const byId = new Map<string, Schema>();
for (const s of schemas.values()) byId.set(s.$id, s);

/** Every object node in a schema, so a rule can be asserted everywhere rather than at the root. */
function* objects(node: any): Generator<Schema> {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) yield* objects(item);
    return;
  }
  if (node.type === 'object' || node.properties) yield node;
  for (const value of Object.values(node)) yield* objects(value);
}

function* refs(node: any): Generator<string> {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) yield* refs(item);
    return;
  }
  if (typeof node.$ref === 'string') yield node.$ref;
  for (const value of Object.values(node)) yield* refs(value);
}

describe('shared contracts', () => {
  it('finds the five contracts', () => {
    // If the directory moves, every assertion below passes vacuously.
    expect(files.length).toBeGreaterThanOrEqual(5);
    const titles = [...schemas.values()].map((s) => s.title).sort();
    expect(titles).toEqual([
      'CalculationResultV1', 'EquipmentContextV1', 'Error envelope',
      'GroundedAnswerV1', 'RetrievalHitV1',
    ]);
  });

  it.each(files)('%s declares a draft and a stable id', (file) => {
    const s = schemas.get(file)!;
    expect(s.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(s.$id).toMatch(/^https:\/\/things-alive\.io\/schemas\//);
    expect(s.title).toBeTruthy();
  });

  it.each(files)('%s rejects unexpected fields at its root', (file) => {
    // The shared contract requires unknown properties to be refused at external and
    // tool boundaries. A model that invents a field must fail validation rather than
    // have it silently dropped, which is how an unsupported claim reaches a screen.
    expect(schemas.get(file)!.additionalProperties).toBe(false);
  });

  it('every $ref points at a contract that exists', () => {
    const unresolved: string[] = [];
    for (const [file, s] of schemas) {
      for (const ref of refs(s)) {
        if (!byId.has(ref)) unresolved.push(`${file} -> ${ref}`);
      }
    }
    // A typo here resolves to nothing at runtime and validates everything.
    expect(unresolved).toEqual([]);
  });

  it('every required property is actually declared', () => {
    // The classic: a field is renamed in `properties` and left behind in `required`,
    // so the schema demands a key nothing can ever supply and every instance fails —
    // or, worse, the validator is lenient and it demands nothing at all.
    const orphans: string[] = [];
    for (const [file, s] of schemas) {
      for (const node of objects(s)) {
        if (!Array.isArray(node.required) || !node.properties) continue;
        for (const key of node.required) {
          if (!(key in node.properties)) orphans.push(`${file}: ${key}`);
        }
      }
    }
    expect(orphans).toEqual([]);
  });

  describe('the refusals that are the point', () => {
    it('a calculation cannot carry a failure probability', () => {
      // Only an approved probability model may produce one. A thermal crossing is not
      // RUL and a rule deviation is not a probability, so the field is typed null:
      // widening it to a number is a change of model, and should look like one in a diff.
      const calc = byId.get('https://things-alive.io/schemas/calculation-result.v1.json')!;
      expect(calc.properties.failure_probability.type).toBe('null');
    });

    it('unbound and stale stay different facts', () => {
      // Nothing is fitted, versus something is fitted and quiet. Collapsing them is how
      // a readiness screen tells an operator nothing they can act on.
      const ctx = byId.get('https://things-alive.io/schemas/equipment-context.v1.json')!;
      const reason = ctx.properties.missing_inputs.items.properties.reason.enum;
      for (const required of ['unbound', 'stale', 'no_readings', 'mapping_required']) {
        expect(reason).toContain(required);
      }
    });

    it('a relevance rank is not a confidence', () => {
      const hit = byId.get('https://things-alive.io/schemas/retrieval-hit.v1.json')!;
      expect(hit.properties.relevance_rank.type).toBe('integer');
      expect(hit.properties.relevance_rank.description).toMatch(/not a confidence/i);
    });

    it('an observation cannot be made without evidence', () => {
      // A numeric claim about current condition must point at the structured evidence it
      // came from. minItems is what makes that enforceable rather than aspirational.
      const ans = byId.get('https://things-alive.io/schemas/grounded-answer.v1.json')!;
      const obs = ans.properties.observations.items;
      expect(obs.required).toContain('evidence_refs');
      expect(obs.properties.evidence_refs.minItems).toBe(1);
    });

    it('per-layer availability cannot collapse into one flag', () => {
      // A machine can be physics-ready, forecast-blocked and ML-unavailable at the same
      // moment. The stored truth is the array; the single badge is derived for a screen.
      const ctx = byId.get('https://things-alive.io/schemas/equipment-context.v1.json')!;
      const layers = ctx.properties.intelligence_profile.properties.layers;
      expect(layers.type).toBe('array');
      expect(layers.items.properties.layer.enum).toEqual(
        expect.arrayContaining(['physics_calculation', 'physics_forecast', 'predictive_ml']),
      );
      expect(layers.items.properties.group.description).toMatch(/derived/i);
    });

    it('a snapshot assembled from two clocks has to say so', () => {
      // Domain revisions are read in one transaction while telemetry is fetched
      // separately. Without this flag a mixed-time snapshot presents itself as a set of
      // simultaneous measurements, which is the quiet way a stale reading becomes
      // evidence for a live decision.
      const ctx = byId.get('https://things-alive.io/schemas/equipment-context.v1.json')!;
      expect(ctx.properties.provenance.required).toContain('mixed_time');
    });
  });
});
