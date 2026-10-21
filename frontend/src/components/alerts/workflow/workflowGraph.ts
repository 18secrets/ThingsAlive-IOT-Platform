// Data/layout for the Work Flow canvas: converts a WorkflowSpec into the node/edge
// graph React Flow renders (specToFlow), and reconstructs a WorkflowSpec back from
// the live, user-edited graph (flowToSpec). The reverse direction reads node *kind*
// and its fields rather than walking edges — WorkflowSpec is a fixed shape (one
// trigger, N conditions, optional guard, one gate, N actions), not an arbitrary
// graph, so aggregating by kind is what actually round-trips; edges stay purely
// presentational and can be freely rewired without changing the derived spec.
import type { Node, Edge, XYPosition } from '@xyflow/react';
import {
  Clock,
  Settings,
  Database,
  Sigma,
  Calculator,
  Flag,
  Link2,
  GitMerge,
  Webhook as WebhookIcon,
  Mail,
  MessageSquare,
} from 'lucide-react';
import { WorkflowSpec, WorkflowOperator, WorkflowActionType } from '../../../utils/workflowParser';

export type WorkflowNodeKind = 'trigger' | 'readSensor' | 'condition' | 'guard' | 'gate' | 'action' | 'processing';

export interface WorkflowNodeData extends Record<string, unknown> {
  kind: WorkflowNodeKind;
  icon: React.FC<{ className?: string }>;
  iconBg: string;
  iconColor: string;
  /** Static display name — used by processing nodes and as a fallback everywhere else. */
  title?: string;
  sensor?: string; // readSensor, condition
  operator?: WorkflowOperator; // condition
  value?: string; // condition, guard
  field?: string; // guard
  logic?: 'AND' | 'OR'; // gate
  actionType?: WorkflowActionType; // action
  scheduleLabel?: string; // trigger
}

export type WorkflowNode = Node<WorkflowNodeData, 'workflowNode'>;

/** The caller's i18next `t`, bound to the alerts namespace. Passed in rather than
 *  imported so this module stays free of React and re-renders follow the language. */
export type Translate = (key: string, options?: Record<string, unknown>) => string;

export function describeWorkflowNode(data: WorkflowNodeData, t: Translate): { title: string; subtitle?: string } {
  switch (data.kind) {
    case 'trigger':
      return { title: t('workflow.palette.schedule'), subtitle: data.scheduleLabel };
    case 'readSensor':
      return { title: data.sensor || t('workflow.palette.readSensor'), subtitle: data.sensor };
    case 'condition':
      return { title: data.sensor || t('workflow.palette.condition'), subtitle: `${data.sensor ?? '?'} ${data.operator ?? '>'} ${data.value ?? ''}` };
    case 'guard':
      return { title: data.field || t('workflow.palette.guard'), subtitle: data.field ? `${data.field} = ${data.value ?? ''}` : undefined };
    case 'gate':
      return { title: data.logic ?? 'AND', subtitle: t('workflow.node.expression') };
    case 'action': {
      const type = data.actionType ?? 'Webhook';
      return { title: t(`workflow.actionType.${type}`, { defaultValue: type }) };
    }
    case 'processing':
      return { title: data.title ?? t('workflow.node.step') };
  }
}

const NODE_W = 168;
const NODE_H = 56;
const COL_GAP = 64;
const ROW_GAP = 28;
const ROW_STEP = NODE_H + ROW_GAP;
const CANVAS_PAD = 48;

function distributeCentered(count: number, centerTop: number): number[] {
  if (count <= 0) return [centerTop];
  const base = centerTop - ((count - 1) / 2) * ROW_STEP;
  return Array.from({ length: count }, (_, i) => base + i * ROW_STEP);
}

const colX = (col: number) => CANVAS_PAD + col * (NODE_W + COL_GAP);
const topY = (top: number) => CANVAS_PAD + top;

const ACTION_META: Record<WorkflowActionType, { icon: React.FC<{ className?: string }>; label: string }> = {
  Webhook: { icon: WebhookIcon, label: 'Webhook' },
  Email: { icon: Mail, label: 'Email' },
  SMS: { icon: MessageSquare, label: 'SMS' },
};

let nodeSeq = 0;
function nextId(prefix: string): string {
  nodeSeq += 1;
  return `${prefix}-${Date.now()}-${nodeSeq}`;
}

export function specToFlow(spec: WorkflowSpec): { nodes: WorkflowNode[]; edges: Edge[] } {
  const nodes: WorkflowNode[] = [];
  const edges: Edge[] = [];
  const hasConditions = spec.conditions.length > 0;

  const maxRows = Math.max(spec.conditions.length, spec.actions.length, 1);
  const centerTop = ((maxRows - 1) / 2) * ROW_STEP;
  const branchTops = distributeCentered(spec.conditions.length, centerTop);
  const actionTops = distributeCentered(spec.actions.length, centerTop);

  const at = (col: number, top: number): XYPosition => ({ x: colX(col), y: topY(top) });

  let col = 0;
  const triggerId = 'trigger';
  nodes.push({
    id: triggerId,
    type: 'workflowNode',
    position: at(col, centerTop),
    deletable: false,
    data: {
      kind: 'trigger',
      scheduleLabel: spec.scheduleLabel,
      icon: Clock,
      iconBg: 'bg-blue-50 dark:bg-blue-950/40',
      iconColor: 'text-blue-600 dark:text-blue-400',
    },
  });
  col++;

  if (!hasConditions) {
    return { nodes, edges };
  }

  const readIds: string[] = [];
  spec.conditions.forEach((c, i) => {
    const id = `read-${i}`;
    readIds.push(id);
    nodes.push({
      id,
      type: 'workflowNode',
      position: at(col, branchTops[i]),
      data: {
        kind: 'readSensor',
        sensor: c.sensor,
        icon: Settings,
        iconBg: 'bg-orange-50 dark:bg-orange-950/40',
        iconColor: 'text-orange-600 dark:text-orange-400',
      },
    });
    edges.push({ id: `e-trig-${i}`, source: triggerId, target: id });
  });
  col++;

  const conditionIds: string[] = [];
  spec.conditions.forEach((c, i) => {
    const id = `cond-${i}`;
    conditionIds.push(id);
    nodes.push({
      id,
      type: 'workflowNode',
      position: at(col, branchTops[i]),
      data: {
        kind: 'condition',
        sensor: c.sensor,
        operator: c.operator,
        value: c.value,
        icon: Flag,
        iconBg: 'bg-violet-50 dark:bg-violet-950/40',
        iconColor: 'text-violet-600 dark:text-violet-400',
      },
    });
    edges.push({ id: `e-read-${i}`, source: readIds[i], target: id });
  });
  col++;

  let upstreamIds = conditionIds;

  if (spec.guard) {
    const guardId = 'guard';
    nodes.push({
      id: guardId,
      type: 'workflowNode',
      position: at(col, centerTop),
      data: {
        kind: 'guard',
        field: spec.guard.field,
        value: spec.guard.value,
        icon: Settings,
        iconBg: 'bg-emerald-50 dark:bg-emerald-950/40',
        iconColor: 'text-emerald-600 dark:text-emerald-400',
      },
    });
    upstreamIds.forEach((id, i) => edges.push({ id: `e-guard-${i}`, source: id, target: guardId }));
    upstreamIds = [guardId];
    col++;
  }

  const gateId = 'gate';
  nodes.push({
    id: gateId,
    type: 'workflowNode',
    position: at(col, centerTop),
    data: {
      kind: 'gate',
      logic: spec.logic,
      icon: GitMerge,
      iconBg: 'bg-violet-50 dark:bg-violet-950/40',
      iconColor: 'text-violet-600 dark:text-violet-400',
    },
  });
  upstreamIds.forEach((id, i) => edges.push({ id: `e-gate-${i}`, source: id, target: gateId }));
  col++;

  spec.actions.forEach((action, i) => {
    const meta = ACTION_META[action];
    const id = `action-${i}`;
    nodes.push({
      id,
      type: 'workflowNode',
      position: at(col, actionTops[i]),
      data: {
        kind: 'action',
        actionType: action,
        icon: meta.icon,
        iconBg: 'bg-rose-50 dark:bg-rose-950/40',
        iconColor: 'text-rose-600 dark:text-rose-400',
      },
    });
    edges.push({ id: `e-act-${i}`, source: gateId, target: id });
  });

  return { nodes, edges };
}

/** Aggregates the graph by node kind — see the module comment for why this beats edge-walking. */
export function flowToSpec(nodes: WorkflowNode[], name: string): WorkflowSpec {
  const byY = (a: WorkflowNode, b: WorkflowNode) => a.position.y - b.position.y;

  const trigger = nodes.find((n) => n.data.kind === 'trigger');
  const conditions = nodes
    .filter((n) => n.data.kind === 'condition')
    .sort(byY)
    .map((n) => ({
      sensor: n.data.sensor ?? '',
      operator: (n.data.operator ?? '>') as WorkflowOperator,
      value: n.data.value ?? '',
    }));
  const guardNode = nodes.find((n) => n.data.kind === 'guard');
  const gateNode = nodes.find((n) => n.data.kind === 'gate');
  const actions = nodes
    .filter((n) => n.data.kind === 'action')
    .sort(byY)
    .map((n) => n.data.actionType)
    .filter((a): a is WorkflowActionType => !!a);

  return {
    name,
    scheduleLabel: trigger?.data.scheduleLabel ?? 'Every 5 minutes',
    conditions,
    guard: guardNode?.data.field ? { field: guardNode.data.field, value: guardNode.data.value ?? '' } : undefined,
    logic: gateNode?.data.logic ?? (conditions.length > 1 ? 'AND' : 'AND'),
    actions,
  };
}

export interface WorkflowValidation {
  ok: boolean;
  message: string;
  /** alerts-namespace key for `message`, with its interpolation values, so the
   *  editor can show it in the reader's language. */
  key: string;
  values?: Record<string, unknown>;
}

export function validateWorkflow(nodes: WorkflowNode[]): WorkflowValidation {
  const triggerCount = nodes.filter((n) => n.data.kind === 'trigger').length;
  if (triggerCount !== 1) {
    return { ok: false, message: `Needs exactly one trigger (found ${triggerCount})`, key: 'workflow.validation.oneTrigger', values: { count: triggerCount } };
  }

  const conditions = nodes.filter((n) => n.data.kind === 'condition');
  const incomplete = conditions.find((n) => !n.data.sensor?.trim() || !n.data.value?.trim());
  if (incomplete) return { ok: false, message: 'A condition is missing its sensor or threshold value', key: 'workflow.validation.incompleteCondition' };

  const actionCount = nodes.filter((n) => n.data.kind === 'action').length;
  if (actionCount === 0) return { ok: false, message: 'Needs at least one action', key: 'workflow.validation.noAction' };

  return { ok: true, message: 'Workflow validated', key: 'workflow.validation.ok' };
}

export interface PaletteItem {
  /** Stable id; the on-screen name is alerts:workflow.palette.<id>. */
  id: string;
  label: string;
  icon: React.FC<{ className?: string }>;
  kind: WorkflowNodeKind;
  actionType?: WorkflowActionType;
}

// `id` keys the on-screen names (alerts:workflow.section.<id> / workflow.palette.<id>);
// `label` stays English because it also keys drag-and-drop and seeds a processing node's title.
export const PALETTE_SECTIONS: { id: string; title: string; items: PaletteItem[] }[] = [
  { id: 'triggers', title: 'TRIGGERS', items: [{ id: 'schedule', label: 'Schedule', icon: Clock, kind: 'trigger' }] },
  {
    id: 'data',
    title: 'DATA',
    items: [
      { id: 'readSensor', label: 'Read Sensor', icon: Settings, kind: 'readSensor' },
      { id: 'databaseQuery', label: 'Database Query', icon: Database, kind: 'processing' },
    ],
  },
  {
    id: 'logic',
    title: 'LOGIC & PROCESSING',
    items: [
      { id: 'aggregate', label: 'Aggregate', icon: Sigma, kind: 'processing' },
      { id: 'calculation', label: 'Calculation', icon: Calculator, kind: 'processing' },
      { id: 'condition', label: 'Condition', icon: Flag, kind: 'condition' },
      { id: 'groupJoin', label: 'Group Join', icon: Link2, kind: 'processing' },
      { id: 'guard', label: 'Guard', icon: Settings, kind: 'guard' },
      { id: 'logicGate', label: 'Logic Gate', icon: GitMerge, kind: 'gate' },
    ],
  },
  {
    id: 'actions',
    title: 'ACTIONS',
    items: [
      { id: 'webhook', label: 'Webhook', icon: WebhookIcon, kind: 'action', actionType: 'Webhook' },
      { id: 'email', label: 'Email', icon: Mail, kind: 'action', actionType: 'Email' },
      { id: 'sms', label: 'SMS', icon: MessageSquare, kind: 'action', actionType: 'SMS' },
    ],
  },
];

const KIND_STYLE: Record<WorkflowNodeKind, { iconBg: string; iconColor: string }> = {
  trigger: { iconBg: 'bg-blue-50 dark:bg-blue-950/40', iconColor: 'text-blue-600 dark:text-blue-400' },
  readSensor: { iconBg: 'bg-orange-50 dark:bg-orange-950/40', iconColor: 'text-orange-600 dark:text-orange-400' },
  condition: { iconBg: 'bg-violet-50 dark:bg-violet-950/40', iconColor: 'text-violet-600 dark:text-violet-400' },
  guard: { iconBg: 'bg-emerald-50 dark:bg-emerald-950/40', iconColor: 'text-emerald-600 dark:text-emerald-400' },
  gate: { iconBg: 'bg-violet-50 dark:bg-violet-950/40', iconColor: 'text-violet-600 dark:text-violet-400' },
  action: { iconBg: 'bg-rose-50 dark:bg-rose-950/40', iconColor: 'text-rose-600 dark:text-rose-400' },
  processing: { iconBg: 'bg-slate-100 dark:bg-slate-800', iconColor: 'text-slate-500 dark:text-slate-400' },
};

export function createPaletteNode(item: PaletteItem, position: XYPosition): WorkflowNode {
  const style = KIND_STYLE[item.kind];
  const base = { id: nextId(item.kind), type: 'workflowNode' as const, position, data: { kind: item.kind, icon: item.icon, ...style } };

  switch (item.kind) {
    case 'trigger':
      return { ...base, data: { ...base.data, scheduleLabel: 'Every 5 minutes' } };
    case 'readSensor':
      return { ...base, data: { ...base.data, sensor: 'new_sensor' } };
    case 'condition':
      return { ...base, data: { ...base.data, sensor: 'new_sensor', operator: '>', value: '0' } };
    case 'guard':
      return { ...base, data: { ...base.data, field: 'maintenance_mode', value: 'OFF' } };
    case 'gate':
      return { ...base, data: { ...base.data, logic: 'AND' } };
    case 'action':
      return { ...base, data: { ...base.data, actionType: item.actionType ?? 'Webhook' } };
    case 'processing':
      return { ...base, data: { ...base.data, title: item.label } };
  }
}
