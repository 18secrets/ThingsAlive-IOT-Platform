import React, { useCallback, useMemo, useState } from 'react';
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
import { Input, InputNumber, SelectPicker } from 'rsuite';
import { useTranslation } from 'react-i18next';
import { Search, CheckCircle2, AlertTriangle, Loader2 } from 'lucide-react';
import {
  ApiError, Workflow, WorkflowCompileResult, WorkflowNodeType, WorkflowScope, WorkflowVersion,
  apiCompileWorkflow, apiCreateWorkflow, apiNewWorkflowVersion, apiPublishWorkflow, apiReplaceWorkflowSpec,
  apiSetWorkflowLayout,
} from '../../lib/api';
import { WorkflowDraft, slugFor } from '../../utils/workflowParser';
import { Chip } from '../common/Chip';
import { WorkflowFlowNode } from './workflow/WorkflowFlowNode';
import {
  NODE_META,
  PALETTE_SECTIONS,
  createPaletteNode,
  flowLayout,
  flowToSpec,
  specToFlow,
  type WorkflowNode,
  type WorkflowParams,
} from './workflow/workflowGraph';
import { machineKey, useWorkflowScope } from './workflow/useWorkflowScope';

interface WorkflowEditorProps {
  draft: WorkflowDraft;
  /** After a publish: back to wherever the flow started. */
  onDone: () => void;
}

const nodeTypes = { workflowNode: WorkflowFlowNode };

const SEVERITIES = ['low', 'medium', 'high', 'critical'];
const READINESS_TONE = { ready: 'emerald', blocked: 'rose', not_configured: 'slate' } as const;

/** Where the editor's graph is stored once it has been saved at least once. */
interface Saved {
  workflowId: string;
  version: number;
  status: WorkflowVersion['status'];
}

/** The version to keep editing after a write: the draft if there is one, else the newest. */
function current(wf: Workflow): Saved {
  const v = wf.versions.find((x) => x.status === 'draft') ?? wf.versions[wf.versions.length - 1];
  return { workflowId: wf.id, version: v.version, status: v.status };
}

const WorkflowEditorInner: React.FC<WorkflowEditorProps> = ({ draft, onDone }) => {
  const { t } = useTranslation('alerts');
  const scopeData = useWorkflowScope();
  const [workflowName, setWorkflowName] = useState(draft.name);
  const [scope, setScope] = useState<WorkflowScope>(draft.spec.scope);
  const [saved, setSaved] = useState<Saved | null>(
    draft.workflowId && draft.version && draft.status ? { workflowId: draft.workflowId, version: draft.version, status: draft.status } : null,
  );
  const [busy, setBusy] = useState<'save' | 'check' | 'publish' | null>(null);
  const [statusNote, setStatusNote] = useState<{ message: string; tone: 'ok' | 'error' } | null>(null);
  const [result, setResult] = useState<WorkflowCompileResult | null>(null);
  const [paletteSearch, setPaletteSearch] = useState('');

  const initialGraph = useMemo(() => specToFlow(draft.spec, draft.layout), [draft]);
  const [nodes, setNodes, onNodesChange] = useNodesState<WorkflowNode>(initialGraph.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(initialGraph.edges);
  const { screenToFlowPosition } = useReactFlow();

  const selectedNode = nodes.find((n) => n.selected) ?? null;
  const signals = scopeData.signalsFor(scope);

  const onConnect = useCallback((connection: Connection) => setEdges((eds) => addEdge(connection, eds)), [setEdges]);

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      const type = event.dataTransfer.getData('application/workflow-node') as WorkflowNodeType;
      if (!NODE_META[type]) return;
      setNodes((nds) => nds.concat(createPaletteNode(type, screenToFlowPosition({ x: event.clientX, y: event.clientY }))));
    },
    [screenToFlowPosition, setNodes],
  );

  const onDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  }, []);

  const updateSelectedParams = (patch: WorkflowParams) => {
    if (!selectedNode) return;
    setNodes((nds) => nds.map((n) => (n.id === selectedNode.id ? { ...n, data: { ...n.data, params: { ...n.data.params, ...patch } } } : n)));
  };
  const setSelectedType = (type: WorkflowNodeType) => {
    if (!selectedNode) return;
    setNodes((nds) => nds.map((n) => (n.id === selectedNode.id ? { ...n, data: { ...n.data, type } } : n)));
  };

  const fail = (err: unknown) => setStatusNote({ message: err instanceof Error ? err.message : String(err), tone: 'error' });

  /**
   * Stores the graph and returns where it is. The first save creates the workflow; a
   * draft is replaced in place; a published or retired version is never edited, so a
   * new draft is started from it and the change lands there.
   */
  const save = async (): Promise<Saved> => {
    const spec = flowToSpec(nodes, edges, scope);
    let at: Saved;
    if (!saved) {
      at = current(await apiCreateWorkflow({
        slug: slugFor(workflowName), name: workflowName.trim() || 'Alert workflow', spec,
        ...(draft.description ? { description: draft.description } : {}),
      }));
    } else if (saved.status === 'draft') {
      at = current(await apiReplaceWorkflowSpec(saved.workflowId, saved.version, spec));
    } else {
      const next = current(await apiNewWorkflowVersion(saved.workflowId));
      at = current(await apiReplaceWorkflowSpec(next.workflowId, next.version, spec));
    }
    await apiSetWorkflowLayout(at.workflowId, at.version, flowLayout(nodes));
    setSaved(at);
    return at;
  };

  const run = async (what: 'save' | 'check' | 'publish') => {
    setBusy(what);
    setStatusNote(null);
    let at: Saved | null = null;
    try {
      at = await save();
      if (what === 'save') {
        setStatusNote({ message: t('workflow.saved', { version: at.version }), tone: 'ok' });
      } else if (what === 'check') {
        const compiled = await apiCompileWorkflow(at.workflowId, at.version);
        setResult(compiled);
        setStatusNote(compiled.publishRefusal
          ? { message: t('workflow.wouldBeRefused'), tone: 'error' }
          : { message: t('workflow.checkPassed', { count: compiled.rules.length }), tone: 'ok' });
      } else {
        await apiPublishWorkflow(at.workflowId, at.version);
        onDone();
      }
    } catch (err) {
      // A refused publish says why; the readiness that explains it comes from a check.
      if (what === 'publish' && err instanceof ApiError && err.status === 409 && at) {
        apiCompileWorkflow(at.workflowId, at.version).then(setResult).catch(() => undefined);
      }
      fail(err);
    } finally {
      setBusy(null);
    }
  };

  const filteredSections = PALETTE_SECTIONS.map((section) => ({
    ...section,
    items: section.items.filter((type) => t(`workflow.palette.${type}`).toLowerCase().includes(paletteSearch.toLowerCase())),
  })).filter((section) => section.items.length > 0);

  const scopeTargets = (() => {
    switch (scope.appliesTo) {
      case 'equipment': return scopeData.machines.map((m) => ({ label: scopeData.machineLabel(m), value: machineKey(m) }));
      case 'plant': return scopeData.plants.map((p) => ({ label: `${p.code} · ${p.name}`, value: p.id }));
      case 'equipment-class': return scopeData.classes.map((c) => ({ label: c.name, value: c.slug }));
      default: return [];
    }
  })();
  const scopeValue = scope.appliesTo === 'equipment' && scope.sourceSystem ? `${scope.sourceSystem}|${scope.externalId}`
    : scope.appliesTo === 'plant' ? scope.plantId ?? null
      : scope.appliesTo === 'equipment-class' ? scope.equipmentClassSlug ?? null : null;
  const setScopeTarget = (value: string | null) => {
    if (scope.appliesTo === 'equipment') {
      const [sourceSystem, externalId] = (value ?? '|').split('|');
      setScope({ appliesTo: 'equipment', sourceSystem: sourceSystem || null, externalId: externalId || null });
    } else if (scope.appliesTo === 'plant') setScope({ appliesTo: 'plant', plantId: value });
    else if (scope.appliesTo === 'equipment-class') setScope({ appliesTo: 'equipment-class', equipmentClassSlug: value });
  };

  const buttonClass = 'px-3.5 py-2 text-xs font-semibold text-slate-700 dark:text-slate-200 border border-slate-200 dark:border-slate-700 rounded-lg hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-40 transition-colors cursor-pointer flex items-center gap-1.5';

  return (
    <div id="workflow-editor-view" className="space-y-4">
      {/* Toolbar */}
      <div className="bg-white dark:bg-slate-900 p-4 border border-slate-200 dark:border-slate-800 rounded-xl shadow-xs space-y-3">
        <div className="flex flex-col lg:flex-row lg:items-end gap-3">
          <label className="block space-y-1 flex-1 min-w-[200px]">
            <span className="text-xs font-medium text-slate-600 dark:text-slate-300">{t('workflow.name')}</span>
            <Input value={workflowName} onChange={(value) => setWorkflowName(value)} size="sm" className="w-full" disabled={!!saved} />
          </label>
          <div className="block space-y-1 min-w-[160px]">
            <span className="text-xs font-medium text-slate-600 dark:text-slate-300">{t('workflow.scope.label')}</span>
            <SelectPicker
              data={(['equipment', 'plant', 'equipment-class', 'account'] as const).map((a) => ({ label: t(`workflow.scope.${a}`), value: a }))}
              value={scope.appliesTo}
              onChange={(value) => setScope({ appliesTo: value ?? 'equipment' })}
              searchable={false}
              cleanable={false}
              size="sm"
              block
            />
          </div>
          {scope.appliesTo !== 'account' && (
            <div className="block space-y-1 flex-1 min-w-[200px]">
              <span className="text-xs font-medium text-slate-600 dark:text-slate-300">{t(`workflow.scope.pick.${scope.appliesTo}`)}</span>
              <SelectPicker data={scopeTargets} value={scopeValue} onChange={setScopeTarget} size="sm" block />
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-2 text-[11px] text-slate-500 dark:text-slate-400">
            {saved
              ? <Chip tone={saved.status === 'published' ? 'emerald' : saved.status === 'draft' ? 'amber' : 'slate'}>
                  {t(`workflow.versionStatus.${saved.status}`, { version: saved.version })}
                </Chip>
              : <Chip tone="slate">{t('workflow.notSaved')}</Chip>}
            {statusNote && (
              <span className={`flex items-center gap-1.5 font-medium ${statusNote.tone === 'ok' ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'}`}>
                {statusNote.tone === 'ok' ? <CheckCircle2 className="w-3.5 h-3.5" /> : <AlertTriangle className="w-3.5 h-3.5" />}
                {statusNote.message}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => run('save')} disabled={busy !== null} className={buttonClass}>
              {busy === 'save' && <Loader2 className="w-3.5 h-3.5 animate-spin" />}{t('workflow.saveDraft')}
            </button>
            <button onClick={() => run('check')} disabled={busy !== null} className={buttonClass}>
              {busy === 'check' && <Loader2 className="w-3.5 h-3.5 animate-spin" />}{t('workflow.validate')}
            </button>
            <button
              onClick={() => run('publish')}
              disabled={busy !== null}
              className="px-4 py-2 bg-sky-600 hover:bg-sky-700 disabled:opacity-40 text-white rounded-lg text-xs font-semibold shadow-xs transition-colors cursor-pointer flex items-center gap-1.5"
            >
              {busy === 'publish' && <Loader2 className="w-3.5 h-3.5 animate-spin" />}{t('workflow.publish')}
            </button>
          </div>
        </div>
      </div>

      {draft.notes && draft.notes.length > 0 && (
        <div className="rounded-xl border border-amber-200 dark:border-amber-900/50 bg-amber-50 dark:bg-amber-950/30 px-4 py-3 text-xs text-amber-800 dark:text-amber-200 space-y-1">
          {draft.notes.map((n, i) => <p key={i} className="flex items-start gap-1.5"><AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />{n}</p>)}
        </div>
      )}

      {/* Palette + Canvas */}
      <div className="flex gap-4 h-[620px]">
        <div className="w-56 shrink-0 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 overflow-y-auto space-y-5">
          <div className="relative">
            <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
            <Input value={paletteSearch} onChange={(value) => setPaletteSearch(value)} placeholder={t('workflow.searchNodes')} size="sm" className="pl-7!" />
          </div>

          {filteredSections.map((section) => (
            <div key={section.id} className="space-y-2">
              <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500">
                {t(`workflow.section.${section.id}`)}
              </div>
              <div className="space-y-1.5">
                {section.items.map((type) => {
                  const Icon = NODE_META[type].icon;
                  return (
                    <button
                      key={type}
                      type="button"
                      draggable
                      onDragStart={(e) => {
                        e.dataTransfer.setData('application/workflow-node', type);
                        e.dataTransfer.effectAllowed = 'move';
                      }}
                      title={t(`workflow.paletteHint.${type}`)}
                      className="w-full flex items-center gap-2.5 px-2.5 py-2 bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700 rounded-lg text-xs font-medium text-slate-700 dark:text-slate-200 hover:border-sky-300 dark:hover:border-sky-700 hover:bg-sky-50/50 dark:hover:bg-sky-950/20 transition-colors cursor-grab text-left"
                    >
                      <Icon className="w-3.5 h-3.5 text-slate-500 dark:text-slate-400 shrink-0" />
                      <span>{t(`workflow.palette.${type}`)}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
          <p className="text-[10px] text-slate-400 dark:text-slate-500 leading-relaxed">{t('workflow.dragHint')}</p>
        </div>

        <div className="flex-1 relative rounded-xl overflow-hidden border border-slate-200 dark:border-slate-800">
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
                <NodeInspector node={selectedNode} signals={signals} onParams={updateSelectedParams} onType={setSelectedType} />
              </Panel>
            )}
          </ReactFlow>
        </div>
      </div>

      {result && <CompilePanel result={result} />}
    </div>
  );
};

/** What a check said: the rules in words, whether each machine could fire, and why not. */
const CompilePanel: React.FC<{ result: WorkflowCompileResult }> = ({ result }) => {
  const { t } = useTranslation('alerts');
  return (
    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-xs p-4 space-y-4">
      {result.publishRefusal && (
        <div className="rounded-lg border border-amber-200 dark:border-amber-900/50 bg-amber-50 dark:bg-amber-950/30 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
          {result.publishRefusal}
        </div>
      )}
      <div>
        <h3 className="text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-2">{t('workflow.result.rules')}</h3>
        <ul className="space-y-1 text-sm text-slate-700 dark:text-slate-200 list-disc pl-5">
          {result.rendering.map((line, i) => <li key={i}>{line}</li>)}
        </ul>
      </div>
      <div>
        <h3 className="text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-2">{t('workflow.result.machines')}</h3>
        {result.readiness.length === 0 ? (
          <p className="text-xs text-slate-400">{t('workflow.result.noMachines')}</p>
        ) : (
          <div className="space-y-1.5">
            {result.readiness.map((r) => (
              <div key={`${r.machine.sourceSystem}|${r.machine.externalId}`} className="flex items-center justify-between gap-3 text-xs">
                <span className="text-slate-700 dark:text-slate-200 truncate">{r.machine.externalId}{r.machine.name ? ` · ${r.machine.name}` : ''}</span>
                <div className="flex items-center gap-2 flex-wrap justify-end">
                  {r.signals.filter((s) => s.reason).map((s) => (
                    <span key={s.signal} className="text-[11px] text-slate-500 dark:text-slate-400">
                      {t('workflow.result.signalReason', { signal: s.signal, reason: t(`workflow.result.reason.${s.reason}`) })}
                    </span>
                  ))}
                  <Chip tone={READINESS_TONE[r.state]}>{t(`workflow.result.state.${r.state}`)}</Chip>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

const labelClass = 'text-[10px] font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500 block mb-1';

const NumberField: React.FC<{ label: string; value: unknown; onChange: (v: number | null) => void; hint?: string }> = ({ label, value, onChange, hint }) => (
  <label className="block">
    <span className={labelClass}>{label}</span>
    <InputNumber
      size="sm"
      value={typeof value === 'number' ? value : null}
      onChange={(v) => onChange(v === null || v === '' ? null : Number(v))}
    />
    {hint && <p className="text-[10px] text-slate-400 dark:text-slate-500 mt-1 leading-relaxed">{hint}</p>}
  </label>
);

const TextField: React.FC<{ label: string; value: unknown; onChange: (v: string) => void; placeholder?: string }> = ({ label, value, onChange, placeholder }) => (
  <label className="block">
    <span className={labelClass}>{label}</span>
    <Input size="sm" value={typeof value === 'string' ? value : ''} onChange={onChange} placeholder={placeholder} />
  </label>
);

const NodeInspector: React.FC<{
  node: WorkflowNode;
  signals: string[];
  onParams: (patch: WorkflowParams) => void;
  onType: (type: WorkflowNodeType) => void;
}> = ({ node, signals, onParams, onType }) => {
  const { t } = useTranslation('alerts');
  const { type, params } = node.data;
  const pick = (values: string[], keyPrefix: string) => values.map((v) => ({ label: t(`${keyPrefix}.${v}`, { defaultValue: v }), value: v }));
  // A signal typed or assembled before the scope changed still shows, so it can be seen and replaced.
  const signalOptions = [...new Set([...(params.signal ? [String(params.signal)] : []), ...signals])].map((s) => ({ label: s, value: s }));

  return (
    <div className="w-64 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-md p-3.5 space-y-3 max-h-[560px] overflow-y-auto">
      <div className="text-xs font-semibold text-slate-800 dark:text-slate-100">{t(`workflow.palette.${type}`)}</div>
      <p className="text-[10px] text-slate-400 dark:text-slate-500 leading-relaxed">{t(`workflow.paletteHint.${type}`)}</p>

      {type === 'ReadSignal' && (
        <div className="block">
          <span className={labelClass}>{t('workflow.inspector.signal')}</span>
          <SelectPicker data={signalOptions} value={(params.signal as string) || null} onChange={(v) => onParams({ signal: v ?? '' })} block size="sm" />
          {signals.length === 0 && <p className="text-[10px] text-amber-600 dark:text-amber-400 mt-1">{t('workflow.inspector.noSignals')}</p>}
        </div>
      )}

      {type === 'Threshold' && (
        <>
          <NumberField label={t('workflow.inspector.above')} value={params.max} onChange={(v) => onParams({ max: v })} />
          <NumberField label={t('workflow.inspector.below')} value={params.min} onChange={(v) => onParams({ min: v })} />
          <NumberField label={t('workflow.inspector.lookback')} value={params.lookbackReadings} onChange={(v) => onParams({ lookbackReadings: v })} hint={t('workflow.inspector.lookbackHint')} />
          <NumberField label={t('workflow.inspector.required')} value={params.requiredBreaches} onChange={(v) => onParams({ requiredBreaches: v })} hint={t('workflow.inspector.requiredHint')} />
        </>
      )}

      {type === 'PredictionSeverity' && (
        <>
          <div className="block">
            <span className={labelClass}>{t('workflow.inspector.atLeast')}</span>
            <SelectPicker data={pick(SEVERITIES, 'workflow.severity')} value={(params.atLeast as string) ?? 'high'} onChange={(v) => onParams({ atLeast: v ?? 'high' })} searchable={false} cleanable={false} block size="sm" />
          </div>
          <TextField label={t('workflow.inspector.scenario')} value={params.clientScenarioSlug} onChange={(v) => onParams({ clientScenarioSlug: v })} placeholder={t('workflow.inspector.optional')} />
        </>
      )}

      {type === 'FuelLoss' && (
        <>
          <NumberField label={t('workflow.inspector.dropAtLeast')} value={params.dropAtLeast} onChange={(v) => onParams({ dropAtLeast: v })} />
          <NumberField label={t('workflow.inspector.withinMinutes')} value={params.withinMinutes} onChange={(v) => onParams({ withinMinutes: v })} />
          <NumberField label={t('workflow.inspector.movementTolerance')} value={params.movementTolerance} onChange={(v) => onParams({ movementTolerance: v })} hint={t('workflow.inspector.optional')} />
        </>
      )}

      {type === 'ChainOrigin' && (
        <>
          <div className="block">
            <span className={labelClass}>{t('workflow.inspector.atLeast')}</span>
            <SelectPicker data={pick(['warning', 'critical'], 'workflow.chainLevel')} value={(params.atLeast as string) ?? 'warning'} onChange={(v) => onParams({ atLeast: v ?? 'warning' })} searchable={false} cleanable={false} block size="sm" />
          </div>
          <TextField label={t('workflow.inspector.chain')} value={params.chainSlug} onChange={(v) => onParams({ chainSlug: v })} placeholder={t('workflow.inspector.optional')} />
          <TextField label={t('workflow.inspector.stage')} value={params.stageSignal} onChange={(v) => onParams({ stageSignal: v })} placeholder={t('workflow.inspector.optional')} />
        </>
      )}

      {(type === 'AllOf' || type === 'AnyOf') && (
        <div className="block">
          <span className={labelClass}>{t('workflow.inspector.logic')}</span>
          <SelectPicker data={pick(['AllOf', 'AnyOf'], 'workflow.palette')} value={type} onChange={(v) => onType((v ?? 'AllOf') as WorkflowNodeType)} searchable={false} cleanable={false} block size="sm" />
        </div>
      )}

      {type === 'Notify' && (
        <>
          <TextField label={t('workflow.inspector.alertName')} value={params.name} onChange={(v) => onParams({ name: v })} />
          <div className="block">
            <span className={labelClass}>{t('workflow.inspector.severity')}</span>
            <SelectPicker data={pick(SEVERITIES, 'workflow.severity')} value={(params.severity as string) ?? 'high'} onChange={(v) => onParams({ severity: v ?? 'high' })} searchable={false} cleanable={false} block size="sm" />
          </div>
          <TextField label={t('workflow.inspector.description')} value={params.description} onChange={(v) => onParams({ description: v })} placeholder={t('workflow.inspector.optional')} />
        </>
      )}
    </div>
  );
};

export const WorkflowEditor: React.FC<WorkflowEditorProps> = (props) => (
  <ReactFlowProvider>
    <WorkflowEditorInner {...props} />
  </ReactFlowProvider>
);
