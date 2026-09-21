import React, { useEffect, useMemo, useState } from 'react';
import { Plus, Trash2, Pencil, TrendingUp, X, Check, ShieldCheck } from 'lucide-react';
import { Sensor } from '../../../lib/api';
import { PredictionMethod, PredictionTier, TemplatePredictiveRule } from '../../../types';

interface TemplatePredictiveRulesPanelProps {
  templateId: string;
  attachedSensors: Sensor[];
  /** Master Admin's own rules — the account-wide defaults. Always shown; read-only
   *  when `isClientView` (a client sees them, never edits or removes them). */
  rules: TemplatePredictiveRule[];
  onCreate: (rule: Omit<TemplatePredictiveRule, 'id' | 'createdAt'>) => void;
  onUpdate: (rule: TemplatePredictiveRule) => void;
  onDelete: (id: string) => void;
  /** A signed-in client's own rules, layered on top of the defaults above.
   *  Undefined for Master Admin's own console — there is no "mine" there. */
  myRules?: TemplatePredictiveRule[];
  onCreateMy?: (rule: Omit<TemplatePredictiveRule, 'id' | 'createdAt'>) => void;
  onUpdateMy?: (rule: TemplatePredictiveRule) => void;
  onDeleteMy?: (id: string) => void;
  isClientView?: boolean;
}

const TIER_STYLE: Record<PredictionTier, string> = {
  T0: 'bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 border-slate-200 dark:border-slate-700',
  T1: 'bg-sky-50 dark:bg-sky-950/40 text-sky-700 dark:text-sky-300 border-sky-200 dark:border-sky-800',
};

const METHOD_LABEL: Record<PredictionMethod, string> = {
  'rule-based': 'Rule-based',
  unsupervised: 'Unsupervised model',
};

const RuleCard: React.FC<{ r: TemplatePredictiveRule; onEdit?: () => void; onDelete?: () => void }> = ({ r, onEdit, onDelete }) => (
  <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 shadow-xs space-y-2.5">
    <div className="flex items-center justify-between">
      <h4 className="font-semibold text-slate-900 dark:text-white text-sm flex items-center gap-1.5">
        <TrendingUp className="w-3.5 h-3.5 text-sky-600" />
        {r.name}
      </h4>
      <div className="flex items-center gap-1.5 shrink-0">
        <span className={`px-1.5 py-0.5 text-[10px] font-semibold rounded border ${TIER_STYLE[r.tier]}`}>{r.tier}</span>
        {onEdit && onDelete && (
          <>
            <button onClick={onEdit} className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-500 hover:text-sky-600 hover:border-sky-300 transition-colors cursor-pointer" title="Edit">
              <Pencil className="w-3.5 h-3.5" />
            </button>
            <button onClick={onDelete} className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-500 hover:text-rose-600 hover:border-rose-300 transition-colors cursor-pointer" title="Delete">
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </>
        )}
      </div>
    </div>
    <div className="font-mono text-xs bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg px-3 py-2 text-slate-700 dark:text-slate-300">
      {r.parameter} <span className="text-slate-400">· {METHOD_LABEL[r.method]} · {r.windowDays}d window</span>
    </div>
    <p className="text-xs text-slate-500 dark:text-slate-400">{r.caption}</p>
    {!r.active && <p className="text-[10px] text-slate-400">Disabled</p>}
  </div>
);

export const TemplatePredictiveRulesPanel: React.FC<TemplatePredictiveRulesPanelProps> = ({
  templateId, attachedSensors, rules, onCreate, onUpdate, onDelete,
  myRules, onCreateMy, onUpdateMy, onDeleteMy, isClientView,
}) => {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingRule, setEditingRule] = useState<TemplatePredictiveRule | null>(null);

  const availableParameters = useMemo(
    () => [...new Set(attachedSensors.flatMap((s) => s.parameterSpecs.map((p) => p.parameter)))],
    [attachedSensors],
  );

  const activeCreate = isClientView ? onCreateMy! : onCreate;
  const activeUpdate = isClientView ? onUpdateMy! : onUpdate;
  const mine = myRules ?? [];

  return (
    <div className="space-y-5">
      {isClientView && (
        <div>
          <div className="flex items-center gap-1.5 mb-2 text-[11px] font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500">
            <ShieldCheck className="w-3.5 h-3.5" />
            Master Defaults
          </div>
          {rules.length === 0 ? (
            <div className="py-6 text-center text-slate-400 text-xs bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl">
              No default predictive rules from Things Alive yet.
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {rules.map((r) => <RuleCard key={r.id} r={r} />)}
            </div>
          )}
          <p className="text-[10px] text-slate-400 dark:text-slate-500 mt-1.5">
            Set by Things Alive for this equipment class. Feeds every client's Live Predictions — yours can't change them.
          </p>
        </div>
      )}

      <div>
        <div className="flex items-center justify-between mb-2">
          <p className="text-xs text-slate-500 dark:text-slate-400">
            {isClientView
              ? 'Your own predictive rules, on top of the defaults above.'
              : "Predictive maintenance rules scored on this class's telemetry — the default every client sees on their Live Predictions dashboard."}
          </p>
          <button
            onClick={() => { setEditingRule(null); setIsModalOpen(true); }}
            disabled={availableParameters.length === 0}
            className="px-4 py-2 bg-[#0B7285] hover:bg-[#095C6B] text-white rounded-lg text-xs font-semibold shadow-xs flex items-center justify-center gap-2 transition-colors shrink-0 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
            title={availableParameters.length === 0 ? 'Attach a sensor first' : undefined}
          >
            <Plus className="w-4 h-4" />
            <span>Add Predictive Rule</span>
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {(isClientView ? mine : rules).map((r) => (
            <RuleCard
              key={r.id}
              r={r}
              onEdit={() => { setEditingRule(r); setIsModalOpen(true); }}
              onDelete={() => (isClientView ? onDeleteMy! : onDelete)(r.id)}
            />
          ))}

          {(isClientView ? mine : rules).length === 0 && (
            <div className="col-span-full py-10 text-center text-slate-400 text-sm flex flex-col items-center gap-2">
              <TrendingUp className="w-5 h-5 text-slate-300 dark:text-slate-600" />
              <span>No predictive rules yet.</span>
            </div>
          )}
        </div>
      </div>

      <AddPredictiveRuleModal
        isOpen={isModalOpen}
        onClose={() => { setIsModalOpen(false); setEditingRule(null); }}
        onCreate={activeCreate}
        onUpdate={activeUpdate}
        existingRule={editingRule}
        templateId={templateId}
        availableParameters={availableParameters}
      />
    </div>
  );
};

interface AddPredictiveRuleModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreate: (rule: Omit<TemplatePredictiveRule, 'id' | 'createdAt'>) => void;
  onUpdate: (rule: TemplatePredictiveRule) => void;
  existingRule?: TemplatePredictiveRule | null;
  templateId: string;
  availableParameters: string[];
}

const AddPredictiveRuleModal: React.FC<AddPredictiveRuleModalProps> = ({
  isOpen, onClose, onCreate, onUpdate, existingRule, templateId, availableParameters,
}) => {
  const [name, setName] = useState('');
  const [parameter, setParameter] = useState('');
  const [tier, setTier] = useState<PredictionTier>('T0');
  const [method, setMethod] = useState<PredictionMethod>('rule-based');
  const [windowDays, setWindowDays] = useState('7');
  const [caption, setCaption] = useState('');

  const isEditing = !!existingRule;

  useEffect(() => {
    if (!isOpen) return;
    setName(existingRule?.name ?? '');
    setParameter(existingRule?.parameter ?? availableParameters[0] ?? '');
    setTier(existingRule?.tier ?? 'T0');
    setMethod(existingRule?.method ?? 'rule-based');
    setWindowDays(existingRule?.windowDays?.toString() ?? '7');
    setCaption(existingRule?.caption ?? '');
  }, [isOpen, existingRule, availableParameters]);

  if (!isOpen) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const finalName = name.trim();
    const finalWindow = Number(windowDays);
    if (!finalName || !parameter || Number.isNaN(finalWindow)) return;

    if (isEditing) {
      onUpdate({ ...existingRule!, name: finalName, parameter, tier, method, windowDays: finalWindow, caption: caption.trim() });
    } else {
      onCreate({
        equipmentTemplateId: templateId, name: finalName, parameter, tier, method,
        windowDays: finalWindow, caption: caption.trim(), active: true,
      });
    }
    onClose();
  };

  return (
    <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-xs flex items-center justify-center p-4 z-50 animate-in fade-in duration-150">
      <div className="bg-white dark:bg-slate-900 rounded-xl shadow-2xl border border-slate-200 dark:border-slate-800 w-full max-w-md overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between bg-slate-50/60 dark:bg-slate-800/40">
          <h3 className="font-semibold text-base text-slate-800 dark:text-slate-100">{isEditing ? 'Edit Predictive Rule' : 'Add Predictive Rule'}</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 p-1.5 rounded-lg cursor-pointer">
            <X className="w-5 h-5" />
          </button>
        </div>
        <form onSubmit={handleSubmit} className="p-6 space-y-4 text-sm">
          <div>
            <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">Rule Name <span className="text-rose-500">*</span></label>
            <input
              type="text" required autoFocus value={name} onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Fuel Consumption Anomaly"
              className="w-full px-3 py-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg text-sm text-slate-800 dark:text-slate-100 placeholder-slate-400 focus:outline-none focus:border-sky-500"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">Parameter</label>
              <select
                value={parameter} onChange={(e) => setParameter(e.target.value)}
                className="w-full px-2 py-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg text-xs text-slate-800 dark:text-slate-100 cursor-pointer"
              >
                {availableParameters.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">Rolling window (days)</label>
              <input
                type="number" min={1} required value={windowDays} onChange={(e) => setWindowDays(e.target.value)}
                className="w-full px-2 py-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg text-xs text-slate-800 dark:text-slate-100"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">Tier</label>
            <div className="flex gap-2">
              {(['T0', 'T1'] as PredictionTier[]).map((t) => (
                <button
                  key={t} type="button" onClick={() => setTier(t)}
                  className={`flex-1 px-3 py-1.5 rounded-lg border text-xs font-semibold cursor-pointer transition-colors ${
                    tier === t ? TIER_STYLE[t] : 'border-slate-200 dark:border-slate-700 text-slate-400'
                  }`}
                >
                  {t === 'T0' ? 'T0 — Rule-based' : 'T1 — Unsupervised'}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">Method</label>
            <select
              value={method} onChange={(e) => setMethod(e.target.value as PredictionMethod)}
              className="w-full px-2 py-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg text-xs text-slate-800 dark:text-slate-100 cursor-pointer"
            >
              <option value="rule-based">Rule-based</option>
              <option value="unsupervised">Unsupervised model</option>
            </select>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">Caption shown to the client</label>
            <textarea
              rows={2} value={caption} onChange={(e) => setCaption(e.target.value)}
              placeholder="e.g. vs 7-day rolling baseline"
              className="w-full px-3 py-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg text-sm text-slate-800 dark:text-slate-100 placeholder-slate-400 focus:outline-none focus:border-sky-500 resize-none"
            />
          </div>

          <div className="pt-3 border-t border-slate-200 dark:border-slate-800 flex items-center justify-end gap-3">
            <button type="button" onClick={onClose} className="px-4 py-2 border border-slate-200 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300 text-sm font-medium hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors cursor-pointer">
              Cancel
            </button>
            <button type="submit" className="px-5 py-2 bg-sky-600 hover:bg-sky-700 text-white rounded-lg text-sm font-medium shadow-xs flex items-center gap-2 transition-colors cursor-pointer">
              <Check className="w-4 h-4" />
              <span>{isEditing ? 'Save Changes' : 'Create Rule'}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
