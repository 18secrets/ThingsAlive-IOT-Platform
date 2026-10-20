import { BundleView, GroundedAnswer } from './grounded-answer';
import { fmt, NUMERIC_TOKEN } from './templates';

/** The checks, named as the prompt numbers them (§4.1). A refusal records these names. */
export const CHECK = {
  shape: '1_shape',
  refs: '2_refs_resolve',
  numbers: '3_numbers_trace',
  future: '4_no_future_number',
  closedSet: '5_closed_set',
  probability: '6_no_probability',
  structure: '7_model_structure',
} as const;

const ROW_REF = /^(alert_event|work_order|equipment_service_record|client_equipment_class_recommendation|tenant_parameter):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const BUNDLE_REF = /^rec_evidence_bundle:([0-9a-f-]{36})#(\/.*)$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_ANYWHERE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
// G07: the bundle states no probability, so a frame may not either.
const PROBABILITY = /%|\b(likely|likelihood|probable|probably|probabilit\w*|chance\w*|confiden\w*)\b/i;
const STATUSES = ['answered', 'partial', 'needs_input', 'insufficient_evidence', 'unavailable'];

/**
 * D21's critic, in code (task QREC2 §4). Runs on every frame, whichever renderer
 * produced it: two paths, one gate. Returns the names of the checks that failed; an
 * empty list is a pass.
 *
 * It judges the frame against the bundle and nothing else. A ref to a real row the
 * bundle did not read is refused (check 2), because the frame describes the evidence,
 * not the database; a number the bundle does not hold is refused (check 3), because D26's
 * test is provenance, not format.
 *
 * `template` is passed on the model path only: the model may rephrase and reselect, but
 * not add observations, hypotheses, refs or inputs (§6.1), and check 7 holds it to that.
 */
export function critic(frame: unknown, bundle: BundleView, template?: GroundedAnswer): string[] {
  const failed = new Set<string>();
  if (!shapeOk(frame)) return [CHECK.shape];
  const f = frame as GroundedAnswer;

  // -- 2. refs resolve, to the bundle or to a row it names
  const known = namedRows(bundle);
  const refs = [...f.observations.flatMap((o) => o.evidence_refs), ...f.hypotheses.flatMap((h) => h.evidence_refs)];
  for (const r of refs) {
    const row = ROW_REF.exec(r);
    const ptr = BUNDLE_REF.exec(r);
    if (row) { if (!known.get(row[1])?.has(row[2])) failed.add(CHECK.refs); }
    else if (ptr) { if (ptr[1] !== bundle.id || resolvePointer(bundle, ptr[2]) === undefined) failed.add(CHECK.refs); }
    else failed.add(CHECK.refs);
  }

  // -- 3, 4, 6 read every sentence
  const allowed = allowedTokens(bundle);
  const verbatim = verbatimStrings(bundle);
  const asOf = bundle.asOf.slice(0, 16);
  for (const text of texts(f)) {
    for (const token of text.match(NUMERIC_TOKEN) ?? []) {
      if (!allowed.has(token)) failed.add(CHECK.numbers);
      // A time after as_of is a claim about the future. Until a forecast run can be
      // cited (QML1's run id), nothing in the bundle may carry one, so none passes.
      if (token.endsWith('UTC') && `${token.slice(0, 10)}T${token.slice(11, 16)}` > asOf) failed.add(CHECK.future);
    }
    // Library wording is quoted, not asserted: a "%" in an authored action is the library's.
    let own = text;
    for (const v of verbatim) own = own.split(v).join(' ');
    if (PROBABILITY.test(own)) failed.add(CHECK.probability);
  }

  // -- 5. every aim is a candidate action, character for character
  const actions = new Set(bundle.candidates.map((c) => c.action));
  if (f.next_steps.some((s) => !actions.has(s.aim))) failed.add(CHECK.closedSet);
  if (new Set(f.next_steps.map((s) => s.aim)).size !== f.next_steps.length) failed.add(CHECK.closedSet);

  // -- 7. the model rewrites; it does not compose
  if (template) {
    const sameRefs = (a: { evidence_refs: string[] }[], b: { evidence_refs: string[] }[]) =>
      a.length === b.length && a.every((x, i) => [...x.evidence_refs].sort().join() === [...b[i].evidence_refs].sort().join());
    if (!sameRefs(f.observations, template.observations) || !sameRefs(f.hypotheses, template.hypotheses)
      || f.status !== template.status || f.citations.length !== 0
      || [...f.missing_inputs].sort().join() !== [...template.missing_inputs].sort().join()
      || f.next_steps.length > bundle.candidates.length
      || f.context_id !== template.context_id || f.as_of !== template.as_of
      || (f.proposal_ids !== undefined)) {
      failed.add(CHECK.structure);
    }
  }
  return [...failed];
}

// ------------------------------------------------------------------------- helpers

function texts(f: GroundedAnswer): string[] {
  return [
    f.summary,
    ...f.observations.map((o) => o.claim),
    ...f.hypotheses.flatMap((h) => [h.claim, ...h.limitations]),
    ...f.next_steps.flatMap((s) => [s.aim, s.expected_outcome, s.required_capability]),
    ...f.missing_inputs,
    ...f.limitations,
  ];
}

/**
 * Every token a sentence may contain: each number the bundle holds, each time it holds
 * (formatted as `fmt.time` would), each number written inside its strings (a signal
 * key, an authored action), and the length of each of its lists — "3 of 4 signals" is a
 * count of what the bundle lists, and nothing else.
 */
function allowedTokens(bundle: BundleView): Set<string> {
  const out = new Set<string>();
  const walk = (v: unknown): void => {
    if (typeof v === 'number') out.add(fmt.num(v));
    else if (typeof v === 'string') {
      if (ISO.test(v)) out.add(fmt.time(v));
      // An id's digits are not numbers anyone stated: "87" inside a uuid must not license an "87" in a sentence.
      const text = v.replace(UUID_ANYWHERE, ' ');
      for (const t of text.match(NUMERIC_TOKEN) ?? []) out.add(t);
      for (const t of text.match(/\d+(?:\.\d+)?/g) ?? []) out.add(t);
    } else if (Array.isArray(v)) { out.add(fmt.num(v.length)); v.forEach(walk); }
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(bundle);
  return out;
}

function verbatimStrings(bundle: BundleView): string[] {
  return [...new Set([
    ...bundle.candidates.map((c) => c.action),
    ...bundle.attribute.modes.flatMap((m) => [m.name, m.failureModeCode]),
    ...(bundle.classSlug ? [bundle.classSlug] : []),
  ].filter((s) => s.length > 0))].sort((a, b) => b.length - a.length);
}

/** The row ids the bundle read, by table. A ref outside this set describes something the bundle did not see. */
function namedRows(b: BundleView): Map<string, Set<string>> {
  const ids = (refs: (string | undefined)[], table: string) =>
    refs.filter((r): r is string => !!r && r.startsWith(`${table}:`)).map((r) => r.slice(table.length + 1));
  const alertRefs = [
    ...b.detect.entries.flatMap((e) => e.sources.map((s) => s.ref)),
    ...b.detect.unattributableAlerts.map((a) => a.ref),
    ...b.attribute.unattributed.flatMap((u) => u.refs),
  ];
  return new Map([
    ['alert_event', new Set([...ids(alertRefs, 'alert_event'), ...b.precedent.modes.flatMap((p) => p.alertEvents.map((x) => x.id))])],
    ['work_order', new Set([...b.precedent.modes.flatMap((p) => p.workOrders.map((x) => x.id)), ...b.candidates.flatMap((c) => c.inHandWorkOrderIds)])],
    ['equipment_service_record', new Set(b.precedent.modes.flatMap((p) => p.serviceRecords.map((x) => x.id)))],
    ['client_equipment_class_recommendation', new Set(b.candidates.map((c) => c.recommendationId))],
    // The bundle names parameters by scope and effective date, not by row id (QREC1 §6),
    // so no tenant_parameter:<uuid> ref resolves yet; cost facts are cited as bundle pointers.
    ['tenant_parameter', new Set<string>()],
  ]);
}

/** RFC 6901, over the bundle's JSON. Undefined when the pointer names nothing. */
function resolvePointer(root: unknown, pointer: string): unknown {
  let node: unknown = root;
  for (const raw of pointer.split('/').slice(1)) {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (node === null || typeof node !== 'object' || !(key in (node as object))) return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return node;
}

/**
 * GroundedAnswerV1's shape, checked by hand. `ajv` is a dev dependency only and no
 * runtime one is approved (question 7), so the model path checks the closed contract
 * here; the test suite holds this check to the schema file with ajv, on both a good
 * frame and a widened one.
 */
function shapeOk(v: unknown): boolean {
  const obj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
  const str = (x: unknown) => typeof x === 'string';
  const strs = (x: unknown) => Array.isArray(x) && x.every(str);
  const only = (x: Record<string, unknown>, required: string[], optional: string[] = []) =>
    required.every((k) => k in x) && Object.keys(x).every((k) => required.includes(k) || optional.includes(k));
  if (!obj(v)) return false;
  if (!only(v, ['answer_id', 'context_id', 'status', 'summary', 'observations', 'hypotheses', 'next_steps',
    'citations', 'missing_inputs', 'as_of', 'limitations'], ['proposal_ids'])) return false;
  if (!str(v.answer_id) || !UUID.test(v.answer_id as string) || !str(v.context_id) || !UUID.test(v.context_id as string)) return false;
  if (!STATUSES.includes(v.status as string) || !str(v.summary)) return false;
  if (!str(v.as_of) || Number.isNaN(Date.parse(v.as_of as string))) return false;
  if (!strs(v.missing_inputs) || !strs(v.limitations) || !Array.isArray(v.citations)) return false;
  if (v.proposal_ids !== undefined && !(strs(v.proposal_ids) && (v.proposal_ids as string[]).every((x) => UUID.test(x)))) return false;
  if (!Array.isArray(v.observations) || !v.observations.every((o) =>
    obj(o) && only(o, ['claim', 'evidence_refs']) && str(o.claim) && strs(o.evidence_refs) && (o.evidence_refs as string[]).length >= 1)) return false;
  if (!Array.isArray(v.hypotheses) || !v.hypotheses.every((h) =>
    obj(h) && only(h, ['claim', 'evidence_refs', 'limitations']) && str(h.claim) && strs(h.evidence_refs) && strs(h.limitations))) return false;
  if (!Array.isArray(v.next_steps) || !v.next_steps.every((s) =>
    obj(s) && only(s, ['aim', 'expected_outcome', 'required_capability', 'simulation_available'])
    && str(s.aim) && str(s.expected_outcome) && str(s.required_capability) && typeof s.simulation_available === 'boolean')) return false;
  return true;
}
