import React, { useMemo, useState } from 'react';
import {
  Sparkles,
  Mic,
  Search,
  ChevronRight,
  Plus,
  ListChecks,
  Check,
  Thermometer,
  Activity,
  Droplet,
  Zap,
  Settings,
  Wind,
} from 'lucide-react';
import { Input, SelectPicker } from 'rsuite';
import { WorkflowSpec, parsePromptToWorkflow, hasConcreteConditions, mentionsSensorKeyword } from '../../utils/workflowParser';
import { FLEET } from '../../data/fleetMockData';

interface AlertAIAssistantProps {
  onGenerate: (spec: WorkflowSpec) => void;
}

type StatusState = 'done' | 'active' | 'pending';

interface CardItem {
  id: string;
  title: string;
  description: string;
  prompt: string;
  icon: React.FC<{ className?: string }>;
  iconBg: string;
  iconColor: string;
}

const QUICK_EXAMPLES: { text: string; tags: string[] }[] = [
  {
    text: 'Notify me if pump energy consumption spikes above 55kWh in a 1 hour window',
    tags: ['energy', 'efficiency', 'alert'],
  },
  {
    text: 'Alert team if pressure drop exceeds 15% across all valves in the system',
    tags: ['pressure', 'cluster', 'safety'],
  },
  {
    text: 'Warn me when battery voltage drops below 11.5V for more than 3 minutes',
    tags: ['battery', 'voltage', 'warning'],
  },
];

interface DraftItem extends CardItem {
  workflowName: string;
}

const DRAFTS: DraftItem[] = [
  {
    id: 'd1',
    workflowName: 'Workflow_draft-1788949878654-vu4uoa7kc',
    title: 'Workflow_draft-1788949878654-vu4uoa7kc',
    description: 'Generated from: Raise a critical alarm if the average temperature is above 75C for 10 minutes and vibration increases by 20% in the last 1 hour. Ignore when maintenance mode is ON.',
    prompt: 'Raise a critical alarm if the average temperature is above 75C for 10 minutes and vibration increases by 20% in the last 1 hour. Ignore when maintenance mode is ON.',
    icon: Thermometer,
    iconBg: 'bg-rose-50 dark:bg-rose-950/40',
    iconColor: 'text-rose-600 dark:text-rose-400',
  },
  {
    id: 'd2',
    workflowName: 'Workflow_draft-1788869196985-cfh22e6gl',
    title: 'Workflow_draft-1788869196985-cfh22e6gl',
    description: 'Generated from: Raise a critical alarm if the average temperature is above 75C for 10 minutes and Converter Oil Temperature increases more than 50 deg in the last 1 hour.',
    prompt: 'Raise a critical alarm if the average temperature is above 75C for 10 minutes and converter oil temperature increases by 50 in the last 1 hour.',
    icon: Activity,
    iconBg: 'bg-violet-50 dark:bg-violet-950/40',
    iconColor: 'text-violet-600 dark:text-violet-400',
  },
  {
    id: 'd3',
    workflowName: 'Workflow_draft-1788863511069-dprppl1lp',
    title: 'Workflow_draft-1788863511069-dprppl1lp',
    description: 'Generated from: Alert team if pressure drop exceeds 15% across all valves and it should be generated every 24 hours once',
    prompt: 'Alert team if pressure drop exceeds 15% across all valves in the system every 24 hours.',
    icon: Droplet,
    iconBg: 'bg-blue-50 dark:bg-blue-950/40',
    iconColor: 'text-blue-600 dark:text-blue-400',
  },
  {
    id: 'd4',
    workflowName: 'Workflow_draft-1788152697933-rc27t5ip6',
    title: 'Workflow_draft-1788152697933-rc27t5ip6',
    description: 'Generated from: Notify me if pump energy consumption spikes above 55kWh in a 1 hour window',
    prompt: 'Notify me if pump energy consumption spikes above 55 in a 1 hour window.',
    icon: Wind,
    iconBg: 'bg-slate-100 dark:bg-slate-800',
    iconColor: 'text-slate-500 dark:text-slate-400',
  },
  {
    id: 'd5',
    workflowName: 'Workflow_draft-1787807926676-htp0goxdd',
    title: 'Workflow_draft-1787807926676-htp0goxdd',
    description: 'Generated from: Raise a critical alarm if fuel level drops by more than 20L in under 2 minutes',
    prompt: 'Raise a critical alarm if fuel level drops by 20 in under 2 minutes.',
    icon: Zap,
    iconBg: 'bg-amber-50 dark:bg-amber-950/40',
    iconColor: 'text-amber-600 dark:text-amber-400',
  },
  {
    id: 'd6',
    workflowName: 'Workflow_draft-1787806589702-n7r8mthig',
    title: 'Workflow_draft-1787806589702-n7r8mthig',
    description: 'Generated from: Raise a high alarm if the hydraulic oil temperature stays above 92C for 15 minutes',
    prompt: 'Raise a high alarm if hydraulic oil temperature is above 92 for 15 minutes.',
    icon: Thermometer,
    iconBg: 'bg-rose-50 dark:bg-rose-950/40',
    iconColor: 'text-rose-600 dark:text-rose-400',
  },
  {
    id: 'd7',
    workflowName: 'Workflow_draft-1787748083155-z82ow3k3c',
    title: 'Workflow_draft-1787748083155-z82ow3k3c',
    description: 'Generated from: Warn me when battery voltage drops below 11.5V for more than 3 minutes',
    prompt: 'Warn me when battery voltage drops below 11.5 for more than 3 minutes.',
    icon: Settings,
    iconBg: 'bg-emerald-50 dark:bg-emerald-950/40',
    iconColor: 'text-emerald-600 dark:text-emerald-400',
  },
  {
    id: 'd8',
    workflowName: 'Workflow_draft-1787740080587-2n492wra6',
    title: 'Workflow_draft-1787740080587-2n492wra6',
    description: 'Generated from: Raise a critical alarm if DPF pressure exceeds 2.8 kPa for 5 minutes',
    prompt: 'Raise a critical alarm if DPF pressure is above 2.8 for 5 minutes.',
    icon: Droplet,
    iconBg: 'bg-blue-50 dark:bg-blue-950/40',
    iconColor: 'text-blue-600 dark:text-blue-400',
  },
];

const CREATION_STEPS = [
  { id: 'understand', label: 'Understanding Requirement' },
  { id: 'sensors', label: 'Identifying Sensors' },
  { id: 'conditions', label: 'Defining Conditions' },
  { id: 'actions', label: 'Selecting Actions' },
  { id: 'ready', label: 'Ready to Generate' },
];

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

const ItemCard: React.FC<{ item: CardItem; tag: string; tagClass: string; buttonLabel: string; onUse: () => void }> = ({
  item,
  tag,
  tagClass,
  buttonLabel,
  onUse,
}) => {
  const Icon = item.icon;
  return (
    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-xs p-4 flex flex-col">
      <div className="flex items-center justify-between mb-3">
        <div className={`w-9 h-9 rounded-lg flex items-center justify-center ${item.iconBg}`}>
          <Icon className={`w-4 h-4 ${item.iconColor}`} />
        </div>
        <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase border ${tagClass}`}>{tag}</span>
      </div>
      <div className="font-semibold text-sm text-slate-800 dark:text-slate-100 mb-1 break-words">{item.title}</div>
      <p className="text-xs text-slate-500 dark:text-slate-400 flex-1 leading-relaxed line-clamp-3">{item.description}</p>
      <button
        onClick={onUse}
        className="mt-4 w-full py-2 bg-slate-50 dark:bg-slate-800/60 hover:bg-sky-50 dark:hover:bg-sky-950/30 border border-slate-200 dark:border-slate-700 hover:border-sky-300 dark:hover:border-sky-700 rounded-lg text-xs font-semibold text-sky-700 dark:text-sky-400 transition-colors cursor-pointer"
      >
        {buttonLabel}
      </button>
    </div>
  );
};

export const AlertAIAssistant: React.FC<AlertAIAssistantProps> = ({ onGenerate }) => {
  const [prompt, setPrompt] = useState('');
  const [equipmentId, setEquipmentId] = useState('');
  const [phase, setPhase] = useState<'suggest' | 'clarifying'>('suggest');
  const [searchTerm, setSearchTerm] = useState('');
  const canAct = !!equipmentId;

  const runPrompt = (text: string, name?: string) => {
    if (!canAct) return;
    const spec = { ...parsePromptToWorkflow(text, name), equipmentId };
    if (hasConcreteConditions(spec)) {
      onGenerate(spec);
    } else {
      setPrompt(text);
      setPhase('clarifying');
    }
  };

  const handleGenerate = () => {
    const text = prompt.trim();
    if (!text) return;
    runPrompt(text);
  };

  const handleCreateCustom = () => {
    if (!canAct) return;
    onGenerate({ ...parsePromptToWorkflow('', `Workflow_draft-${Date.now()}`), equipmentId });
  };

  const steps = useMemo(() => {
    const sensorsFound = mentionsSensorKeyword(prompt);
    return CREATION_STEPS.map((step) => {
      let status: StatusState = 'pending';
      if (step.id === 'understand') status = sensorsFound ? 'done' : 'active';
      if (step.id === 'sensors') status = sensorsFound ? 'active' : 'pending';
      return { ...step, status };
    });
  }, [prompt]);

  const filteredDrafts = useMemo(() => {
    const term = searchTerm.trim().toLowerCase();
    if (!term) return DRAFTS;
    return DRAFTS.filter((d) => d.title.toLowerCase().includes(term) || d.description.toLowerCase().includes(term));
  }, [searchTerm]);

  return (
    <div id="alert-ai-assistant-view" className="space-y-3">
      {/* Hero — matches the Alerts page's own header styling */}
      <div className="bg-gradient-to-r from-sky-600 to-cyan-600 rounded-xl p-6 text-white space-y-1">
        <h2 className="text-xl font-bold">Describe your alarm in natural language</h2>
        <p className="text-sm text-sky-100 max-w-2xl">
          ThingsAlive AI uses advanced semantic processing to convert your business requirements into robust,
          industrial-grade monitoring workflows.
        </p>
      </div>

      {/* Equipment — required before any draft can be generated; this alert
          always applies to exactly one Thing. Kept in the header area, right
          under the hero, rather than buried further down the page. */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-xs p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center gap-3 flex-1 max-w-sm">
          <span className="text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 shrink-0">Equipment</span>
          <SelectPicker
            data={FLEET.map((t) => ({ label: `${t.id} · ${t.name}`, value: t.id }))}
            value={equipmentId}
            onChange={(value) => setEquipmentId(value ?? '')}
            placeholder="Select equipment…"
            block
            searchable={false}
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
          Create Custom
        </button>
      </div>
      {!canAct && <p className="text-xs text-amber-600 dark:text-amber-400">Select a Thing before describing or generating an alert.</p>}

      {/* AI Prompt + Right Panel */}
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-4 items-start">
        {/* AI Prompt */}
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-xs p-5 flex flex-col">
          <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-3">
            <Sparkles className="w-3.5 h-3.5 text-sky-600 dark:text-sky-400" />
            AI PROMPT
          </div>
          <Input
            as="textarea"
            value={prompt}
            onChange={(value) => {
              setPrompt(value);
              if (phase === 'clarifying' && !value.trim()) setPhase('suggest');
            }}
            rows={6}
            placeholder={"e.g. \"Raise a critical alarm if the average temperature is above 75C for 10 minutes and vibration increases by 20% in the last 1 hour. Ignore when maintenance mode is ON.\""}
            className="flex-1 min-h-[140px] resize-none bg-transparent"
          />
          <div className="flex items-center justify-between mt-4 pt-4 border-t border-slate-100 dark:border-slate-800">
            <button
              type="button"
              className="px-3.5 py-2 border border-slate-200 dark:border-slate-700 rounded-lg text-xs font-semibold text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 flex items-center gap-2 transition-colors cursor-pointer"
              title="Dictate your alert (demo only)"
            >
              <Mic className="w-3.5 h-3.5" />
              Voice
            </button>
            <button
              type="button"
              onClick={handleGenerate}
              disabled={!prompt.trim() || !canAct}
              className="px-4 py-2.5 bg-sky-700 hover:bg-sky-800 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-lg text-xs font-semibold flex items-center gap-2 transition-colors cursor-pointer"
            >
              <Sparkles className="w-3.5 h-3.5" />
              Generate Workflow
            </button>
          </div>
        </div>

        {/* Right Panel — prompt suggestions until the AI has enough to build, then the build checklist */}
        {phase === 'suggest' ? (
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-xs p-5 flex flex-col">
            <div className="text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-3">
              Quick Try Examples
            </div>
            <div className={`space-y-3 overflow-y-auto max-h-72 pr-1 -mr-1 ${!canAct ? 'opacity-40 pointer-events-none' : ''}`}>
              {QUICK_EXAMPLES.map((ex) => (
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
                        className="px-2 py-0.5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-full text-[10px] text-slate-500 dark:text-slate-400"
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-xs p-5">
            <div className="flex items-center justify-between pb-3 mb-1 border-b border-slate-100 dark:border-slate-800">
              <h3 className="font-semibold text-sm text-slate-800 dark:text-slate-100">Building Your Alert</h3>
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
                      {step.label}
                    </span>
                  </div>
                  <span className={`text-[9px] font-bold uppercase tracking-wider shrink-0 ${STATUS_BADGE_STYLES[step.status]}`}>
                    {step.status}
                  </span>
                </div>
              ))}
            </div>
            <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-3 leading-relaxed">
              Tell me the sensor and the exact threshold — e.g. "temperature above 80°C for 5 minutes" — and I'll generate the workflow.
            </p>
          </div>
        )}
      </div>

      {/* Draft search */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="relative flex-1 min-w-[220px] max-w-xs">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <Input
            value={searchTerm}
            onChange={(value) => setSearchTerm(value)}
            placeholder="Search drafts..."
            size="sm"
            className="pl-9!"
          />
        </div>
        <button
          type="button"
          onClick={() => setSearchTerm('')}
          className="text-xs font-semibold text-sky-600 dark:text-sky-400 hover:text-sky-700 flex items-center gap-1 shrink-0 cursor-pointer"
        >
          Explore more <ChevronRight className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Drafts */}
      {filteredDrafts.length > 0 && (
        <div className="space-y-3">
          <h3 className="font-semibold text-sm text-slate-800 dark:text-slate-100">Drafts</h3>
          <div className={`grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 ${!canAct ? 'opacity-40 pointer-events-none' : ''}`}>
            {filteredDrafts.map((d) => (
              <ItemCard
                key={d.id}
                item={d}
                tag="Draft"
                tagClass="bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-800"
                buttonLabel="Resume Draft"
                onUse={() => runPrompt(d.prompt, d.workflowName)}
              />
            ))}
          </div>
        </div>
      )}

      {filteredDrafts.length === 0 && (
        <div className="text-center text-sm text-slate-400 py-8">No drafts match your search.</div>
      )}
    </div>
  );
};
