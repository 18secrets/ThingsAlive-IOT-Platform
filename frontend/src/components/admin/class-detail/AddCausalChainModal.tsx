import React, { useEffect, useState } from 'react';
import { X, Check, Info, Plus, Trash2 } from 'lucide-react';
import { Input, InputNumber, SelectPicker } from 'rsuite';
import {
  ApiError, CausalChain, CausalChainInput, ChainDirection, ChainDriver, ChainNode,
} from '../../../lib/api';

interface AddCausalChainModalProps {
  isOpen: boolean;
  onClose: () => void;
  equipmentClassSlug: string;
  /** Signals this class declares — what a stage can predict. */
  availableSignals: string[];
  onCreate: (slug: string, input: CausalChainInput) => Promise<CausalChain>;
  existingChain?: CausalChain | null;
}

const slugify = (name: string) =>
  name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

const DIRECTION_OPTIONS: { label: string; value: ChainDirection }[] = [
  { label: 'Above expectation', value: 'above' },
  { label: 'Below expectation', value: 'below' },
  { label: 'Either direction', value: 'either' },
];

const emptyDriver = (): ChainDriver => ({ signal: '', coefficient: 0 });
const emptyNode = (signals: string[]): ChainNode => ({
  signal: signals[0] ?? '', intercept: 0, drivers: [emptyDriver()], warnAbove: 0, criticalAbove: 0, direction: 'above',
});

export const AddCausalChainModal: React.FC<AddCausalChainModalProps> = ({
  isOpen, onClose, equipmentClassSlug, availableSignals, onCreate, existingChain,
}) => {
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [outcome, setOutcome] = useState('');
  const [scenarioSlug, setScenarioSlug] = useState('');
  const [nodes, setNodes] = useState<ChainNode[]>([emptyNode(availableSignals)]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const isEditing = !!existingChain;

  useEffect(() => {
    if (!isOpen) return;
    setSlug(existingChain?.slug ?? '');
    setSlugTouched(isEditing);
    setName(existingChain?.name ?? '');
    setDescription(existingChain?.description ?? '');
    setOutcome(existingChain?.outcome ?? '');
    setScenarioSlug(existingChain?.scenarioSlug ?? '');
    setNodes(existingChain?.nodes?.length ? existingChain.nodes : [emptyNode(availableSignals)]);
    setError(undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, existingChain, isEditing]);

  if (!isOpen) return null;

  const handleNameChange = (value: string) => {
    setName(value);
    if (!slugTouched) setSlug(slugify(value));
  };

  const updateNode = (i: number, patch: Partial<ChainNode>) => {
    setNodes((prev) => prev.map((n, idx) => (idx === i ? { ...n, ...patch } : n)));
  };
  const addNode = () => setNodes((prev) => [...prev, emptyNode(availableSignals)]);
  const removeNode = (i: number) => setNodes((prev) => (prev.length > 1 ? prev.filter((_, idx) => idx !== i) : prev));

  const updateDriver = (nodeIdx: number, driverIdx: number, patch: Partial<ChainDriver>) => {
    setNodes((prev) => prev.map((n, idx) => (idx !== nodeIdx ? n : {
      ...n, drivers: n.drivers.map((d, di) => (di === driverIdx ? { ...d, ...patch } : d)),
    })));
  };
  const addDriver = (nodeIdx: number) => setNodes((prev) => prev.map((n, idx) => (idx !== nodeIdx ? n : { ...n, drivers: [...n.drivers, emptyDriver()] })));
  const removeDriver = (nodeIdx: number, driverIdx: number) => setNodes((prev) => prev.map((n, idx) => (idx !== nodeIdx ? n : {
    ...n, drivers: n.drivers.length > 1 ? n.drivers.filter((_, di) => di !== driverIdx) : n.drivers,
  })));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const finalSlug = slug.trim();
    const finalName = name.trim();
    if (!finalSlug || !finalName) return;

    const validNodes = nodes
      .filter((n) => n.signal.trim())
      .map((n) => ({
        signal: n.signal.trim(),
        label: n.label?.trim() || undefined,
        intercept: n.intercept,
        warnAbove: n.warnAbove,
        criticalAbove: n.criticalAbove,
        direction: n.direction,
        drivers: n.drivers
          .filter((d) => d.signal.trim())
          .map((d) => ({
            signal: d.signal.trim(),
            coefficient: d.coefficient,
            lagSeconds: d.lagSeconds || undefined,
          })),
      }));

    setBusy(true);
    setError(undefined);
    try {
      const input: CausalChainInput = {
        equipmentClassSlug,
        name: finalName,
        description: description.trim() || undefined,
        outcome: outcome.trim() || undefined,
        scenarioSlug: scenarioSlug.trim() || undefined,
        nodes: validNodes,
      };
      await onCreate(finalSlug, input);
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : `Could not ${isEditing ? 'save' : 'create'} this chain.`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-xs flex items-center justify-center p-4 z-50 animate-in fade-in duration-150">
      <div className="bg-white dark:bg-slate-800 rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-700 w-full max-w-3xl overflow-hidden flex flex-col animate-in zoom-in-95 duration-150">

        <div className="px-6 py-4 border-b border-slate-100 dark:border-slate-700 flex items-center justify-between bg-white dark:bg-slate-800">
          <div className="flex items-center gap-2.5">
            <span className="w-2.5 h-2.5 rounded-full bg-sky-600 ring-4 ring-sky-100 dark:ring-sky-950"></span>
            <div>
              <h3 className="font-bold text-slate-800 dark:text-white text-base">
                {isEditing ? 'Edit Causal Chain' : 'New Causal Chain'}
              </h3>
              <p className="text-xs text-slate-400 dark:text-slate-400">
                {isEditing
                  ? 'Editing the working draft — publishing it is a separate step, from the card.'
                  : 'Created as a draft. Publishing makes the version immutable.'}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-lg flex items-center justify-center text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="px-7 py-6 overflow-y-auto max-h-[calc(85vh-130px)] space-y-5">

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
                Chain Name <span className="text-rose-500">*</span>
              </label>
              <Input
                required
                autoFocus
                value={name}
                onChange={(value) => handleNameChange(value)}
                placeholder="e.g. Load to Coolant Overheat"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
                Slug <span className="text-rose-500">*</span>
              </label>
              <Input
                required
                disabled={isEditing}
                value={slug}
                onChange={(value) => { setSlug(value); setSlugTouched(true); }}
                placeholder="e.g. load-to-coolant-overheat"
                className="font-mono"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
              Description
            </label>
            <Input
              as="textarea"
              rows={2}
              value={description}
              onChange={(value) => setDescription(value)}
              placeholder="How the fault moves through this machine..."
            />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
                Outcome <span className="text-slate-400 font-normal">(optional)</span>
              </label>
              <Input value={outcome} onChange={(value) => setOutcome(value)} placeholder="What the far end is watching for" />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
                Scenario Slug <span className="text-slate-400 font-normal">(optional)</span>
              </label>
              <Input value={scenarioSlug} onChange={(value) => setScenarioSlug(value)} placeholder="the failure mode this is intelligence for" className="font-mono" />
            </div>
          </div>

          <div className="p-4 rounded-xl bg-sky-50/60 dark:bg-sky-950/40 border border-sky-100 dark:border-sky-900 space-y-4">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-slate-800 dark:text-white">Stages</span>
              <button
                type="button"
                onClick={addNode}
                className="text-[11px] text-sky-700 dark:text-sky-300 font-semibold flex items-center gap-1 hover:text-sky-800 dark:hover:text-sky-200 cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>Add stage</span>
              </button>
            </div>
            <p className="text-[10px] text-slate-400 -mt-2">
              In order, upstream first — each stage predicts one signal from the drivers below it.
            </p>

            {nodes.map((node, ni) => (
              <div key={ni} className="p-3.5 rounded-lg bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wide">Stage {ni + 1}</span>
                  <button
                    type="button"
                    onClick={() => removeNode(ni)}
                    disabled={nodes.length <= 1}
                    className="p-1 text-slate-400 hover:text-rose-600 disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer"
                    title="Remove stage"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>

                <div className="grid grid-cols-2 md:grid-cols-4 gap-2.5">
                  <div className="col-span-2 md:col-span-1">
                    <label className="block text-[10px] text-slate-500 dark:text-slate-400 mb-1">Signal</label>
                    <SelectPicker
                      size="sm"
                      data={availableSignals.map((s) => ({ label: s, value: s }))}
                      value={node.signal}
                      onChange={(value) => updateNode(ni, { signal: value ?? '' })}
                      placeholder="no signals on this class"
                      block
                      searchable={false}
                      cleanable={false}
                      className="font-mono"
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] text-slate-500 dark:text-slate-400 mb-1">Label</label>
                    <Input size="sm" value={node.label ?? ''} onChange={(value) => updateNode(ni, { label: value })} placeholder="optional" />
                  </div>
                  <div>
                    <label className="block text-[10px] text-slate-500 dark:text-slate-400 mb-1">Intercept</label>
                    <InputNumber size="sm" value={node.intercept} onChange={(value) => updateNode(ni, { intercept: Number(value) || 0 })} />
                  </div>
                  <div>
                    <label className="block text-[10px] text-slate-500 dark:text-slate-400 mb-1">Direction</label>
                    <SelectPicker
                      size="sm"
                      data={DIRECTION_OPTIONS}
                      value={node.direction ?? 'above'}
                      onChange={(value) => updateNode(ni, { direction: (value ?? 'above') as ChainDirection })}
                      block
                      searchable={false}
                      cleanable={false}
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] text-slate-500 dark:text-slate-400 mb-1">Warn above</label>
                    <InputNumber size="sm" value={node.warnAbove} onChange={(value) => updateNode(ni, { warnAbove: Number(value) || 0 })} />
                  </div>
                  <div>
                    <label className="block text-[10px] text-slate-500 dark:text-slate-400 mb-1">Critical above</label>
                    <InputNumber size="sm" value={node.criticalAbove} onChange={(value) => updateNode(ni, { criticalAbove: Number(value) || 0 })} />
                  </div>
                </div>

                <div className="pl-3 border-l-2 border-amber-200 dark:border-amber-800 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wide">Drivers</span>
                    <button
                      type="button"
                      onClick={() => addDriver(ni)}
                      className="text-[10px] text-amber-700 dark:text-amber-300 font-semibold flex items-center gap-1 hover:text-amber-800 dark:hover:text-amber-200 cursor-pointer"
                    >
                      <Plus className="w-3 h-3" />
                      <span>Add driver</span>
                    </button>
                  </div>
                  {node.drivers.map((driver, di) => (
                    <div key={di} className="grid grid-cols-[2fr_1fr_1fr_auto] gap-2 items-center">
                      <Input
                        size="sm"
                        value={driver.signal}
                        onChange={(value) => updateDriver(ni, di, { signal: value })}
                        placeholder="driver signal, e.g. load_pct"
                        className="font-mono"
                      />
                      <InputNumber
                        size="sm"
                        value={driver.coefficient}
                        onChange={(value) => updateDriver(ni, di, { coefficient: Number(value) || 0 })}
                        placeholder="coefficient"
                      />
                      <InputNumber
                        size="sm"
                        value={driver.lagSeconds ?? ''}
                        onChange={(value) => updateDriver(ni, di, { lagSeconds: value === '' ? undefined : Number(value) })}
                        placeholder="lag (s)"
                      />
                      <button
                        type="button"
                        onClick={() => removeDriver(ni, di)}
                        disabled={node.drivers.length <= 1}
                        className="p-1 text-slate-400 hover:text-rose-600 disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer"
                        title="Remove driver"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>

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
              <button
                type="button"
                onClick={onClose}
                className="px-5 py-2.5 rounded-xl border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-700 dark:text-slate-200 text-xs font-semibold hover:bg-slate-50 dark:hover:bg-slate-600 transition-colors cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={busy}
                className="px-6 py-2.5 rounded-xl bg-sky-600 hover:bg-sky-700 active:bg-sky-800 text-white text-xs font-semibold transition-colors shadow-xs flex items-center gap-2 cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed"
              >
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
