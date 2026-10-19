import { createHash } from 'crypto';
import { SEVERITY_ORDER, Severity } from '../common/severity';
import { SIGNALS } from '../common/signals';
import { AlertAppliesTo } from '../alert/entities/alert-rule.entity';
import {
  AlertParams, AlertTrigger, CompositeGroup, CompositeLeafTrigger, CompositeTerm, isCompositeLeaf, validateParams,
} from '../alert/services/alert-rules';

/**
 * The workflow vocabulary (task QWF1 §2, D18 Q1).
 *
 * Derived from D16 alone: the Visual Workflow addendum (WF01–WF08) is not in the
 * repository, and D18 records that this list is QWF1's in its absence. Every node is
 * something the alert runtime already evaluates, so a workflow is a front end on
 * `alert_rule`, not a second engine.
 *
 * A closed registry in code. A node type is a deploy (D25); a composition of them is a
 * row. A node type that is not here is refused by name, never interpreted.
 */
export const WORKFLOW_NODE_TYPES = [
  'ReadSignal', 'Threshold', 'FreshnessGate', 'PredictionSeverity', 'FuelLoss', 'ChainOrigin',
  'AllOf', 'AnyOf', 'Notify',
] as const;
export type WorkflowNodeType = (typeof WORKFLOW_NODE_TYPES)[number];

/** What a node does in the graph, which decides the edges it may have. */
type Role = 'source' | 'condition' | 'combine' | 'sink';

interface NodeKind {
  role: Role;
  /** The leaf trigger a condition compiles to. */
  trigger?: CompositeLeafTrigger;
  /** The only parameter names it takes. Anything else is refused, named. */
  params: readonly string[];
}

export const NODE_REGISTRY: Record<WorkflowNodeType, NodeKind> = {
  ReadSignal: { role: 'source', params: ['signal'] },
  Threshold: {
    role: 'condition', trigger: 'signal-threshold', params: ['max', 'min', 'lookbackReadings', 'requiredBreaches'],
  },
  FreshnessGate: { role: 'condition', trigger: 'no-telemetry', params: [] },
  PredictionSeverity: { role: 'condition', trigger: 'prediction-severity', params: ['atLeast', 'clientScenarioSlug'] },
  FuelLoss: { role: 'condition', trigger: 'fuel-loss', params: ['dropAtLeast', 'withinMinutes', 'movementTolerance'] },
  ChainOrigin: { role: 'condition', trigger: 'chain-origin', params: ['atLeast', 'chainSlug', 'stageSignal'] },
  AllOf: { role: 'combine', params: [] },
  AnyOf: { role: 'combine', params: [] },
  Notify: { role: 'sink', params: ['name', 'severity', 'description'] },
};

/**
 * Graph size caps (D18 Q4), for the reason the formula parser has `MAX_NODES` and
 * `MAX_DEPTH`: an unbounded graph is unbounded validation, compilation and rendering
 * work on every save. An alert workflow is a handful of conditions feeding a Notify;
 * fifty nodes is generous, and a rule nested eight deep no longer reads as a sentence.
 */
export const MAX_WORKFLOW_NODES = 50;
export const MAX_WORKFLOW_DEPTH = 8;

export interface WorkflowNode {
  id: string;
  type: WorkflowNodeType;
  params?: Record<string, unknown>;
}

export interface WorkflowEdge {
  from: string;
  to: string;
}

export interface WorkflowScope {
  appliesTo: AlertAppliesTo;
  plantId?: string | null;
  sourceSystem?: string | null;
  externalId?: string | null;
  equipmentClassSlug?: string | null;
}

/**
 * Execution semantics, and nothing else. Positions live in `workflow_layout` beside
 * the version, never in here: moving a node on the canvas is not a new graph (G08).
 */
export interface WorkflowSpec {
  kind: 'alert';
  scope: WorkflowScope;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

/** One rule the compiler would write. Content only — slug and provenance are the writer's. */
export interface CompiledRule {
  trigger: AlertTrigger;
  params: AlertParams;
  name: string;
  description: string | null;
  severity: Severity;
  /** Signals this rule reads, for readiness. */
  signals: string[];
}

export interface CompiledWorkflow {
  scope: WorkflowScope;
  rules: CompiledRule[];
  /** Every signal a ReadSignal names, for the class-declares check. */
  signals: string[];
  graphHash: string;
}

/** A spec the compiler refuses, with the sentence a person is shown. */
export class WorkflowSpecError extends Error {}

const APPLIES: AlertAppliesTo[] = ['account', 'plant', 'equipment', 'equipment-class'];

/**
 * Validates and compiles a spec, or throws `WorkflowSpecError` naming the first
 * problem. Pure: what the database knows (which signals a class declares, which
 * machines a scope covers) is checked by the caller, after this has said the graph
 * itself makes sense.
 */
export function compileWorkflow(raw: unknown): CompiledWorkflow {
  const spec = raw as WorkflowSpec;
  const fail = (message: string): never => { throw new WorkflowSpecError(message); };

  if (!spec || typeof spec !== 'object') fail('A workflow spec is an object with kind, scope, nodes and edges.');
  const extra = Object.keys(spec).filter((k) => !['kind', 'scope', 'nodes', 'edges'].includes(k));
  if (extra.length) fail(`A workflow spec holds kind, scope, nodes and edges only; "${extra[0]}" is not one of them.`);
  // Agent workflows need a runtime that can pause mid-graph, and alert_rule has no run
  // state to pause (D16). Refused here as well as by the table's CHECK.
  if (spec.kind !== 'alert') fail(`Only alert workflows can be compiled; "${String(spec.kind)}" has no runtime yet.`);

  const scope = checkScope(spec.scope, fail);
  if (!Array.isArray(spec.nodes) || !Array.isArray(spec.edges)) fail('A workflow needs a list of nodes and a list of edges.');
  if (spec.nodes.length > MAX_WORKFLOW_NODES) {
    fail(`A workflow has at most ${MAX_WORKFLOW_NODES} nodes; this one has ${spec.nodes.length}.`);
  }

  const byId = new Map<string, WorkflowNode>();
  for (const node of spec.nodes) {
    if (typeof node?.id !== 'string' || !node.id) fail('Every node needs an id.');
    if (byId.has(node.id)) fail(`Node id "${node.id}" is used twice.`);
    if (!WORKFLOW_NODE_TYPES.includes(node.type)) fail(`Node "${node.id}": "${String(node.type)}" is not a workflow node type.`);
    const params = node.params ?? {};
    if (typeof params !== 'object' || Array.isArray(params)) fail(`Node "${node.id}": params must be an object.`);
    const unknown = Object.keys(params).filter((k) => !NODE_REGISTRY[node.type].params.includes(k));
    if (unknown.length) fail(`Node "${node.id}" (${node.type}) has no parameter "${unknown[0]}".`);
    // Typed values only. No node carries text that reaches evaluation (D25, D34): the
    // strings allowed are names matched against stored identifiers, never conditions.
    for (const [k, v] of Object.entries(params)) {
      if (v !== null && typeof v === 'object') fail(`Node "${node.id}": parameter "${k}" must be a plain value.`);
    }
    byId.set(node.id, node);
  }

  const inputs = new Map<string, string[]>();
  const outputs = new Map<string, string[]>();
  for (const id of byId.keys()) { inputs.set(id, []); outputs.set(id, []); }
  for (const edge of spec.edges) {
    if (!byId.has(edge?.from) || !byId.has(edge?.to)) fail(`An edge joins a node that does not exist ("${edge?.from}" → "${edge?.to}").`);
    outputs.get(edge.from)!.push(edge.to);
    inputs.get(edge.to)!.push(edge.from);
  }

  // Which edges each role may have. A graph that breaks these is either missing a
  // Notify on some path or feeding something into a node that cannot use it.
  for (const node of byId.values()) {
    const role = NODE_REGISTRY[node.type].role;
    const ins = inputs.get(node.id)!.map((i) => byId.get(i)!);
    const outs = outputs.get(node.id)!.map((o) => byId.get(o)!);
    const label = `Node "${node.id}" (${node.type})`;
    if (role === 'source') {
      if (ins.length) fail(`${label} reads a signal; nothing feeds into it.`);
      if (!outs.length || outs.some((o) => o.type !== 'Threshold')) {
        fail(`${label} has to feed one or more Threshold nodes.`);
      }
    } else if (role === 'condition') {
      if (node.type === 'Threshold') {
        if (ins.length !== 1 || ins[0].type !== 'ReadSignal') fail(`${label} needs exactly one ReadSignal feeding it.`);
      } else if (ins.length) {
        fail(`${label} takes no input.`);
      }
      if (outs.length !== 1) fail(`${label} has ${outs.length} outgoing edges; every path ends in exactly one Notify.`);
    } else if (role === 'combine') {
      if (ins.length < 2) fail(`${label} combines ${ins.length} condition(s); a composite needs at least two.`);
      if (ins.some((i) => !['condition', 'combine'].includes(NODE_REGISTRY[i.type].role))) {
        fail(`${label} can only combine conditions and other AllOf / AnyOf nodes.`);
      }
      if (outs.length !== 1) fail(`${label} has ${outs.length} outgoing edges; every path ends in exactly one Notify.`);
    } else {
      if (outs.length) fail(`${label} is where a path ends; nothing follows it.`);
      if (ins.length !== 1 || !['condition', 'combine'].includes(NODE_REGISTRY[ins[0].type].role)) {
        fail(`${label} needs exactly one condition or AllOf / AnyOf feeding it.`);
      }
    }
  }

  // Acyclic, by Kahn's algorithm; the same pass gives each node's depth, the longest
  // path of nodes ending at it.
  const indegree = new Map([...inputs].map(([id, ins]) => [id, ins.length]));
  const depth = new Map<string, number>();
  const ready = [...byId.keys()].filter((id) => indegree.get(id) === 0);
  for (const id of ready) depth.set(id, 1);
  let visited = 0;
  while (ready.length) {
    const id = ready.shift()!;
    visited += 1;
    for (const next of outputs.get(id)!) {
      depth.set(next, Math.max(depth.get(next) ?? 0, depth.get(id)! + 1));
      indegree.set(next, indegree.get(next)! - 1);
      if (indegree.get(next) === 0) ready.push(next);
    }
  }
  if (visited !== byId.size) fail('The workflow has a cycle; a condition cannot depend on itself.');
  const deepest = Math.max(0, ...depth.values());
  if (deepest > MAX_WORKFLOW_DEPTH) fail(`A workflow is at most ${MAX_WORKFLOW_DEPTH} nodes deep; this one is ${deepest}.`);

  const notifies = [...byId.values()].filter((n) => n.type === 'Notify');
  if (!notifies.length) fail('A workflow needs at least one Notify, or nothing it finds reaches anybody.');

  // A node's compiled term, from its inputs back to the sources.
  const termOf = (id: string): { term: CompositeTerm; signals: string[] } => {
    const node = byId.get(id)!;
    const kind = NODE_REGISTRY[node.type];
    if (kind.role === 'combine') {
      const children = inputs.get(id)!.map(termOf);
      const terms = children.map((c) => c.term);
      return {
        term: node.type === 'AllOf' ? { allOf: terms } : { anyOf: terms },
        signals: children.flatMap((c) => c.signals),
      };
    }
    const params: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node.params ?? {})) if (v !== undefined && v !== null) params[k] = v;
    let signals: string[] = [];
    if (node.type === 'Threshold') {
      const source = byId.get(inputs.get(id)![0])!;
      const signal = source.params?.signal;
      if (typeof signal !== 'string' || !signal.trim()) fail(`Node "${source.id}" (ReadSignal) needs a signal.`);
      params.signal = (signal as string).trim();
      signals = [params.signal as string];
    }
    if (node.type === 'FuelLoss') signals = [SIGNALS.fuelLevel];
    // The existing validation, called rather than copied: an M greater than N is
    // refused here in the sentence a hand-written rule gets.
    const problem = validateParams(kind.trigger!, params as unknown as AlertParams);
    if (problem) fail(`Node "${id}" (${node.type}): ${problem}`);
    return { term: { trigger: kind.trigger!, params: params as unknown as AlertParams }, signals };
  };

  const rules: CompiledRule[] = notifies.map((notify) => {
    const p = notify.params ?? {};
    if (typeof p.name !== 'string' || !p.name.trim() || p.name.length > 120) {
      fail(`Node "${notify.id}" (Notify) needs a name of up to 120 characters.`);
    }
    if (!SEVERITY_ORDER.includes(p.severity as Severity) || p.severity === Severity.None) {
      fail(`Node "${notify.id}" (Notify) needs a severity: one of ${SEVERITY_ORDER.filter((s) => s !== Severity.None).join(', ')}.`);
    }
    if (p.description != null && typeof p.description !== 'string') fail(`Node "${notify.id}" (Notify): description must be text.`);
    const { term, signals } = termOf(inputs.get(notify.id)![0]);
    const leaf = isCompositeLeaf(term);
    return {
      trigger: leaf ? term.trigger : 'composite',
      params: leaf ? term.params : { condition: term as CompositeGroup },
      name: (p.name as string).trim(),
      description: typeof p.description === 'string' && p.description.trim() ? p.description.trim() : null,
      severity: p.severity as Severity,
      signals: [...new Set(signals)].sort(),
    };
  });

  const canonicalRules = rules.map(canonicalRule).sort();
  rules.sort((a, b) => canonicalRule(a).localeCompare(canonicalRule(b)));
  const signals = [...new Set([...byId.values()]
    .filter((n) => n.type === 'ReadSignal' && typeof n.params?.signal === 'string')
    .map((n) => (n.params!.signal as string).trim()))].sort();

  return {
    scope,
    rules,
    signals,
    // Over what the graph means, not how it was drawn: node ids, edge order and layout
    // never reach the hash, and AND / OR terms are sorted, so two graphs that compile
    // to the same rules hash the same and moving a node changes nothing.
    graphHash: createHash('sha256').update(canonicalJson({ kind: 'alert', scope, rules: canonicalRules })).digest('hex'),
  };
}

function checkScope(raw: WorkflowScope, fail: (m: string) => never): WorkflowScope {
  if (!raw || typeof raw !== 'object') fail('A workflow needs a scope: what it watches.');
  if (!APPLIES.includes(raw.appliesTo)) fail(`A workflow's scope applies to one of: ${APPLIES.join(', ')}.`);
  const scope: WorkflowScope = {
    appliesTo: raw.appliesTo,
    plantId: raw.appliesTo === 'plant' ? raw.plantId ?? null : null,
    sourceSystem: raw.appliesTo === 'equipment' ? raw.sourceSystem ?? null : null,
    externalId: raw.appliesTo === 'equipment' ? raw.externalId ?? null : null,
    equipmentClassSlug: raw.appliesTo === 'equipment-class' ? raw.equipmentClassSlug ?? null : null,
  };
  // The same companions alert_rule's own CHECK demands, said before the database has to.
  if (scope.appliesTo === 'plant' && !scope.plantId) fail('A workflow scoped to a site needs the site.');
  if (scope.appliesTo === 'equipment' && !(scope.sourceSystem && scope.externalId)) fail('A workflow scoped to a machine needs the machine.');
  if (scope.appliesTo === 'equipment-class' && !scope.equipmentClassSlug) fail('A workflow scoped to a kind of machine needs the class.');
  return scope;
}

function canonicalRule(rule: CompiledRule): string {
  return canonicalJson({
    trigger: rule.trigger, params: canonicalParams(rule.trigger, rule.params),
    name: rule.name, description: rule.description, severity: rule.severity,
  });
}

function canonicalParams(trigger: AlertTrigger, params: AlertParams): unknown {
  if (trigger !== 'composite') return params;
  const sortTerm = (t: CompositeTerm): unknown => {
    if (isCompositeLeaf(t)) return t;
    const terms = (t.allOf ?? t.anyOf ?? []).map(sortTerm).sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b)));
    return t.allOf ? { allOf: terms } : { anyOf: terms };
  };
  return { condition: sortTerm((params as { condition: CompositeGroup }).condition) };
}

/** JSON with object keys sorted at every depth. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort()
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
