// Data/layout for the Work Flow canvas: converts the backend's WorkflowSpec (QWF1) into
// the node/edge graph React Flow renders (specToFlow), and back (flowToSpec). The canvas
// is the spec — every node is one the compiler knows and every edge is kept — so what is
// drawn is exactly what gets validated, compiled and published. Positions travel apart,
// as the version's layout, because moving a node is not a new graph.
import type { Node, Edge, XYPosition } from '@xyflow/react';
import { Activity, Bell, Fuel, GitBranch, GitMerge, Radio, Sigma, TrendingUp, WifiOff } from 'lucide-react';
import type { WorkflowNodeType, WorkflowSpec, WorkflowSpecNode, WorkflowScope } from '../../../lib/api';

export type WorkflowParams = NonNullable<WorkflowSpecNode['params']>;

export interface WorkflowNodeData extends Record<string, unknown> {
  type: WorkflowNodeType;
  params: WorkflowParams;
}

export type WorkflowNode = Node<WorkflowNodeData, 'workflowNode'>;

/** The caller's i18next `t`, bound to the alerts namespace. Passed in rather than
 *  imported so this module stays free of React and re-renders follow the language. */
export type Translate = (key: string, options?: Record<string, unknown>) => string;

type Role = 'source' | 'condition' | 'combine' | 'sink';

export const NODE_META: Record<WorkflowNodeType, {
  role: Role;
  icon: React.FC<{ className?: string }>;
  iconBg: string;
  iconColor: string;
  defaults: WorkflowParams;
}> = {
  ReadSignal: { role: 'source', icon: Radio, iconBg: 'bg-orange-50 dark:bg-orange-950/40', iconColor: 'text-orange-600 dark:text-orange-400', defaults: { signal: '' } },
  Threshold: { role: 'condition', icon: TrendingUp, iconBg: 'bg-violet-50 dark:bg-violet-950/40', iconColor: 'text-violet-600 dark:text-violet-400', defaults: {} },
  FreshnessGate: { role: 'condition', icon: WifiOff, iconBg: 'bg-violet-50 dark:bg-violet-950/40', iconColor: 'text-violet-600 dark:text-violet-400', defaults: {} },
  PredictionSeverity: { role: 'condition', icon: Activity, iconBg: 'bg-violet-50 dark:bg-violet-950/40', iconColor: 'text-violet-600 dark:text-violet-400', defaults: { atLeast: 'high' } },
  FuelLoss: { role: 'condition', icon: Fuel, iconBg: 'bg-violet-50 dark:bg-violet-950/40', iconColor: 'text-violet-600 dark:text-violet-400', defaults: {} },
  ChainOrigin: { role: 'condition', icon: GitBranch, iconBg: 'bg-violet-50 dark:bg-violet-950/40', iconColor: 'text-violet-600 dark:text-violet-400', defaults: { atLeast: 'warning' } },
  AllOf: { role: 'combine', icon: GitMerge, iconBg: 'bg-emerald-50 dark:bg-emerald-950/40', iconColor: 'text-emerald-600 dark:text-emerald-400', defaults: {} },
  AnyOf: { role: 'combine', icon: Sigma, iconBg: 'bg-emerald-50 dark:bg-emerald-950/40', iconColor: 'text-emerald-600 dark:text-emerald-400', defaults: {} },
  Notify: { role: 'sink', icon: Bell, iconBg: 'bg-rose-50 dark:bg-rose-950/40', iconColor: 'text-rose-600 dark:text-rose-400', defaults: { name: '', severity: 'high' } },
};

export const isSource = (type: WorkflowNodeType) => NODE_META[type].role === 'source';
export const isSink = (type: WorkflowNodeType) => NODE_META[type].role === 'sink';

const num = (v: unknown) => (typeof v === 'number' ? String(v) : null);

export function describeWorkflowNode(data: WorkflowNodeData, t: Translate): { title: string; subtitle?: string } {
  const p = data.params;
  const title = t(`workflow.palette.${data.type}`);
  switch (data.type) {
    case 'ReadSignal':
      return { title: (p.signal as string) || title, subtitle: title };
    case 'Threshold': {
      const parts = [num(p.max) && `> ${p.max}`, num(p.min) && `< ${p.min}`].filter(Boolean);
      return { title, subtitle: parts.length ? parts.join(' · ') : t('workflow.node.unset') };
    }
    case 'PredictionSeverity':
      return { title, subtitle: t('workflow.node.atLeast', { severity: t(`workflow.severity.${p.atLeast}`, { defaultValue: p.atLeast }) }) };
    case 'ChainOrigin':
      return { title, subtitle: [p.chainSlug, t('workflow.node.atLeast', { severity: t(`workflow.chainLevel.${p.atLeast}`, { defaultValue: p.atLeast }) })].filter(Boolean).join(' · ') };
    case 'FuelLoss':
      return { title, subtitle: num(p.dropAtLeast) && num(p.withinMinutes) ? t('workflow.node.fuelDrop', { drop: p.dropAtLeast, minutes: p.withinMinutes }) : t('workflow.node.unset') };
    case 'Notify':
      return { title: (p.name as string) || title, subtitle: t(`workflow.severity.${p.severity}`, { defaultValue: (p.severity as string) ?? '' }) };
    default:
      return { title };
  }
}

const NODE_W = 168;
const NODE_H = 56;
const COL_GAP = 64;
const ROW_STEP = NODE_H + 28;
const CANVAS_PAD = 48;

/** Columns by longest path from a source, rows in spec order: a readable first layout
 *  for a graph nobody has arranged yet (one assembled by the assistant, say). */
function autoLayout(spec: WorkflowSpec): Record<string, XYPosition> {
  const inputs = new Map(spec.nodes.map((n) => [n.id, [] as string[]]));
  for (const e of spec.edges) inputs.get(e.to)?.push(e.from);
  const depth = new Map<string, number>();
  const depthOf = (id: string, seen = new Set<string>()): number => {
    if (depth.has(id)) return depth.get(id)!;
    if (seen.has(id)) return 0;
    seen.add(id);
    const d = Math.max(-1, ...(inputs.get(id) ?? []).map((i) => depthOf(i, seen))) + 1;
    depth.set(id, d);
    return d;
  };
  spec.nodes.forEach((n) => depthOf(n.id));
  const rows = new Map<number, number>();
  const out: Record<string, XYPosition> = {};
  for (const n of spec.nodes) {
    const col = depth.get(n.id) ?? 0;
    const row = rows.get(col) ?? 0;
    rows.set(col, row + 1);
    out[n.id] = { x: CANVAS_PAD + col * (NODE_W + COL_GAP), y: CANVAS_PAD + row * ROW_STEP };
  }
  return out;
}

export function specToFlow(spec: WorkflowSpec, layout: Record<string, XYPosition> = {}): { nodes: WorkflowNode[]; edges: Edge[] } {
  const auto = autoLayout(spec);
  return {
    nodes: spec.nodes.map((n) => ({
      id: n.id,
      type: 'workflowNode',
      position: layout[n.id] ?? auto[n.id],
      data: { type: n.type, params: { ...(n.params ?? {}) } },
    })),
    edges: spec.edges.map((e, i) => ({ id: `e-${i}-${e.from}-${e.to}`, source: e.from, target: e.to })),
  };
}

/** Empty inputs are left out rather than sent as "", so an unset bound stays unset. */
function cleanParams(params: WorkflowParams): WorkflowParams {
  return Object.fromEntries(Object.entries(params).filter(([, v]) => v !== '' && v !== null && v !== undefined
    && !(typeof v === 'number' && Number.isNaN(v))));
}

export function flowToSpec(nodes: WorkflowNode[], edges: Edge[], scope: WorkflowScope): WorkflowSpec {
  return {
    kind: 'alert',
    scope,
    nodes: nodes.map((n) => {
      const params = cleanParams(n.data.params);
      return Object.keys(params).length ? { id: n.id, type: n.data.type, params } : { id: n.id, type: n.data.type };
    }),
    edges: edges.map((e) => ({ from: e.source, to: e.target })),
  };
}

export function flowLayout(nodes: WorkflowNode[]): Record<string, { x: number; y: number }> {
  return Object.fromEntries(nodes.map((n) => [n.id, { x: Math.round(n.position.x), y: Math.round(n.position.y) }]));
}

export interface PaletteItem {
  type: WorkflowNodeType;
}

// Section and item names are alerts:workflow.section.<id> / workflow.palette.<type>.
export const PALETTE_SECTIONS: { id: string; items: WorkflowNodeType[] }[] = [
  { id: 'data', items: ['ReadSignal'] },
  { id: 'conditions', items: ['Threshold', 'FreshnessGate', 'PredictionSeverity', 'FuelLoss', 'ChainOrigin'] },
  { id: 'logic', items: ['AllOf', 'AnyOf'] },
  { id: 'actions', items: ['Notify'] },
];

let nodeSeq = 0;
export function nextNodeId(type: WorkflowNodeType): string {
  nodeSeq += 1;
  return `${type.toLowerCase()}-${Date.now().toString(36)}-${nodeSeq}`;
}

export function createPaletteNode(type: WorkflowNodeType, position: XYPosition): WorkflowNode {
  return { id: nextNodeId(type), type: 'workflowNode', position, data: { type, params: { ...NODE_META[type].defaults } } };
}

/** A starting graph for "Create custom": one signal, a threshold to fill in, a notify. */
export function starterSpec(scope: WorkflowScope, signal: string, name: string): WorkflowSpec {
  return {
    kind: 'alert',
    scope,
    nodes: [
      { id: 'signal', type: 'ReadSignal', params: { signal } },
      { id: 'threshold', type: 'Threshold' },
      { id: 'notify', type: 'Notify', params: { name, severity: 'high' } },
    ],
    edges: [{ from: 'signal', to: 'threshold' }, { from: 'threshold', to: 'notify' }],
  };
}

/** The signals a spec reads, for the list's Sensors column. */
export function specSignals(spec: WorkflowSpec): string[] {
  return [...new Set(spec.nodes.filter((n) => n.type === 'ReadSignal').map((n) => String(n.params?.signal ?? '')).filter(Boolean))];
}

const CONDITION_TYPES = new Set<WorkflowNodeType>(['Threshold', 'FreshnessGate', 'PredictionSeverity', 'FuelLoss', 'ChainOrigin']);

/**
 * An assembled spec made whole for the editor. The server's conditions — each from a
 * copied template, with its real threshold — are kept; each signal no template watches
 * gets a ReadSignal and a Threshold left blank, because a bound is the person's to set
 * and never one made up here; then every condition joins one All of / Any of and one
 * Notify named after the failure mode. Save refuses the graph until the blanks are filled.
 */
export function completeAssembled(
  assembled: WorkflowSpec,
  unresolvedSignals: string[],
  opts: { name: string; combine: 'allOf' | 'anyOf' },
): WorkflowSpec {
  const kept = assembled.nodes.filter((n) => n.type === 'ReadSignal' || CONDITION_TYPES.has(n.type));
  const keptIds = new Set(kept.map((n) => n.id));
  const edges = assembled.edges.filter((e) => keptIds.has(e.from) && keptIds.has(e.to));
  const severity = assembled.nodes.find((n) => n.type === 'Notify')?.params?.severity ?? 'high';
  const nodes: WorkflowSpecNode[] = [...kept];
  const conditions = kept.filter((n) => CONDITION_TYPES.has(n.type)).map((n) => n.id);

  unresolvedSignals.forEach((signal, i) => {
    const id = `gap-${i + 1}`;
    nodes.push({ id: `${id}-signal`, type: 'ReadSignal', params: { signal } }, { id, type: 'Threshold' });
    edges.push({ from: `${id}-signal`, to: id });
    conditions.push(id);
  });
  if (!conditions.length) return { ...assembled, nodes: [], edges: [] };

  nodes.push({ id: 'notify', type: 'Notify', params: { name: opts.name.slice(0, 120), severity } });
  if (conditions.length > 1) {
    nodes.push({ id: 'combine', type: opts.combine === 'anyOf' ? 'AnyOf' : 'AllOf' });
    conditions.forEach((c) => edges.push({ from: c, to: 'combine' }));
    edges.push({ from: 'combine', to: 'notify' });
  } else {
    edges.push({ from: conditions[0], to: 'notify' });
  }
  return { kind: 'alert', scope: assembled.scope, nodes, edges };
}
