import React, { useEffect, useMemo, useState } from 'react';
import { Plus, Trash2, Pencil, Bell, X, Check, ShieldCheck } from 'lucide-react';
import { Sensor } from '../../../lib/api';
import { AlertCondition, AlertSeverity, TemplateAlertRule } from '../../../types';

interface TemplateAlertRulesPanelProps {
  templateId: string;
  attachedSensors: Sensor[];
  /** Master Admin's own rules — the account-wide defaults. Always shown; read-only
   *  when `isClientView` (a client sees them, never edits or removes them). */
  rules: TemplateAlertRule[];
  onCreate: (rule: Omit<TemplateAlertRule, 'id' | 'createdAt'>) => void;
  onUpdate: (rule: TemplateAlertRule) => void;
  onDelete: (id: string) => void;
  /** A signed-in client's own rules, layered on top of the defaults above.
   *  Undefined for Master Admin's own console — there is no "mine" there. */
  myRules?: TemplateAlertRule[];
  onCreateMy?: (rule: Omit<TemplateAlertRule, 'id' | 'createdAt'>) => void;
  onUpdateMy?: (rule: TemplateAlertRule) => void;
  onDeleteMy?: (id: string) => void;
  isClientView?: boolean;
}

const SEVERITY_STYLE: Record<AlertSeverity, string> = {
  info: 'bg-sky-50 dark:bg-sky-950/40 text-sky-700 dark:text-sky-300 border-sky-200 dark:border-sky-800',
  warning: 'bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-800',
  critical: 'bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300 border-rose-200 dark:border-rose-800',
};

const RuleTable: React.FC<{
  rules: TemplateAlertRule[];
  readOnly: boolean;
  onToggle?: (rule: TemplateAlertRule) => void;
  onEdit?: (rule: TemplateAlertRule) => void;
  onDelete?: (id: string) => void;
}> = ({ rules, readOnly, onToggle, onEdit, onDelete }) => (
  <table className="w-full text-left text-xs">
    <thead className="bg-slate-50 dark:bg-slate-800/60 border-b border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-400 font-semibold">
      <tr>
        <th className="py-3 px-4">Rule</th>
        <th className="py-3 px-4">Condition</th>
        <th className="py-3 px-4">Severity</th>
        <th className="py-3 px-4">Status</th>
        {!readOnly && <th className="py-3 px-4 text-center">Actions</th>}
      </tr>
    </thead>
    <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
      {rules.map((r) => (
        <tr key={r.id} className="hover:bg-slate-50/60 dark:hover:bg-slate-800/40 transition-colors">
          <td className="py-3 px-4">
            <div className="font-semibold text-slate-900 dark:text-white">{r.name}</div>
            <div className="text-[11px] text-slate-400">{r.message}</div>
          </td>
          <td className="py-3 px-4 font-mono text-slate-600 dark:text-slate-300">
            {r.parameter} {r.condition} {r.threshold}
          </td>
          <td className="py-3 px-4">
            <span className={`px-2 py-0.5 text-[10px] font-semibold uppercase rounded border ${SEVERITY_STYLE[r.severity]}`}>
              {r.severity}
            </span>
          </td>
          <td className="py-3 px-4">
            {readOnly ? (
              <span className={`text-[11px] font-medium ${r.active ? 'text-emerald-600 dark:text-emerald-400' : 'text-slate-400'}`}>
                {r.active ? 'Active' : 'Disabled'}
              </span>
            ) : (
              <button
                onClick={() => onToggle?.(r)}
                className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors cursor-pointer ${r.active ? 'bg-sky-600' : 'bg-slate-300 dark:bg-slate-600'}`}
              >
                <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${r.active ? 'translate-x-4.5' : 'translate-x-1'}`} />
              </button>
            )}
          </td>
          {!readOnly && (
            <td className="py-3 px-4">
              <div className="flex items-center justify-center gap-2">
                <button
                  onClick={() => onEdit?.(r)}
                  className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-500 hover:text-sky-600 hover:border-sky-300 transition-colors cursor-pointer"
                  title="Edit"
                >
                  <Pencil className="w-3.5 h-3.5" />
                </button>
                <button
                  onClick={() => onDelete?.(r.id)}
                  className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-500 hover:text-rose-600 hover:border-rose-300 transition-colors cursor-pointer"
                  title="Delete"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            </td>
          )}
        </tr>
      ))}
    </tbody>
  </table>
);

export const TemplateAlertRulesPanel: React.FC<TemplateAlertRulesPanelProps> = ({
  templateId, attachedSensors, rules, onCreate, onUpdate, onDelete,
  myRules, onCreateMy, onUpdateMy, onDeleteMy, isClientView,
}) => {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingRule, setEditingRule] = useState<TemplateAlertRule | null>(null);

  const availableParameters = useMemo(
    () => [...new Set(attachedSensors.flatMap((s) => s.parameterSpecs.map((p) => p.parameter)))],
    [attachedSensors],
  );

  // In the client view, the modal only ever creates/edits the client's own rules —
  // Master Admin's defaults have no edit affordance for a client to open it from.
  const activeCreate = isClientView ? onCreateMy! : onCreate;
  const activeUpdate = isClientView ? onUpdateMy! : onUpdate;

  return (
    <div className="space-y-5">
      {isClientView && (
        <div>
          <div className="flex items-center gap-1.5 mb-2 text-[11px] font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500">
            <ShieldCheck className="w-3.5 h-3.5" />
            Master Defaults
          </div>
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden shadow-xs">
            {rules.length === 0 ? (
              <div className="py-6 text-center text-slate-400 text-xs">No default alert rules from Things Alive yet.</div>
            ) : (
              <RuleTable rules={rules} readOnly />
            )}
          </div>
          <p className="text-[10px] text-slate-400 dark:text-slate-500 mt-1.5">
            Set by Things Alive for this equipment class. Applies to every client — yours can't change them.
          </p>
        </div>
      )}

      <div>
        <div className="flex items-center justify-between mb-2">
          <p className="text-xs text-slate-500 dark:text-slate-400">
            {isClientView
              ? 'Your own rules, on top of the defaults above.'
              : "Threshold rules evaluated on this class's telemetry — the default every client sees."}
          </p>
          <button
            onClick={() => { setEditingRule(null); setIsModalOpen(true); }}
            disabled={availableParameters.length === 0}
            className="px-4 py-2 bg-[#0B7285] hover:bg-[#095C6B] text-white rounded-lg text-xs font-semibold shadow-xs flex items-center justify-center gap-2 transition-colors shrink-0 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
            title={availableParameters.length === 0 ? 'Attach a sensor first' : undefined}
          >
            <Plus className="w-4 h-4" />
            <span>Add Alert Rule</span>
          </button>
        </div>

        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden shadow-xs">
          {(isClientView ? myRules ?? [] : rules).length === 0 ? (
            <div className="py-10 text-center text-slate-400 text-sm flex flex-col items-center gap-2">
              <Bell className="w-5 h-5 text-slate-300 dark:text-slate-600" />
              <span>No alert rules yet.</span>
            </div>
          ) : (
            <RuleTable
              rules={isClientView ? myRules ?? [] : rules}
              readOnly={false}
              onToggle={(r) => activeUpdate({ ...r, active: !r.active })}
              onEdit={(r) => { setEditingRule(r); setIsModalOpen(true); }}
              onDelete={(id) => (isClientView ? onDeleteMy! : onDelete)(id)}
            />
          )}
        </div>
      </div>

      <AddAlertRuleModal
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

interface AddAlertRuleModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreate: (rule: Omit<TemplateAlertRule, 'id' | 'createdAt'>) => void;
  onUpdate: (rule: TemplateAlertRule) => void;
  existingRule?: TemplateAlertRule | null;
  templateId: string;
  availableParameters: string[];
}

const CONDITIONS: AlertCondition[] = ['>', '>=', '<', '<=', '==', '!='];

const AddAlertRuleModal: React.FC<AddAlertRuleModalProps> = ({
  isOpen, onClose, onCreate, onUpdate, existingRule, templateId, availableParameters,
}) => {
  const [name, setName] = useState('');
  const [parameter, setParameter] = useState('');
  const [condition, setCondition] = useState<AlertCondition>('>');
  const [threshold, setThreshold] = useState('');
  const [severity, setSeverity] = useState<AlertSeverity>('warning');
  const [message, setMessage] = useState('');

  const isEditing = !!existingRule;

  useEffect(() => {
    if (!isOpen) return;
    setName(existingRule?.name ?? '');
    setParameter(existingRule?.parameter ?? availableParameters[0] ?? '');
    setCondition(existingRule?.condition ?? '>');
    setThreshold(existingRule?.threshold?.toString() ?? '');
    setSeverity(existingRule?.severity ?? 'warning');
    setMessage(existingRule?.message ?? '');
  }, [isOpen, existingRule, availableParameters]);

  if (!isOpen) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const finalName = name.trim();
    const finalThreshold = Number(threshold);
    if (!finalName || !parameter || Number.isNaN(finalThreshold)) return;

    if (isEditing) {
      onUpdate({
        ...existingRule!, name: finalName, parameter, condition, threshold: finalThreshold,
        severity, message: message.trim(),
      });
    } else {
      onCreate({
        equipmentTemplateId: templateId, name: finalName, parameter, condition,
        threshold: finalThreshold, severity, message: message.trim(), active: true,
      });
    }
    onClose();
  };

  return (
    <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-xs flex items-center justify-center p-4 z-50 animate-in fade-in duration-150">
      <div className="bg-white dark:bg-slate-900 rounded-xl shadow-2xl border border-slate-200 dark:border-slate-800 w-full max-w-md overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between bg-slate-50/60 dark:bg-slate-800/40">
          <h3 className="font-semibold text-base text-slate-800 dark:text-slate-100">{isEditing ? 'Edit Alert Rule' : 'Add Alert Rule'}</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 p-1.5 rounded-lg cursor-pointer">
            <X className="w-5 h-5" />
          </button>
        </div>
        <form onSubmit={handleSubmit} className="p-6 space-y-4 text-sm">
          <div>
            <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">Rule Name <span className="text-rose-500">*</span></label>
            <input
              type="text" required autoFocus value={name} onChange={(e) => setName(e.target.value)}
              placeholder="e.g. High coolant temperature"
              className="w-full px-3 py-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg text-sm text-slate-800 dark:text-slate-100 placeholder-slate-400 focus:outline-none focus:border-sky-500"
            />
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-1">
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">Parameter</label>
              <select
                value={parameter} onChange={(e) => setParameter(e.target.value)}
                className="w-full px-2 py-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg text-xs text-slate-800 dark:text-slate-100 cursor-pointer"
              >
                {availableParameters.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>
            <div className="col-span-1">
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">Condition</label>
              <select
                value={condition} onChange={(e) => setCondition(e.target.value as AlertCondition)}
                className="w-full px-2 py-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg text-xs text-slate-800 dark:text-slate-100 cursor-pointer font-mono"
              >
                {CONDITIONS.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div className="col-span-1">
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">Threshold</label>
              <input
                type="number" required value={threshold} onChange={(e) => setThreshold(e.target.value)}
                className="w-full px-2 py-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg text-xs text-slate-800 dark:text-slate-100"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">Severity</label>
            <div className="flex gap-2">
              {(['info', 'warning', 'critical'] as AlertSeverity[]).map((s) => (
                <button
                  key={s} type="button" onClick={() => setSeverity(s)}
                  className={`flex-1 px-3 py-1.5 rounded-lg border text-xs font-semibold uppercase cursor-pointer transition-colors ${
                    severity === s ? SEVERITY_STYLE[s] : 'border-slate-200 dark:border-slate-700 text-slate-400'
                  }`}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">Message</label>
            <textarea
              rows={2} value={message} onChange={(e) => setMessage(e.target.value)}
              placeholder="What the operator sees when this fires..."
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
