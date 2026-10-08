import React, { useCallback, useMemo, useRef, useState } from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  Panel,
  addEdge,
  useNodesState,
  useEdgesState,
  useReactFlow,
  type Connection,
  type Edge,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Input, SelectPicker } from 'rsuite';
import { Search, CheckCircle2, AlertTriangle } from 'lucide-react';
import { WorkflowSpec, WorkflowOperator, WorkflowActionType } from '../../utils/workflowParser';
import { FLEET } from '../../data/fleetMockData';
import { WorkflowFlowNode } from './workflow/WorkflowFlowNode';
import {
  specToFlow,
  flowToSpec,
  validateWorkflow,
  createPaletteNode,
  PALETTE_SECTIONS,
  type WorkflowNode,
  type WorkflowNodeData,
  type PaletteItem,
} from './workflow/workflowGraph';

interface WorkflowEditorProps {
  spec: WorkflowSpec;
  onDeploy: (spec: WorkflowSpec) => void;
}

const nodeTypes = { workflowNode: WorkflowFlowNode };

const paletteItemByKey = new Map<string, PaletteItem>(
  PALETTE_SECTIONS.flatMap((section) => section.items).map((item) => [`${item.kind}:${item.label}`, item]),
);

const WorkflowEditorInner: React.FC<WorkflowEditorProps> = ({ spec, onDeploy }) => {
  const [workflowName, setWorkflowName] = useState(spec.name);
  const [equipmentId, setEquipmentId] = useState(spec.equipmentId ?? '');
  const [statusNote, setStatusNote] = useState<{ message: string; tone: 'ok' | 'error' } | null>(null);
  const [paletteSearch, setPaletteSearch] = useState('');

  const initialGraph = useMemo(() => specToFlow(spec), [spec]);
  const [nodes, setNodes, onNodesChange] = useNodesState<WorkflowNode>(initialGraph.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(initialGraph.edges);

  const wrapperRef = useRef<HTMLDivElement>(null);
  const { screenToFlowPosition } = useReactFlow();

  const selectedNode = nodes.find((n) => n.selected) ?? null;

  const flash = (message: string, tone: 'ok' | 'error' = 'ok') => {
    setStatusNote({ message, tone });
    window.setTimeout(() => setStatusNote((cur) => (cur?.message === message ? null : cur)), 2400);
  };

  const onConnect = useCallback(
    (connection: Connection) => setEdges((eds) => addEdge(connection, eds)),
    [setEdges],
  );

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      const key = event.dataTransfer.getData('application/workflow-node');
      const item = paletteItemByKey.get(key);
      if (!item) return;
      const position = screenToFlowPosition({ x: event.clientX, y: event.clientY });
      setNodes((nds) => nds.concat(createPaletteNode(item, position)));
    },
    [screenToFlowPosition, setNodes],
  );

  const onDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  }, []);

  const updateSelectedNode = (patch: Partial<WorkflowNodeData>) => {
    if (!selectedNode) return;
    setNodes((nds) => nds.map((n) => (n.id === selectedNode.id ? { ...n, data: { ...n.data, ...patch } } : n)));
  };

  const handleValidate = () => {
    const result = validateWorkflow(nodes);
    flash(result.message, result.ok ? 'ok' : 'error');
  };

  const handleDeploy = () => {
    if (!equipmentId) {
      flash('Select the equipment this alert applies to', 'error');
      return;
    }
    const result = validateWorkflow(nodes);
    if (!result.ok) {
      flash(result.message, 'error');
      return;
    }
    onDeploy({ ...flowToSpec(nodes, workflowName), equipmentId });
  };

  const filteredSections = PALETTE_SECTIONS.map((section) => ({
    ...section,
    items: section.items.filter((item) => item.label.toLowerCase().includes(paletteSearch.toLowerCase())),
  })).filter((section) => section.items.length > 0);

  return (
    <div id="workflow-editor-view" className="space-y-4">
      {/* Toolbar */}
      <div className="bg-white dark:bg-slate-900 p-4 border border-slate-200 dark:border-slate-800 rounded-xl shadow-xs flex flex-col md:flex-row md:items-center justify-between gap-3">
        <div className="flex flex-col sm:flex-row sm:items-end gap-3 flex-1">
          <label className="block space-y-1 flex-1 min-w-[200px]">
            <span className="text-xs font-medium text-slate-600 dark:text-slate-300">Workflow name</span>
            <Input
              value={workflowName}
              onChange={(value) => setWorkflowName(value)}
              size="sm"
              className="w-full"
            />
          </label>
          <div className="block space-y-1 flex-1 min-w-[200px]">
            <span className="text-xs font-medium text-slate-600 dark:text-slate-300">Equipment</span>
            <SelectPicker
              data={FLEET.map((t) => ({ label: `${t.id} · ${t.name}`, value: t.id }))}
              value={equipmentId}
              onChange={(value) => setEquipmentId(value ?? '')}
              placeholder="Select equipment…"
              searchable={false}
              cleanable={false}
              size="sm"
              block
            />
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {statusNote && (
            <span
              className={`flex items-center gap-1.5 text-[11px] font-medium mr-1 ${
                statusNote.tone === 'ok' ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'
              }`}
            >
              {statusNote.tone === 'ok' ? <CheckCircle2 className="w-3.5 h-3.5" /> : <AlertTriangle className="w-3.5 h-3.5" />}
              {statusNote.message}
            </span>
          )}
          <button
            onClick={handleValidate}
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
            onClick={handleDeploy}
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
            <Input
              value={paletteSearch}
              onChange={(value) => setPaletteSearch(value)}
              placeholder="Search Nodes..."
              size="sm"
              className="pl-7!"
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
                  const key = `${item.kind}:${item.label}`;
                  return (
                    <button
                      key={key}
                      type="button"
                      draggable
                      onDragStart={(e) => {
                        e.dataTransfer.setData('application/workflow-node', key);
                        e.dataTransfer.effectAllowed = 'move';
                      }}
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
        <div ref={wrapperRef} className="flex-1 relative rounded-xl overflow-hidden border border-slate-200 dark:border-slate-800">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onDrop={onDrop}
            onDragOver={onDragOver}
            nodeTypes={nodeTypes}
            fitView
            minZoom={0.4}
            maxZoom={1.5}
            proOptions={{ hideAttribution: true }}
          >
            <Background variant={BackgroundVariant.Dots} gap={18} size={1} />
            <Controls showInteractive />
            <MiniMap pannable zoomable className="!bg-white dark:!bg-slate-800" />

            {selectedNode && (
              <Panel position="top-right">
                <NodeInspector node={selectedNode} onChange={updateSelectedNode} />
              </Panel>
            )}
          </ReactFlow>
        </div>
      </div>
    </div>
  );
};

const labelClass = 'text-[10px] font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500 block mb-1';

const NodeInspector: React.FC<{ node: WorkflowNode; onChange: (patch: Partial<WorkflowNodeData>) => void }> = ({
  node,
  onChange,
}) => {
  const { data } = node;

  return (
    <div className="w-64 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-md p-3.5 space-y-3">
      <div className="text-xs font-semibold text-slate-800 dark:text-slate-100 capitalize">{data.kind} node</div>

      {data.kind === 'trigger' && (
        <label className="block">
          <span className={labelClass}>Schedule</span>
          <Input
            size="sm"
            value={data.scheduleLabel ?? ''}
            onChange={(value) => onChange({ scheduleLabel: value })}
            placeholder="Every 5 minutes"
          />
        </label>
      )}

      {(data.kind === 'readSensor' || data.kind === 'condition') && (
        <label className="block">
          <span className={labelClass}>Sensor</span>
          <Input
            size="sm"
            value={data.sensor ?? ''}
            onChange={(value) => onChange({ sensor: value })}
            placeholder="converter_oil_temperature"
          />
        </label>
      )}

      {data.kind === 'condition' && (
        <>
          <div className="block">
            <span className={labelClass}>Operator</span>
            <SelectPicker
              data={(['>', '<', '>=', '<=', '='] as WorkflowOperator[]).map((op) => ({ label: op, value: op }))}
              value={data.operator ?? '>'}
              onChange={(value) => onChange({ operator: (value ?? '>') as WorkflowOperator })}
              searchable={false}
              cleanable={false}
              block
              size="sm"
            />
          </div>
          <label className="block">
            <span className={labelClass}>Threshold</span>
            <Input
              size="sm"
              value={data.value ?? ''}
              onChange={(value) => onChange({ value })}
              placeholder="80"
            />
          </label>
        </>
      )}

      {data.kind === 'guard' && (
        <>
          <label className="block">
            <span className={labelClass}>Field</span>
            <Input
              size="sm"
              value={data.field ?? ''}
              onChange={(value) => onChange({ field: value })}
              placeholder="maintenance_mode"
            />
          </label>
          <label className="block">
            <span className={labelClass}>Value</span>
            <Input
              size="sm"
              value={data.value ?? ''}
              onChange={(value) => onChange({ value })}
              placeholder="OFF"
            />
          </label>
        </>
      )}

      {data.kind === 'gate' && (
        <div className="block">
          <span className={labelClass}>Logic</span>
          <SelectPicker
            data={[{ label: 'AND', value: 'AND' }, { label: 'OR', value: 'OR' }]}
            value={data.logic ?? 'AND'}
            onChange={(value) => onChange({ logic: (value ?? 'AND') as 'AND' | 'OR' })}
            searchable={false}
            cleanable={false}
            block
            size="sm"
          />
        </div>
      )}

      {data.kind === 'action' && (
        <div className="block">
          <span className={labelClass}>Type</span>
          <SelectPicker
            data={(['Webhook', 'Email', 'SMS'] as WorkflowActionType[]).map((t) => ({ label: t, value: t }))}
            value={data.actionType ?? 'Webhook'}
            onChange={(value) => onChange({ actionType: (value ?? 'Webhook') as WorkflowActionType })}
            searchable={false}
            cleanable={false}
            block
            size="sm"
          />
        </div>
      )}

      {data.kind === 'processing' && (
        <label className="block">
          <span className={labelClass}>Label</span>
          <Input size="sm" value={data.title ?? ''} onChange={(value) => onChange({ title: value })} />
          <p className="text-[10px] text-slate-400 dark:text-slate-500 mt-1.5 leading-relaxed">
            Visual step only — not yet part of the saved alert logic.
          </p>
        </label>
      )}
    </div>
  );
};

export const WorkflowEditor: React.FC<WorkflowEditorProps> = (props) => (
  <ReactFlowProvider>
    <WorkflowEditorInner {...props} />
  </ReactFlowProvider>
);
