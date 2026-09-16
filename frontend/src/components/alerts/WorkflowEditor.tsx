import React, { useMemo, useState } from 'react';
import {
  Search,
  Clock,
  Database,
  Settings,
  Sigma,
  Calculator,
  Flag,
  Link2,
  GitMerge,
  Webhook as WebhookIcon,
  Mail,
  MessageSquare,
  Plus,
  Minus,
  Maximize,
  Lock,
  CheckCircle2,
} from 'lucide-react';
import { WorkflowSpec, WorkflowActionType } from '../../utils/workflowParser';

interface WorkflowEditorProps {
  spec: WorkflowSpec;
  onBack: () => void;
  onDeploy: (spec: WorkflowSpec) => void;
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

interface RenderNode {
  id: string;
  col: number;
  top: number;
  label: string;
  sublabel?: string;
  icon: React.FC<{ className?: string }>;
  iconBg: string;
  iconColor: string;
}

interface RenderEdge {
  id: string;
  fromId: string;
  toId: string;
  dotColor: string;
}

const ACTION_META: Record<WorkflowActionType, { icon: React.FC<{ className?: string }>; label: string }> = {
  Webhook: { icon: WebhookIcon, label: 'Webhook' },
  Email: { icon: Mail, label: 'Email' },
  SMS: { icon: MessageSquare, label: 'SMS' },
};

function buildGraph(spec: WorkflowSpec): { nodes: RenderNode[]; edges: RenderEdge[]; cols: number; rows: number } {
  const nodes: RenderNode[] = [];
  const edges: RenderEdge[] = [];
  const hasConditions = spec.conditions.length > 0;

  const maxRows = Math.max(spec.conditions.length, spec.actions.length, 1);
  const centerTop = ((maxRows - 1) / 2) * ROW_STEP;
  const branchTops = distributeCentered(spec.conditions.length, centerTop);
  const actionTops = distributeCentered(spec.actions.length, centerTop);

  let col = 0;
  const triggerId = 'trigger';
  nodes.push({
    id: triggerId,
    col,
    top: centerTop,
    label: 'Schedule',
    sublabel: spec.scheduleLabel,
    icon: Clock,
    iconBg: 'bg-blue-50 dark:bg-blue-950/40',
    iconColor: 'text-blue-600 dark:text-blue-400',
  });
  col++;

  if (!hasConditions) {
    return { nodes, edges, cols: col, rows: maxRows };
  }

  const readIds: string[] = [];
  spec.conditions.forEach((c, i) => {
    const id = `read-${i}`;
    readIds.push(id);
    nodes.push({
      id,
      col,
      top: branchTops[i],
      label: c.sensor,
      sublabel: c.sensor,
      icon: Settings,
      iconBg: 'bg-orange-50 dark:bg-orange-950/40',
      iconColor: 'text-orange-600 dark:text-orange-400',
    });
    edges.push({ id: `e-trig-${i}`, fromId: triggerId, toId: id, dotColor: 'bg-blue-500' });
  });
  col++;

  const conditionIds: string[] = [];
  spec.conditions.forEach((c, i) => {
    const id = `cond-${i}`;
    conditionIds.push(id);
    nodes.push({
      id,
      col,
      top: branchTops[i],
      label: c.sensor,
      sublabel: `${c.sensor} ${c.operator} ${c.value}`,
      icon: Flag,
      iconBg: 'bg-violet-50 dark:bg-violet-950/40',
      iconColor: 'text-violet-600 dark:text-violet-400',
    });
    edges.push({ id: `e-read-${i}`, fromId: readIds[i], toId: id, dotColor: 'bg-orange-500' });
  });
  col++;

  let upstreamIds = conditionIds;
  let upstreamDot = 'bg-violet-500';

  if (spec.guard) {
    const guardId = 'guard';
    nodes.push({
      id: guardId,
      col,
      top: centerTop,
      label: spec.guard.field,
      sublabel: spec.guard.field,
      icon: Settings,
      iconBg: 'bg-emerald-50 dark:bg-emerald-950/40',
      iconColor: 'text-emerald-600 dark:text-emerald-400',
    });
    upstreamIds.forEach((id, i) => edges.push({ id: `e-guard-${i}`, fromId: id, toId: guardId, dotColor: upstreamDot }));
    upstreamIds = [guardId];
    upstreamDot = 'bg-emerald-500';
    col++;
  }

  const gateId = 'gate';
  nodes.push({
    id: gateId,
    col,
    top: centerTop,
    label: spec.logic,
    sublabel: 'Expression',
    icon: GitMerge,
    iconBg: 'bg-violet-50 dark:bg-violet-950/40',
    iconColor: 'text-violet-600 dark:text-violet-400',
  });
  upstreamIds.forEach((id, i) => edges.push({ id: `e-gate-${i}`, fromId: id, toId: gateId, dotColor: upstreamDot }));
  col++;

  if (spec.actions.length > 0) {
    spec.actions.forEach((action, i) => {
      const meta = ACTION_META[action];
      const id = `action-${i}`;
      nodes.push({
        id,
        col,
        top: actionTops[i],
        label: meta.label,
        icon: meta.icon,
        iconBg: 'bg-rose-50 dark:bg-rose-950/40',
        iconColor: 'text-rose-600 dark:text-rose-400',
      });
      edges.push({ id: `e-act-${i}`, fromId: gateId, toId: id, dotColor: 'bg-violet-500' });
    });
    col++;
  }

  return { nodes, edges, cols: col, rows: maxRows };
}

const PALETTE_SECTIONS: { title: string; items: { label: string; icon: React.FC<{ className?: string }> }[] }[] = [
  { title: 'TRIGGERS', items: [{ label: 'Schedule', icon: Clock }] },
  { title: 'DATA', items: [{ label: 'Read Sensor', icon: Settings }, { label: 'Database Query', icon: Database }] },
  {
    title: 'LOGIC & PROCESSING',
    items: [
      { label: 'Aggregate', icon: Sigma },
      { label: 'Calculation', icon: Calculator },
      { label: 'Condition', icon: Flag },
      { label: 'Group Join', icon: Link2 },
    ],
  },
];

export const WorkflowEditor: React.FC<WorkflowEditorProps> = ({ spec, onBack, onDeploy }) => {
  const [workflowName, setWorkflowName] = useState(spec.name);
  const [zoom, setZoom] = useState(1);
  const [statusNote, setStatusNote] = useState<string | null>(null);
  const [paletteSearch, setPaletteSearch] = useState('');

  const { nodes, edges, cols } = useMemo(() => buildGraph(spec), [spec]);

  const colX = (col: number) => CANVAS_PAD + col * (NODE_W + COL_GAP);
  const topY = (top: number) => CANVAS_PAD + top;

  const allTops = nodes.map((n) => n.top);
  const canvasWidth = CANVAS_PAD * 2 + Math.max(cols, 1) * (NODE_W + COL_GAP) - COL_GAP;
  const canvasHeight = CANVAS_PAD * 2 + (Math.max(...allTops) - Math.min(...allTops)) + NODE_H;

  const filteredSections = PALETTE_SECTIONS.map((section) => ({
    ...section,
    items: section.items.filter((item) => item.label.toLowerCase().includes(paletteSearch.toLowerCase())),
  })).filter((section) => section.items.length > 0);

  const flash = (msg: string) => {
    setStatusNote(msg);
    window.setTimeout(() => setStatusNote((cur) => (cur === msg ? null : cur)), 2200);
  };

  return (
    <div id="workflow-editor-view" className="space-y-4">
      {/* Toolbar */}
      <div className="bg-white dark:bg-slate-900 p-4 border border-slate-200 dark:border-slate-800 rounded-xl shadow-xs flex flex-col md:flex-row md:items-center justify-between gap-3">
        <input
          type="text"
          value={workflowName}
          onChange={(e) => setWorkflowName(e.target.value)}
          className="px-3 py-2 bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 rounded-lg text-xs font-medium text-slate-800 dark:text-slate-100 focus:outline-none focus:border-sky-500 focus:ring-1 focus:ring-sky-500 transition-colors min-w-[260px]"
        />

        <div className="flex items-center gap-2 flex-wrap">
          {statusNote && (
            <span className="flex items-center gap-1.5 text-[11px] font-medium text-emerald-600 dark:text-emerald-400 mr-1">
              <CheckCircle2 className="w-3.5 h-3.5" />
              {statusNote}
            </span>
          )}
          <button
            onClick={() => flash('Workflow validated')}
            className="px-3.5 py-2 text-xs font-semibold text-slate-700 dark:text-slate-200 border border-slate-200 dark:border-slate-700 rounded-lg hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors cursor-pointer"
          >
            Validate
          </button>
          <button
            onClick={() => flash('Test run passed')}
            className="px-3.5 py-2 text-xs font-semibold text-slate-700 dark:text-slate-200 border border-slate-200 dark:border-slate-700 rounded-lg hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors cursor-pointer"
          >
            Test Rule
          </button>
          <button
            onClick={() => flash('Draft saved')}
            className="px-3.5 py-2 text-xs font-semibold text-slate-700 dark:text-slate-200 border border-slate-200 dark:border-slate-700 rounded-lg hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors cursor-pointer"
          >
            Save
          </button>
          <button
            onClick={() => onDeploy({ ...spec, name: workflowName })}
            className="px-4 py-2 bg-sky-600 hover:bg-sky-700 text-white rounded-lg text-xs font-semibold shadow-xs transition-colors cursor-pointer"
          >
            Update
          </button>
        </div>
      </div>

      {/* Palette + Canvas */}
      <div className="flex gap-4 h-[620px]">
        {/* Node Palette */}
        <div className="w-56 shrink-0 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 overflow-y-auto space-y-5">
          <div className="relative">
            <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={paletteSearch}
              onChange={(e) => setPaletteSearch(e.target.value)}
              placeholder="Search Nodes..."
              className="w-full pl-7 pr-2 py-1.5 bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 rounded-lg text-xs text-slate-800 dark:text-slate-100 placeholder-slate-400 focus:outline-none focus:border-sky-500 transition-colors"
            />
          </div>

          {filteredSections.map((section) => (
            <div key={section.title} className="space-y-2">
              <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500">
                {section.title}
              </div>
              <div className="space-y-1.5">
                {section.items.map((item) => {
                  const Icon = item.icon;
                  return (
                    <button
                      key={item.label}
                      type="button"
                      title="Drag onto the canvas to add this node"
                      className="w-full flex items-center gap-2.5 px-2.5 py-2 bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700 rounded-lg text-xs font-medium text-slate-700 dark:text-slate-200 hover:border-sky-300 dark:hover:border-sky-700 hover:bg-sky-50/50 dark:hover:bg-sky-950/20 transition-colors cursor-grab text-left"
                    >
                      <Icon className="w-3.5 h-3.5 text-slate-500 dark:text-slate-400 shrink-0" />
                      <span>{item.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>

        {/* Canvas */}
        <div className="flex-1 relative bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
          <div
            className="absolute inset-0 overflow-auto"
            style={{
              backgroundImage: 'radial-gradient(circle, rgb(203 213 225 / 0.6) 1px, transparent 1px)',
              backgroundSize: '18px 18px',
            }}
          >
            <div style={{ width: canvasWidth * zoom, height: canvasHeight * zoom }}>
              <div
                className="relative origin-top-left"
                style={{ width: canvasWidth, height: canvasHeight, transform: `scale(${zoom})` }}
              >
                <svg className="absolute inset-0 pointer-events-none" width={canvasWidth} height={canvasHeight}>
                  {edges.map((edge) => {
                    const from = nodes.find((n) => n.id === edge.fromId);
                    const to = nodes.find((n) => n.id === edge.toId);
                    if (!from || !to) return null;
                    const x1 = colX(from.col) + NODE_W;
                    const y1 = topY(from.top) + NODE_H / 2;
                    const x2 = colX(to.col);
                    const y2 = topY(to.top) + NODE_H / 2;
                    const mid = (x1 + x2) / 2;
                    return (
                      <path
                        key={edge.id}
                        d={`M ${x1},${y1} C ${mid},${y1} ${mid},${y2} ${x2},${y2}`}
                        fill="none"
                        stroke="currentColor"
                        strokeWidth={1.5}
                        className="text-slate-300 dark:text-slate-700"
                      />
                    );
                  })}
                </svg>

                {nodes.map((node) => {
                  const Icon = node.icon;
                  return (
                    <div
                      key={node.id}
                      className="absolute bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg shadow-xs px-3 py-2 flex items-center gap-2.5"
                      style={{ left: colX(node.col), top: topY(node.top), width: NODE_W, height: NODE_H }}
                    >
                      <div className={`w-7 h-7 rounded-md flex items-center justify-center shrink-0 ${node.iconBg}`}>
                        <Icon className={`w-3.5 h-3.5 ${node.iconColor}`} />
                      </div>
                      <div className="min-w-0">
                        <div className="text-xs font-semibold text-slate-800 dark:text-slate-100 truncate">
                          {node.label}
                        </div>
                        {node.sublabel && (
                          <div className="text-[10px] text-slate-500 dark:text-slate-400 truncate">
                            {node.sublabel}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}

                {nodes.length <= 1 && (
                  <div
                    className="absolute border-2 border-dashed border-slate-200 dark:border-slate-700 rounded-lg flex items-center justify-center text-xs text-slate-400 dark:text-slate-500"
                    style={{ left: colX(1), top: topY(0), width: NODE_W, height: NODE_H }}
                  >
                    Drag a node here
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Zoom Controls */}
          <div className="absolute bottom-4 left-4 z-10 flex flex-col gap-1 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg shadow-xs p-1">
            <button
              onClick={() => setZoom((z) => Math.min(1.5, Math.round((z + 0.1) * 10) / 10))}
              className="p-1.5 text-slate-500 hover:text-slate-800 dark:hover:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-700 rounded transition-colors cursor-pointer"
              title="Zoom In"
            >
              <Plus className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => setZoom((z) => Math.max(0.5, Math.round((z - 0.1) * 10) / 10))}
              className="p-1.5 text-slate-500 hover:text-slate-800 dark:hover:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-700 rounded transition-colors cursor-pointer"
              title="Zoom Out"
            >
              <Minus className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => setZoom(1)}
              className="p-1.5 text-slate-500 hover:text-slate-800 dark:hover:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-700 rounded transition-colors cursor-pointer"
              title="Reset Zoom"
            >
              <Maximize className="w-3.5 h-3.5" />
            </button>
            <button
              className="p-1.5 text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 rounded transition-colors cursor-pointer"
              title="Lock Canvas"
            >
              <Lock className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </div>

      <button
        type="button"
        onClick={onBack}
        className="text-xs text-slate-500 dark:text-slate-400 underline hover:text-slate-700 dark:hover:text-slate-200 transition-colors cursor-pointer"
      >
        ← Back to AI Assistant
      </button>
    </div>
  );
};
