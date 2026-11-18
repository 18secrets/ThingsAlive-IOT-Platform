import React, { useEffect, useMemo, useState } from 'react';
import {
  Sparkles,
  Mic,
  Search,
  ChevronRight,
  Plus,
  ListChecks,
  Check,
  FilePen,
  Cpu,
  Clock,
} from 'lucide-react';
import { Input, SelectPicker } from 'rsuite';
import { useTranslation } from 'react-i18next';
import { WorkflowDraft, parsePromptToWorkflow, mentionsSensorKeyword } from '../../utils/workflowParser';
import { ApiError, Workflow, WorkflowScope, apiAssembleWorkflow, apiListWorkflows, apiProposeWorkflow, needsInput } from '../../lib/api';
import { useNavigate } from 'react-router-dom';
import { completeAssembled, starterSpec } from './workflow/workflowGraph';
import { machineKey, useWorkflowScope } from './workflow/useWorkflowScope';
import { Chip } from '../common/Chip';
import { severityTone } from '../common/statusTone';
import { appLocale, appTimeZone } from '../../lib/dateLocale';

interface AlertAIAssistantProps {
  onGenerate: (draft: WorkflowDraft) => void;
  /** "Explore more": every draft in the alert list, filtered to drafts, with the search carried over. */
  onExploreDrafts?: (search: string) => void;
  /** False while a workflow opened from here is on screen; the assistant stays mounted, hidden. */
  visible?: boolean;
}

type StatusState = 'done' | 'active' | 'pending';

/** Drafts shown on the card; the rest are a click away in the full list. */
const DRAFTS_SHOWN = 6;

// Kept in English on purpose: the text is fed straight to parsePromptToWorkflow,
// which only understands English. The tags are display-only and are translated.
/**
 * Example prompts. Only those whose every condition names a signal the chosen machine
 * declares are offered (17 Nov): a pump was offered "pump energy consumption" and
 * "battery voltage", and the server refused the draft for a signal its class does not
 * have. So the list holds examples for pumps and for vehicles both, and filters.
 */
const QUICK_EXAMPLES: { text: string; tags: string[] }[] = [
  { text: 'Warn me when supply voltage drops below 190 V', tags: ['voltage', 'pump', 'warning'] },
  { text: 'Alert me if supply voltage goes above 250 V', tags: ['voltage', 'pump', 'safety'] },
  { text: 'Raise an alarm when motor temperature is above 75 C', tags: ['temperature', 'pump', 'alert'] },
  { text: 'Notify me when vibration velocity goes above 7 mm/s', tags: ['vibration', 'pump', 'warning'] },
  { text: 'Alert me if motor current goes above 8 A', tags: ['current', 'pump', 'alert'] },
  { text: 'Warn me when engine coolant temperature is above 105 C', tags: ['temperature', 'engine', 'warning'] },
  { text: 'Alert me when engine oil pressure drops below 150 kPa', tags: ['pressure', 'engine', 'safety'] },
  { text: 'Notify me if hydraulic oil temperature goes above 90 C', tags: ['temperature', 'hydraulic', 'alert'] },
  { text: 'Notify me if pump energy consumption spikes above 55kWh in a 1 hour window', tags: ['energy', 'efficiency', 'alert'] },
  { text: 'Warn me when battery voltage drops below 11.5V for more than 3 minutes', tags: ['battery', 'voltage', 'warning'] },
];

// Labels live in the alerts namespace under assistant.steps.<id>.
const CREATION_STEPS = ['understand', 'sensors', 'conditions', 'actions', 'ready'] as const;

const STATUS_BADGE_STYLES: Record<StatusState, string> = {
  done: 'text-emerald-600 dark:text-emerald-400',
  active: 'text-sky-600 dark:text-sky-400',
  pending: 'text-slate-400 dark:text-slate-500',
};

const STATUS_CARD_STYLES: Record<StatusState, string> = {
  done: 'bg-emerald-50 dark:bg-emerald-950/30 border-emerald-200 dark:border-emerald-900/50',
  active: 'bg-sky-50 dark:bg-sky-950/30 border-sky-300 dark:border-sky-800',
  pending: 'bg-slate-50 dark:bg-slate-800/40 border-slate-200 dark:border-slate-800',
};

export const AlertAIAssistant: React.FC<AlertAIAssistantProps> = ({ onGenerate, onExploreDrafts, visible = true }) => {
  const { t } = useTranslation('alerts');
  const scopeData = useWorkflowScope();
  const [prompt, setPrompt] = useState('');
  const [equipmentId, setEquipmentId] = useState('');
  const [phase, setPhase] = useState<'suggest' | 'clarifying'>('suggest');
  const [searchTerm, setSearchTerm] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const canAct = !!equipmentId;
  const [modeCode, setModeCode] = useState<string | null>(null);
  const [combine, setCombine] = useState<'allOf' | 'anyOf'>('allOf');
  const [assembling, setAssembling] = useState(false);
  const [assembleError, setAssembleError] = useState<string | null>(null);
  const [proposing, setProposing] = useState(false);
  const [proposeMissing, setProposeMissing] = useState<string[]>([]);
  const navigate = useNavigate();

  // The chosen machine's failure modes, from its class in this account's catalog.
  const failureModes = useMemo(() => {
    const [sourceSystem, externalId] = equipmentId.split('|');
    const machine = scopeData.machines.find((m) => m.sourceSystem === sourceSystem && m.externalId === externalId);
    return scopeData.classes.find((c) => c.slug === machine?.equipmentClassSlug)?.failureModes ?? [];
  }, [equipmentId, scopeData.machines, scopeData.classes]);
  const chosenMode = failureModes.find((f) => f.code === modeCode) ?? null;

  // Read again each time it is shown, not once: it stays mounted while a workflow opened
  // from it is edited, and a draft saved there was missing until a reload (17 Nov).
  useEffect(() => {
    if (!visible) return;
    apiListWorkflows().then(setWorkflows).catch(() => setWorkflows([]));
  }, [visible]);

  const scope = (): WorkflowScope => {
    const [sourceSystem, externalId] = equipmentId.split('|');
    return { appliesTo: 'equipment', sourceSystem, externalId };
  };

  const runPrompt = (text: string) => {
    if (!canAct) return;
    const parsed = parsePromptToWorkflow(text, scope(), scopeData.signalsFor(scope()), undefined, scopeData.unitsFor(scope()));
    // A rule that can never fire is not built (the AI alert prompt test log, S.NO 10–11).
    if (parsed.contradictions.length) {
      setPrompt(text);
      setPhase('clarifying');
      setNotice(parsed.contradictions.map((c) => t('assistant.parse.contradiction', { ...c })).join(' '));
      return;
    }
    if (parsed.conditions > 0) {
      // Said on the canvas: a phrase naming no signal on this machine is kept as typed and
      // the server refuses it, so the person picks the signal rather than a guess (MIN-9);
      // and what the reader changed or could not honour — a unit converted, a count dropped.
      const notes = [
        ...parsed.unmatched.map((what) => t('assistant.unmatchedSignal', { what })),
        ...parsed.notes.map((n) => t(`assistant.parse.${n.key}`, n.values)),
      ];
      onGenerate(notes.length ? { ...parsed.draft, notes } : parsed.draft);
      return;
    }
    setPrompt(text);
    setPhase('clarifying');
    // Say why nothing was built, always: it sat on "Identifying sensors" with no word
    // (S.NO 9, 12, 18, 20), and the person could not tell what to change.
    setNotice(parsed.unsupported.length ? t('assistant.unsupportedChange', { what: parsed.unsupported.join(', ') }) : t('assistant.parse.nothingFound'));
  };

  const handleGenerate = () => {
    const text = prompt.trim();
    if (!text) return;
    runPrompt(text);
  };

  /**
   * The library's own answer for a failure mode (POST /workflows/assemble): a condition
   * per signal a copied template watches, with that template's threshold. A signal no
   * template watches comes back unresolved and goes into the editor with its threshold
   * blank, named in a note, for the person to set.
   */
  const handleAssemble = async () => {
    if (!canAct || !chosenMode) return;
    setAssembling(true);
    setAssembleError(null);
    try {
      const result = await apiAssembleWorkflow({ target: scope(), failureModeCode: chosenMode.code, combine });
      const unresolvedSignals = result.unresolved.map((u) => u.signal).filter((x): x is string => !!x);
      const spec = completeAssembled(result.spec, unresolvedSignals, { name: chosenMode.name, combine });
      const notes = [
        ...(unresolvedSignals.length ? [t('assistant.assembleNoTemplate', { signals: unresolvedSignals.join(', ') })] : []),
        ...result.unresolved.filter((u) => !u.signal).map((u) => u.detail),
      ];
      onGenerate({ name: chosenMode.name, description: chosenMode.symptom, spec, notes });
    } catch (err) {
      setAssembleError(err instanceof ApiError ? err.message : t('assistant.assembleFailed'));
    } finally {
      setAssembling(false);
    }
  };

  /**
   * The same selection as a generated draft (QGEN3): replayed over 90 days on the machine
   * and held for the super admin's approval, instead of opened straight in the editor.
   * The key makes a double click return the one draft rather than two.
   */
  const handlePropose = async () => {
    if (!canAct || !chosenMode) return;
    setProposing(true);
    setAssembleError(null);
    setProposeMissing([]);
    try {
      const result = await apiProposeWorkflow({
        intent: 'watch-failure-mode', target: scope(), failureModeCode: chosenMode.code, combine, name: chosenMode.name,
        idempotencyKey: `wf-${equipmentId}-${chosenMode.code}-${combine}-${Date.now()}`,
      });
      if (needsInput(result)) setProposeMissing(result.missing.map((m) => m.detail));
      else navigate(`/drafts?id=${result.id}`);
    } catch (err) {
      setAssembleError(err instanceof ApiError ? err.message : t('assistant.proposeFailed'));
    } finally {
      setProposing(false);
    }
  };

  const handleCreateCustom = () => {
    if (!canAct) return;
    const name = t('assistant.customName');
    onGenerate({ name, spec: starterSpec(scope(), scopeData.signalsFor(scope())[0] ?? '', name) });
  };

  // The examples this machine can take: every condition parsed, every one a signal it declares.
  const examples = useMemo(() => {
    if (!canAct) return QUICK_EXAMPLES;
    const declared = scopeData.signalsFor(scope());
    const units = scopeData.unitsFor(scope());
    return QUICK_EXAMPLES.filter((ex) => {
      const parsed = parsePromptToWorkflow(ex.text, scope(), declared, undefined, units);
      return parsed.conditions > 0 && parsed.unmatched.length === 0 && parsed.unsupported.length === 0
        && parsed.contradictions.length === 0 && !parsed.notes.some((n) => n.key === 'unitMismatch');
    });
  }, [canAct, equipmentId, scopeData]); // eslint-disable-line react-hooks/exhaustive-deps

  const steps = useMemo(() => {
    const sensorsFound = mentionsSensorKeyword(prompt);
    return CREATION_STEPS.map((id) => {
      let status: StatusState = 'pending';
      if (id === 'understand') status = sensorsFound ? 'done' : 'active';
      if (id === 'sensors') status = sensorsFound ? 'active' : 'pending';
      return { id, status };
    });
  }, [prompt]);

  // Workflows whose newest version is still a draft: started here or in the editor, never published.
  const drafts = useMemo(() => workflows
    .map((wf) => ({ wf, v: wf.versions[wf.versions.length - 1] }))
    .filter(({ v }) => v?.status === 'draft')
    .sort((a, b) => b.wf.updatedAt.localeCompare(a.wf.updatedAt)), [workflows]);

  const filteredDrafts = useMemo(() => {
    const term = searchTerm.trim().toLowerCase();
    if (!term) return drafts;
    return drafts.filter(({ wf, v }) => wf.name.toLowerCase().includes(term)
      || (wf.description ?? '').toLowerCase().includes(term) || v.rendering.some((r) => r.toLowerCase().includes(term)));
  }, [drafts, searchTerm]);

  return (
    <div id="alert-ai-assistant-view" className="space-y-3">
      {/* Hero — matches the Alerts page's own header styling */}
      <div className="bg-gradient-to-r from-sky-600 to-cyan-600 rounded-xl p-6 text-white space-y-1">
        <h2 className="text-xl font-bold">{t('assistant.heroTitle')}</h2>
        <p className="text-sm text-sky-100 max-w-2xl">
          {t('assistant.heroBody')}
        </p>
      </div>

      {/* Equipment — required before any draft can be generated; this alert
          always applies to exactly one Thing. Kept in the header area, right
          under the hero, rather than buried further down the page. */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-xs p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center gap-3 flex-1 max-w-sm">
          <span className="text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 shrink-0">{t('translation:sidebar.equipment')}</span>
          <SelectPicker
            data={scopeData.machines.map((m) => ({ label: scopeData.machineLabel(m), value: machineKey(m) }))}
            value={equipmentId || null}
            onChange={(value) => setEquipmentId(value ?? '')}
            placeholder={t('assistant.selectEquipment')}
            block
            cleanable={false}
            size="sm"
          />
        </div>
        <button
          type="button"
          onClick={handleCreateCustom}
          disabled={!canAct}
          className="px-4 py-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg text-xs font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-2 shrink-0 transition-colors cursor-pointer"
        >
          <Plus className="w-4 h-4" />
          {t('assistant.createCustom')}
        </button>
      </div>
      {!canAct && <p className="text-xs text-amber-600 dark:text-amber-400">{t('assistant.selectThingFirst')}</p>}

      {/* From the library: a failure mode of the machine's class, assembled from copied templates */}
      {canAct && (
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-xs p-4 space-y-3">
          <div>
            <div className="text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">{t('assistant.fromFailureMode')}</div>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">{t('assistant.fromFailureModeHint')}</p>
          </div>
          {failureModes.length === 0 ? (
            <p className="text-xs text-slate-400">{t('assistant.noFailureModes')}</p>
          ) : (
            <div className="flex flex-col sm:flex-row sm:items-center gap-3">
              <div className="flex-1 min-w-[220px]">
                <SelectPicker
                  data={failureModes.map((f) => ({ label: f.name, value: f.code }))}
                  value={modeCode}
                  onChange={(v) => setModeCode(v)}
                  placeholder={t('assistant.chooseFailureMode')}
                  block
                  size="sm"
                />
              </div>
              {chosenMode && chosenMode.signals.length > 1 && (
                <SelectPicker
                  data={[{ label: t('assistant.combineAll'), value: 'allOf' }, { label: t('assistant.combineAny'), value: 'anyOf' }]}
                  value={combine}
                  onChange={(v) => setCombine((v ?? 'allOf') as 'allOf' | 'anyOf')}
                  searchable={false}
                  cleanable={false}
                  size="sm"
                  className="w-44"
                />
              )}
              <button
                type="button"
                onClick={handleAssemble}
                disabled={!chosenMode || assembling}
                className="px-4 py-2 bg-sky-700 hover:bg-sky-800 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-lg text-xs font-semibold shrink-0 cursor-pointer"
              >
                {assembling ? t('assistant.assembling') : t('assistant.assemble')}
              </button>
              <button
                type="button"
                onClick={handlePropose}
                disabled={!chosenMode || proposing}
                title={t('assistant.proposeHint')}
                className="px-4 py-2 border border-sky-300 dark:border-sky-800 text-sky-700 dark:text-sky-300 hover:bg-sky-50 dark:hover:bg-sky-950/40 disabled:opacity-40 disabled:cursor-not-allowed rounded-lg text-xs font-semibold shrink-0 cursor-pointer"
              >
                {proposing ? t('assistant.proposing') : t('assistant.propose')}
              </button>
            </div>
          )}
          {chosenMode && (
            <p className="text-xs text-slate-500 dark:text-slate-400">
              {chosenMode.symptom} · {t('assistant.watches', { signals: chosenMode.signals.join(', ') })}
            </p>
          )}
          {assembleError && <p className="text-xs text-rose-600 dark:text-rose-400">{assembleError}</p>}
          {proposeMissing.length > 0 && (
            <div className="text-xs text-amber-700 dark:text-amber-300 space-y-0.5">
              <p className="font-semibold">{t('assistant.proposeNeedsInput')}</p>
              {proposeMissing.map((m, i) => <p key={i}>{m}</p>)}
            </div>
          )}
        </div>
      )}

      {/* AI Prompt + Right Panel */}
      {/* One height for both cards from desktop width (17 Nov): the prompt card sets it, and
          the examples scroll inside it rather than running past the prompt's bottom edge. */}
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-4 items-start lg:items-stretch">
        {/* AI Prompt */}
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-xs p-5 flex flex-col">
          <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-3">
            <Sparkles className="w-3.5 h-3.5 text-sky-600 dark:text-sky-400" />
            {t('assistant.aiPrompt')}
          </div>
          <Input
            as="textarea"
            value={prompt}
            onChange={(value) => {
              setPrompt(value);
              if (phase === 'clarifying' && !value.trim()) setPhase('suggest');
            }}
            rows={6}
            placeholder={t('assistant.promptPlaceholder', { example: 'Raise a critical alarm if the average temperature is above 75C for 10 minutes and vibration increases by 20% in the last 1 hour. Ignore when maintenance mode is ON.' })}
            className="flex-1 min-h-[140px] resize-none bg-transparent"
          />
          <div className="flex items-center justify-between mt-4 pt-4 border-t border-slate-100 dark:border-slate-800">
            <button
              type="button"
              className="px-3.5 py-2 border border-slate-200 dark:border-slate-700 rounded-lg text-xs font-semibold text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 flex items-center gap-2 transition-colors cursor-pointer"
              title={t('assistant.voiceTitle')}
            >
              <Mic className="w-3.5 h-3.5" />
              {t('assistant.voice')}
            </button>
            <button
              type="button"
              onClick={handleGenerate}
              disabled={!prompt.trim() || !canAct}
              className="px-4 py-2.5 bg-sky-700 hover:bg-sky-800 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-lg text-xs font-semibold flex items-center gap-2 transition-colors cursor-pointer"
            >
              <Sparkles className="w-3.5 h-3.5" />
              {t('assistant.generate')}
            </button>
          </div>
        </div>

        {/* Right Panel — prompt suggestions until the AI has enough to build, then the build checklist */}
        {phase === 'suggest' ? (
          <div className="relative">
          <div className="lg:absolute lg:inset-0 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-xs p-5 flex flex-col">
            <div className="text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-3">
              {t('assistant.quickExamples')}
            </div>
            <div className={`space-y-3 overflow-y-auto max-h-72 lg:max-h-none lg:flex-1 lg:min-h-0 pr-1 -mr-1 ${!canAct ? 'opacity-40 pointer-events-none' : ''}`}>
              {canAct && examples.length === 0 && (
                <p className="text-xs text-slate-500 dark:text-slate-400">{t('assistant.noExamplesFit')}</p>
              )}
              {examples.map((ex) => (
                <button
                  key={ex.text}
                  type="button"
                  disabled={!canAct}
                  onClick={() => runPrompt(ex.text)}
                  className="w-full text-left p-3 bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700 rounded-lg hover:border-sky-300 dark:hover:border-sky-700 hover:bg-sky-50/50 dark:hover:bg-sky-950/20 transition-colors cursor-pointer"
                >
                  <p className="text-xs text-slate-700 dark:text-slate-300 italic mb-2 leading-relaxed">"{ex.text}"</p>
                  <div className="flex gap-1.5 flex-wrap">
                    {ex.tags.map((tag) => (
                      <span
                        key={tag}
                        className="px-2 py-0.5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-full text-[0.6875rem] text-slate-500 dark:text-slate-400"
                      >
                        {t(`assistant.tags.${tag}`, { defaultValue: tag })}
                      </span>
                    ))}
                  </div>
                </button>
              ))}
            </div>
          </div>
          </div>
        ) : (
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-xs p-5">
            <div className="flex items-center justify-between pb-3 mb-1 border-b border-slate-100 dark:border-slate-800">
              <h3 className="font-semibold text-sm text-slate-800 dark:text-slate-100">{t('assistant.building')}</h3>
              <ListChecks className="w-4 h-4 text-slate-400" />
            </div>
            <div className="space-y-2.5 pt-2">
              {steps.map((step) => (
                <div
                  key={step.id}
                  className={`rounded-lg border p-2.5 flex items-center justify-between gap-2 transition-colors ${STATUS_CARD_STYLES[step.status]}`}
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    {step.status === 'done' ? (
                      <div className="w-4 h-4 rounded-full bg-emerald-500 text-white flex items-center justify-center shrink-0">
                        <Check className="w-2.5 h-2.5" />
                      </div>
                    ) : (
                      <div
                        className={`w-3.5 h-3.5 rounded-full border-2 shrink-0 ${
                          step.status === 'active' ? 'border-sky-500' : 'border-slate-300 dark:border-slate-600'
                        }`}
                      />
                    )}
                    <span className={`text-xs font-medium ${step.status === 'pending' ? 'text-slate-500 dark:text-slate-400' : 'text-slate-800 dark:text-slate-100'}`}>
                      {t(`assistant.steps.${step.id}`)}
                    </span>
                  </div>
                  <span className={`text-[0.625rem] font-bold uppercase tracking-wider shrink-0 ${STATUS_BADGE_STYLES[step.status]}`}>
                    {t(`assistant.stepStatus.${step.status}`)}
                  </span>
                </div>
              ))}
            </div>
            {notice && <p className="text-xs text-amber-600 dark:text-amber-400 mt-3 leading-relaxed">{notice}</p>}
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-3 leading-relaxed">
              {t('assistant.clarifyHint', { example: 'temperature above 80°C for 5 minutes' })}
            </p>
          </div>
        )}
      </div>

      {/* Drafts, as one card (17 Nov): a loose search box, a link far to the right and a
          line of grey text said nothing of what a draft is. The newest six, each saying which
          machine it is for and what it checks; "See all drafts" opens the full list on its
          drafts (TC_198 — it only cleared the search box, and so seemed to do nothing). */}
      <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-xs">
        <div className="p-4 border-b border-slate-100 dark:border-slate-800 flex flex-col lg:flex-row lg:items-center justify-between gap-3">
          <div className="min-w-0">
            <h3 className="font-semibold text-sm text-slate-800 dark:text-slate-100 flex items-center gap-2">
              <FilePen className="w-4 h-4 text-amber-600 dark:text-amber-400" />
              {t('assistant.drafts')}
              {drafts.length > 0 && <Chip tone="amber">{drafts.length}</Chip>}
            </h3>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">{t('assistant.draftsHint')}</p>
          </div>
          {drafts.length > 0 && (
            <div className="flex items-center gap-3 w-full lg:w-auto">
              <div className="relative flex-1 lg:w-64">
                <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none z-10" />
                <Input value={searchTerm} onChange={(value) => setSearchTerm(value)} placeholder={t('assistant.searchDrafts')}
                  aria-label={t('assistant.searchDrafts')} size="sm" className="pl-9!" />
              </div>
              <button
                type="button"
                onClick={() => onExploreDrafts?.(searchTerm.trim())}
                className="text-xs font-semibold text-sky-700 dark:text-sky-400 hover:text-sky-800 flex items-center gap-1 shrink-0 cursor-pointer"
              >
                {t('assistant.seeAllDrafts')} <ChevronRight className="w-3.5 h-3.5" />
              </button>
            </div>
          )}
        </div>
        <div className="p-4">
          {drafts.length === 0 ? (
            <div className="text-center py-6 space-y-1">
              <FilePen className="w-6 h-6 text-slate-300 dark:text-slate-600 mx-auto" />
              <p className="text-sm font-medium text-slate-600 dark:text-slate-300">{t('assistant.noDraftsYet')}</p>
              <p className="text-xs text-slate-400">{t('assistant.noDraftsYetHint')}</p>
            </div>
          ) : filteredDrafts.length === 0 ? (
            <p className="text-center text-sm text-slate-400 py-6">{t('assistant.noDrafts')}</p>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
              {filteredDrafts.slice(0, DRAFTS_SHOWN).map(({ wf, v }) => {
                const severity = String(v.spec.nodes.find((n) => n.type === 'Notify')?.params?.severity ?? '');
                const target = v.spec.scope;
                const machine = target.appliesTo === 'equipment'
                  ? scopeData.machines.find((m) => m.sourceSystem === target.sourceSystem && m.externalId === target.externalId)
                  : undefined;
                const forWhat = target.appliesTo === 'equipment'
                  ? (machine ? scopeData.machineLabel(machine) : target.externalId ?? '')
                  : t(`assistant.draftScope.${target.appliesTo}`);
                const checks = v.rendering[0] ?? wf.description ?? '';
                return (
                  <article key={wf.id} className="rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50/60 dark:bg-slate-800/40 p-4 flex flex-col gap-2.5 min-w-0">
                    <div className="flex items-center justify-between gap-2">
                      {severity ? <Chip tone={severityTone(severity)}>{t(`severity.${severity}`, { defaultValue: severity })}</Chip> : <span />}
                      <span className="px-2 py-0.5 rounded text-[0.6875rem] font-bold uppercase border bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-800">
                        {t('assistant.draftTag')}
                      </span>
                    </div>
                    <h4 className="font-semibold text-sm text-slate-900 dark:text-white break-words">{wf.name}</h4>
                    {forWhat && (
                      <p className="flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-300 min-w-0">
                        <Cpu className="w-3.5 h-3.5 text-slate-400 shrink-0" /><span className="truncate" title={forWhat}>{forWhat}</span>
                      </p>
                    )}
                    {checks && <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed line-clamp-3 break-words" title={checks}>{checks}</p>}
                    <div className="mt-auto pt-2 flex items-center justify-between gap-2 border-t border-slate-200/70 dark:border-slate-700/70">
                      <span className="flex items-center gap-1 text-[0.6875rem] text-slate-400 min-w-0">
                        <Clock className="w-3 h-3 shrink-0" />
                        <span className="truncate">{t('assistant.editedAt', { when: new Date(wf.updatedAt).toLocaleString(appLocale(), { timeZone: appTimeZone(), dateStyle: 'medium', timeStyle: 'short' }) })}</span>
                      </span>
                      <button
                        type="button"
                        onClick={() => onGenerate({ name: wf.name, spec: v.spec, workflowId: wf.id, version: v.version, status: v.status, layout: v.layout })}
                        className="px-3 py-1.5 bg-[#0B7285] hover:bg-[#095C6B] text-white rounded-lg text-xs font-semibold shrink-0 cursor-pointer"
                      >
                        {t('assistant.continueDraft')}
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
          {filteredDrafts.length > DRAFTS_SHOWN && (
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-3 text-center">
              {t('assistant.moreDrafts', { count: filteredDrafts.length - DRAFTS_SHOWN })}
            </p>
          )}
        </div>
      </section>
    </div>
  );
};
