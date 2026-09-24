import React, { useEffect, useMemo, useState } from 'react';
import { Plus, Trash2, Pencil, Sigma, X, Check, Info, ShieldCheck } from 'lucide-react';
import { Sensor } from '../../../lib/api';
import { TemplateKpiFormula } from '../../../types';

interface TemplateKpiFormulasPanelProps {
  templateId: string;
  attachedSensors: Sensor[];
  /** Master Admin's own formulas — the account-wide defaults. Always shown; read-only
   *  when `isClientView` (a client sees them, never edits or removes them). */
  formulas: TemplateKpiFormula[];
  onCreate: (formula: Omit<TemplateKpiFormula, 'id' | 'createdAt'>) => void;
  onUpdate: (formula: TemplateKpiFormula) => void;
  onDelete: (id: string) => void;
  /** A signed-in client's own formulas, layered on top of the defaults above.
   *  Undefined for Master Admin's own console — there is no "mine" there. */
  myFormulas?: TemplateKpiFormula[];
  onCreateMy?: (formula: Omit<TemplateKpiFormula, 'id' | 'createdAt'>) => void;
  onUpdateMy?: (formula: TemplateKpiFormula) => void;
  onDeleteMy?: (id: string) => void;
  isClientView?: boolean;
}

const FormulaCard: React.FC<{ f: TemplateKpiFormula; onEdit?: () => void; onDelete?: () => void }> = ({ f, onEdit, onDelete }) => (
  <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 shadow-xs space-y-2">
    <div className="flex items-center justify-between">
      <h4 className="font-semibold text-slate-900 dark:text-white text-sm flex items-center gap-1.5">
        <Sigma className="w-3.5 h-3.5 text-emerald-600" />
        {f.name}
      </h4>
      {onEdit && onDelete && (
        <div className="flex items-center gap-1.5">
          <button onClick={onEdit} className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-500 hover:text-sky-600 hover:border-sky-300 transition-colors cursor-pointer" title="Edit">
            <Pencil className="w-3.5 h-3.5" />
          </button>
          <button onClick={onDelete} className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-500 hover:text-rose-600 hover:border-rose-300 transition-colors cursor-pointer" title="Delete">
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      )}
    </div>
    <div className="font-mono text-xs bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg px-3 py-2 text-slate-700 dark:text-slate-300">
      {f.formula} {f.unit && <span className="text-slate-400">({f.unit})</span>}
    </div>
    {f.description && <p className="text-xs text-slate-500 dark:text-slate-400">{f.description}</p>}
  </div>
);

export const TemplateKpiFormulasPanel: React.FC<TemplateKpiFormulasPanelProps> = ({
  templateId, attachedSensors, formulas, onCreate, onUpdate, onDelete,
  myFormulas, onCreateMy, onUpdateMy, onDeleteMy, isClientView,
}) => {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingFormula, setEditingFormula] = useState<TemplateKpiFormula | null>(null);

  const availableParameters = useMemo(
    () => [...new Set(attachedSensors.flatMap((s) => s.parameterSpecs.map((p) => p.parameter)))],
    [attachedSensors],
  );

  const activeCreate = isClientView ? onCreateMy! : onCreate;
  const activeUpdate = isClientView ? onUpdateMy! : onUpdate;
  const mine = myFormulas ?? [];

  return (
    <div className="space-y-5">
      {isClientView && (
        <div>
          <div className="flex items-center gap-1.5 mb-2 text-[11px] font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500">
            <ShieldCheck className="w-3.5 h-3.5" />
            Master Defaults
          </div>
          {formulas.length === 0 ? (
            <div className="py-6 text-center text-slate-400 text-xs bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl">
              No default KPI formulas from Things Alive yet.
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {formulas.map((f) => <FormulaCard key={f.id} f={f} />)}
            </div>
          )}
          <p className="text-[10px] text-slate-400 dark:text-slate-500 mt-1.5">
            Set by Things Alive for this equipment class. Applies to every client — yours can't change them.
          </p>
        </div>
      )}

      <div>
        <div className="flex items-center justify-between mb-2">
          <p className="text-xs text-slate-500 dark:text-slate-400">
            {isClientView
              ? 'Your own formulas, on top of the defaults above.'
              : "Named formulas computed from this class's parameters — the default every client sees."}
          </p>
          <button
            onClick={() => { setEditingFormula(null); setIsModalOpen(true); }}
            disabled={availableParameters.length === 0}
            className="px-4 py-2 bg-[#0B7285] hover:bg-[#095C6B] text-white rounded-lg text-xs font-semibold shadow-xs flex items-center justify-center gap-2 transition-colors shrink-0 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
            title={availableParameters.length === 0 ? 'Attach a sensor first' : undefined}
          >
            <Plus className="w-4 h-4" />
            <span>Add KPI Formula</span>
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {(isClientView ? mine : formulas).map((f) => (
            <FormulaCard
              key={f.id}
              f={f}
              onEdit={() => { setEditingFormula(f); setIsModalOpen(true); }}
              onDelete={() => (isClientView ? onDeleteMy! : onDelete)(f.id)}
            />
          ))}

          {(isClientView ? mine : formulas).length === 0 && (
            <div className="col-span-full py-10 text-center text-slate-400 text-sm flex flex-col items-center gap-2">
              <Sigma className="w-5 h-5 text-slate-300 dark:text-slate-600" />
              <span>No KPI formulas yet.</span>
            </div>
          )}
        </div>
      </div>

      <AddKpiFormulaModal
        isOpen={isModalOpen}
        onClose={() => { setIsModalOpen(false); setEditingFormula(null); }}
        onCreate={activeCreate}
        onUpdate={activeUpdate}
        existingFormula={editingFormula}
        templateId={templateId}
        availableParameters={availableParameters}
      />
    </div>
  );
};

interface AddKpiFormulaModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreate: (formula: Omit<TemplateKpiFormula, 'id' | 'createdAt'>) => void;
  onUpdate: (formula: TemplateKpiFormula) => void;
  existingFormula?: TemplateKpiFormula | null;
  templateId: string;
  availableParameters: string[];
}

const AddKpiFormulaModal: React.FC<AddKpiFormulaModalProps> = ({
  isOpen, onClose, onCreate, onUpdate, existingFormula, templateId, availableParameters,
}) => {
  const [name, setName] = useState('');
  const [formula, setFormula] = useState('');
  const [unit, setUnit] = useState('');
  const [description, setDescription] = useState('');

  const isEditing = !!existingFormula;

  useEffect(() => {
    if (!isOpen) return;
    setName(existingFormula?.name ?? '');
    setFormula(existingFormula?.formula ?? '');
    setUnit(existingFormula?.unit ?? '');
    setDescription(existingFormula?.description ?? '');
  }, [isOpen, existingFormula]);

  if (!isOpen) return null;

  const insertParameter = (p: string) => setFormula((prev) => (prev ? `${prev} ${p}` : p));

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const finalName = name.trim();
    const finalFormula = formula.trim();
    if (!finalName || !finalFormula) return;

    if (isEditing) {
      onUpdate({ ...existingFormula!, name: finalName, formula: finalFormula, unit: unit.trim() || undefined, description: description.trim() || undefined });
    } else {
      onCreate({ equipmentTemplateId: templateId, name: finalName, formula: finalFormula, unit: unit.trim() || undefined, description: description.trim() || undefined });
    }
    onClose();
  };

  return (
    <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-xs flex items-center justify-center p-4 z-50 animate-in fade-in duration-150">
      <div className="bg-white dark:bg-slate-900 rounded-xl shadow-2xl border border-slate-200 dark:border-slate-800 w-full max-w-md overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between bg-slate-50/60 dark:bg-slate-800/40">
          <h3 className="font-semibold text-base text-slate-800 dark:text-slate-100">{isEditing ? 'Edit KPI Formula' : 'Add KPI Formula'}</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 p-1.5 rounded-lg cursor-pointer">
            <X className="w-5 h-5" />
          </button>
        </div>
        <form onSubmit={handleSubmit} className="p-6 space-y-4 text-sm">
          <div>
            <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">Name <span className="text-rose-500">*</span></label>
            <input
              type="text" required autoFocus value={name} onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Fuel Efficiency"
              className="w-full px-3 py-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg text-sm text-slate-800 dark:text-slate-100 placeholder-slate-400 focus:outline-none focus:border-sky-500"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">Formula <span className="text-rose-500">*</span></label>
            <textarea
              rows={2} required value={formula} onChange={(e) => setFormula(e.target.value)}
              placeholder="e.g. fuel_consumed_liters / running_hours"
              className="w-full px-3 py-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg text-sm font-mono text-slate-800 dark:text-slate-100 placeholder-slate-400 focus:outline-none focus:border-sky-500 resize-none"
            />
            {availableParameters.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mt-2">
                {availableParameters.map((p) => (
                  <button
                    key={p} type="button" onClick={() => insertParameter(p)}
                    className="px-2 py-0.5 text-[11px] font-mono rounded bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-700 hover:border-sky-300 hover:text-sky-700 cursor-pointer"
                  >
                    {p}
                  </button>
                ))}
              </div>
            )}
            <p className="text-[10px] text-slate-400 mt-1 flex items-center gap-1">
              <Info className="w-3 h-3" /> Click a parameter to insert it — free text for now, evaluated later.
            </p>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">Unit</label>
            <input
              type="text" value={unit} onChange={(e) => setUnit(e.target.value)}
              placeholder="e.g. L/hr"
              className="w-full px-3 py-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg text-sm text-slate-800 dark:text-slate-100 placeholder-slate-400 focus:outline-none focus:border-sky-500"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">Description</label>
            <textarea
              rows={2} value={description} onChange={(e) => setDescription(e.target.value)}
              className="w-full px-3 py-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg text-sm text-slate-800 dark:text-slate-100 focus:outline-none focus:border-sky-500 resize-none"
            />
          </div>

          <div className="pt-3 border-t border-slate-200 dark:border-slate-800 flex items-center justify-end gap-3">
            <button type="button" onClick={onClose} className="px-4 py-2 border border-slate-200 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300 text-sm font-medium hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors cursor-pointer">
              Cancel
            </button>
            <button type="submit" className="px-5 py-2 bg-sky-600 hover:bg-sky-700 text-white rounded-lg text-sm font-medium shadow-xs flex items-center gap-2 transition-colors cursor-pointer">
              <Check className="w-4 h-4" />
              <span>{isEditing ? 'Save Changes' : 'Create Formula'}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
