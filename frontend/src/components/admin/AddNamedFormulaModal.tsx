import React, { useEffect, useState } from 'react';
import { X, Check, Info, Plus, Trash2 } from 'lucide-react';
import { Input, SelectPicker } from 'rsuite';
import { ApiError, NamedFormula, NamedFormulaInput, NamedFormulaRoleInput } from '../../lib/api';

interface AddNamedFormulaModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreate: (slug: string, input: NamedFormulaInput) => Promise<NamedFormula>;
  onUpdate: (slug: string, version: number, input: NamedFormulaInput) => Promise<NamedFormula>;
  /** The representative row for this slug — draft if one exists, else the latest
   *  published version (read-only fields disabled once published, same rule the
   *  backend enforces). */
  existingFormula?: NamedFormula | null;
}

const slugify = (name: string) =>
  name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

const emptyInput = (): NamedFormulaRoleInput => ({ role: '', dimension: '', description: '', expectedParameters: [] });

export const AddNamedFormulaModal: React.FC<AddNamedFormulaModalProps> = ({
  isOpen, onClose, onCreate, onUpdate, existingFormula,
}) => {
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [name, setName] = useState('');
  const [category, setCategory] = useState('');
  const [description, setDescription] = useState('');
  const [expression, setExpression] = useState('');
  const [resultDimension, setResultDimension] = useState('');
  const [resultKind, setResultKind] = useState<'scalar' | 'series' | ''>('');
  const [inputs, setInputs] = useState<NamedFormulaRoleInput[]>([emptyInput()]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const isEditing = !!existingFormula;
  const isPublished = existingFormula?.status === 'published';

  useEffect(() => {
    if (!isOpen) return;
    setSlug(existingFormula?.slug ?? '');
    setSlugTouched(isEditing);
    setName(existingFormula?.name ?? '');
    setCategory(existingFormula?.category ?? '');
    setDescription(existingFormula?.description ?? '');
    setExpression(existingFormula?.expression ?? '');
    setResultDimension(existingFormula?.resultDimension ?? '');
    setResultKind(existingFormula?.resultKind ?? '');
    setInputs(existingFormula?.inputs?.length ? existingFormula.inputs : [emptyInput()]);
    setError(undefined);
  }, [isOpen, existingFormula, isEditing]);

  if (!isOpen) return null;

  const handleNameChange = (value: string) => {
    setName(value);
    if (!slugTouched) setSlug(slugify(value));
  };

  const updateInput = (index: number, field: 'role' | 'dimension' | 'description', value: string) => {
    setInputs((prev) => prev.map((r, i) => (i === index ? { ...r, [field]: value } : r)));
  };
  const updateInputParams = (index: number, value: string) => {
    const params = value.split(',').map((p) => p.trim()).filter(Boolean);
    setInputs((prev) => prev.map((r, i) => (i === index ? { ...r, expectedParameters: params } : r)));
  };
  const addInputRow = () => setInputs((prev) => [...prev, emptyInput()]);
  const removeInputRow = (index: number) => setInputs((prev) => (prev.length > 1 ? prev.filter((_, i) => i !== index) : prev));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const finalSlug = slug.trim();
    const finalName = name.trim();
    if (!finalSlug || !finalName || !expression.trim()) return;

    const validInputs = inputs
      .filter((r) => r.role.trim() && r.dimension.trim())
      .map((r) => ({
        role: r.role.trim(),
        dimension: r.dimension.trim(),
        description: r.description?.trim() || undefined,
        expectedParameters: r.expectedParameters?.length ? r.expectedParameters : undefined,
      }));

    setBusy(true);
    setError(undefined);
    try {
      const input: NamedFormulaInput = {
        name: finalName,
        description: description.trim() || undefined,
        category: category.trim() || undefined,
        expression: expression.trim(),
        inputs: validInputs,
        resultDimension: resultDimension.trim() || undefined,
        resultKind: resultKind || undefined,
      };
      if (isEditing && existingFormula) {
        await onUpdate(finalSlug, existingFormula.version, input);
      } else {
        await onCreate(finalSlug, input);
      }
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : `Could not ${isEditing ? 'save' : 'create'} the formula.`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      id="addNamedFormulaModalOverlay"
      className="fixed inset-0 bg-slate-900/50 backdrop-blur-xs flex items-center justify-center p-4 z-50 animate-in fade-in duration-150"
    >
      <div className="bg-white dark:bg-slate-800 rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-700 w-full max-w-2xl overflow-hidden flex flex-col animate-in zoom-in-95 duration-150">
        <div className="px-6 py-4 border-b border-slate-100 dark:border-slate-700 flex items-center justify-between bg-white dark:bg-slate-800">
          <div className="flex items-center gap-2.5">
            <span className="w-2.5 h-2.5 rounded-full bg-sky-600 ring-4 ring-sky-100 dark:ring-sky-950"></span>
            <div>
              <h3 className="font-bold text-slate-800 dark:text-white text-base">
                {isEditing ? 'Edit Named Formula' : 'New Named Formula'}
              </h3>
              <p className="text-xs text-slate-400 dark:text-slate-400">
                {isPublished
                  ? 'Published and immutable — editing is refused server-side.'
                  : isEditing
                    ? 'Editing the working draft — publishing it is a separate step, from the card.'
                    : 'Created as a draft. No class can bind to it until it is published.'}
              </p>
            </div>
          </div>
          <button onClick={onClose} className="w-8 h-8 rounded-lg flex items-center justify-center text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors cursor-pointer">
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="px-7 py-6 overflow-y-auto max-h-[calc(85vh-130px)] space-y-5">
          <fieldset disabled={isPublished} className="space-y-5">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
                  Name <span className="text-rose-500">*</span>
                </label>
                <Input size="sm" required autoFocus value={name} onChange={handleNameChange} placeholder="e.g. Specific fuel consumption" />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
                  Slug <span className="text-rose-500">*</span>
                </label>
                <Input size="sm" required disabled={isEditing} value={slug} onChange={(value) => { setSlug(value); setSlugTouched(true); }} placeholder="e.g. specific-fuel-consumption" />
                <p className="text-[10px] text-slate-400 mt-1">
                  {isEditing ? 'Permanent — every class binding references it.' : 'Auto-filled from the name.'}
                </p>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
                  Category <span className="text-slate-400 font-normal">(optional)</span>
                </label>
                <Input size="sm" value={category} onChange={(value) => setCategory(value)} placeholder="e.g. fuel, duty-cycle" />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
                  Result dimension <span className="text-slate-400 font-normal">(optional — inferred if left blank)</span>
                </label>
                <Input size="sm" value={resultDimension} onChange={(value) => setResultDimension(value)} placeholder="e.g. L/kWh" />
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5">Description</label>
              <Input as="textarea" size="sm" rows={2} value={description} onChange={(value) => setDescription(value)} />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
                Expression <span className="text-rose-500">*</span>
              </label>
              <Input size="sm" required value={expression} onChange={(value) => setExpression(value)} placeholder="e.g. fuel_rate / power_output" />
              <p className="text-[10px] text-slate-400 mt-1">Written against roles below, never signal names directly — a class binds each role to one of its own signals.</p>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5">Result kind <span className="text-slate-400 font-normal">(optional — inferred if left blank)</span></label>
              <SelectPicker
                size="sm"
                data={[{ label: 'Scalar', value: 'scalar' }, { label: 'Series', value: 'series' }]}
                value={resultKind || null}
                onChange={(value) => setResultKind((value ?? '') as 'scalar' | 'series' | '')}
                searchable={false}
                cleanable
                block
              />
            </div>

            <div className="p-4 rounded-xl bg-sky-50/60 dark:bg-sky-950/40 border border-sky-100 dark:border-sky-900 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-slate-800 dark:text-white">Roles</span>
                <button type="button" onClick={addInputRow} className="text-[11px] text-sky-700 dark:text-sky-300 font-semibold flex items-center gap-1 hover:text-sky-800 dark:hover:text-sky-200 cursor-pointer">
                  <Plus className="w-3.5 h-3.5" /><span>Add role</span>
                </button>
              </div>
              <p className="text-[10px] text-slate-400 -mt-1">Each name in the expression (e.g. "fuel_rate") needs a role declaring its dimension.</p>

              {inputs.map((r, i) => (
                <div key={i} className="p-3 rounded-lg bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 space-y-2">
                  <div className="grid grid-cols-[1fr_1fr_auto] gap-2 items-center">
                    <Input size="sm" value={r.role} onChange={(value) => updateInput(i, 'role', value)} placeholder="role, e.g. fuel_rate" />
                    <Input size="sm" value={r.dimension} onChange={(value) => updateInput(i, 'dimension', value)} placeholder="dimension, e.g. L/h" />
                    <button type="button" onClick={() => removeInputRow(i)} className="p-1.5 text-slate-400 hover:text-rose-600 cursor-pointer" title="Remove role">
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  <Input size="sm" value={r.description ?? ''} onChange={(value) => updateInput(i, 'description', value)} placeholder="description (optional)" />
                  <Input size="sm" value={r.expectedParameters?.join(', ') ?? ''} onChange={(value) => updateInputParams(i, value)} placeholder="expected parameters, comma-separated (optional)" />
                </div>
              ))}
            </div>
          </fieldset>

          {error && (
            <div className="text-xs text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 rounded-lg px-3 py-2">
              {error}
            </div>
          )}

          <div className="pt-3 border-t border-slate-100 dark:border-slate-700 flex items-center justify-between">
            <span className="text-[11px] text-slate-400 flex items-center gap-1.5">
              <Info className="w-3.5 h-3.5 text-slate-400" />
              Fields marked with <span className="text-rose-500 font-bold">*</span> are mandatory
            </span>
            <div className="flex items-center gap-3">
              <button type="button" onClick={onClose} className="px-5 py-2.5 rounded-xl border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-700 dark:text-slate-200 text-xs font-semibold hover:bg-slate-50 dark:hover:bg-slate-600 transition-colors cursor-pointer">
                Cancel
              </button>
              <button type="submit" disabled={busy || isPublished} className="px-6 py-2.5 rounded-xl bg-sky-600 hover:bg-sky-700 active:bg-sky-800 text-white text-xs font-semibold transition-colors shadow-xs flex items-center gap-2 cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed">
                <Check className="w-3.5 h-3.5" />
                <span>{busy ? 'Saving…' : (isEditing ? 'Save Draft' : 'Create Draft')}</span>
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
};
