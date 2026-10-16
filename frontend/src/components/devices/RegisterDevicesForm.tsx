import React, { useState } from 'react';
import { ArrowLeft, ArrowRight, Plus, Trash2, Info, CheckCircle2 } from 'lucide-react';
import { Input, SelectPicker } from 'rsuite';
import { useTranslation } from 'react-i18next';
import { ApiError, RegisterDeviceInput, ToolMapping } from '../../lib/api';

interface RegisterDevicesFormProps {
  onBack: () => void;
  toolMappings: ToolMapping[];
  onRegister: (devices: RegisterDeviceInput[]) => Promise<{ registered: number; alreadyKnown: number }>;
}

interface DeviceRow {
  imei: string;
  model: string;
}

const emptyRow = (): DeviceRow => ({ imei: '', model: '' });

export const RegisterDevicesForm: React.FC<RegisterDevicesFormProps> = ({ onBack, toolMappings, onRegister }) => {
  const { t } = useTranslation(['devices', 'shared']);
  const [rows, setRows] = useState<DeviceRow[]>([emptyRow()]);
  const [toolMappingId, setToolMappingId] = useState('');
  const [batchRef, setBatchRef] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [result, setResult] = useState<{ registered: number; alreadyKnown: number } | null>(null);

  const updateRow = (index: number, field: keyof DeviceRow, value: string) =>
    setRows((prev) => prev.map((r, i) => (i === index ? { ...r, [field]: value } : r)));
  const addRow = () => setRows((prev) => [...prev, emptyRow()]);
  const removeRow = (index: number) => setRows((prev) => (prev.length > 1 ? prev.filter((_, i) => i !== index) : prev));

  const toolMappingOptions = toolMappings.map((tm) => ({ label: tm.toolName, value: tm.id }));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const devices: RegisterDeviceInput[] = rows
      .filter((r) => r.imei.trim())
      .map((r) => ({
        imei: r.imei.trim(),
        model: r.model.trim() || undefined,
        toolMappingId: toolMappingId || undefined,
        batchRef: batchRef.trim() || undefined,
        notes: notes.trim() || undefined,
      }));
    if (!devices.length) return;

    setBusy(true);
    setError(undefined);
    setResult(null);
    try {
      const outcome = await onRegister(devices);
      setResult(outcome);
      setRows([emptyRow()]);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('register.failed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div id="device-register-view" className="space-y-3 max-w-3xl mx-auto">
      <div className="flex items-center justify-between">
        <button
          onClick={onBack}
          className="flex items-center gap-2 text-xs font-semibold text-slate-600 hover:text-sky-600 dark:text-slate-400 dark:hover:text-sky-400 transition-colors cursor-pointer"
        >
          <ArrowLeft className="w-4 h-4" />
          <span>{t('register.backToPool')}</span>
        </button>
      </div>

      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg shadow-xs overflow-hidden">
        <div className="px-6 py-5 border-b border-slate-200 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-800/40">
          <h2 className="text-lg font-semibold text-slate-800 dark:text-slate-100">{t('register.title')}</h2>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
            {t('register.introPage')}
          </p>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-5 text-sm">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                {t('register.toolMapping')} <span className="text-slate-400 font-normal">{t('register.optionalSuffix')}</span>
              </label>
              <SelectPicker
                data={toolMappingOptions}
                value={toolMappingId || null}
                onChange={(value) => setToolMappingId(value ?? '')}
                placeholder={t('register.noToolProfile')}
                block
                searchable={toolMappingOptions.length > 6}
                cleanable
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                {t('register.batchRef')} <span className="text-slate-400 font-normal">{t('register.optionalSuffix')}</span>
              </label>
              <Input
                value={batchRef}
                onChange={(value) => setBatchRef(value)}
                placeholder={t('register.batchPlaceholder')}
              />
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                {t('translation:sidebar.devices')} <span className="text-rose-500">*</span>
              </label>
              <button
                type="button"
                onClick={addRow}
                className="text-sky-600 dark:text-sky-400 font-medium text-xs flex items-center gap-1 hover:text-sky-700 cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5" />
                {t('register.addRow')}
              </button>
            </div>
            <div className="space-y-2">
              {rows.map((row, index) => (
                <div key={index} className="grid grid-cols-12 gap-2 items-center">
                  <Input
                    value={row.imei}
                    onChange={(value) => updateRow(index, 'imei', value)}
                    placeholder={t('register.imeiPlaceholder')}
                    className="col-span-7 font-mono"
                  />
                  <Input
                    value={row.model}
                    onChange={(value) => updateRow(index, 'model', value)}
                    placeholder={t('register.modelPlaceholder')}
                    className="col-span-4"
                  />
                  <button
                    type="button"
                    onClick={() => removeRow(index)}
                    disabled={rows.length === 1}
                    className="col-span-1 flex items-center justify-center text-slate-400 hover:text-red-500 disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer"
                    title={t('register.removeRow')}
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
              {t('edit.notes')} <span className="text-slate-400 font-normal">{t('register.optionalSuffix')}</span>
            </label>
            <Input
              as="textarea"
              rows={2}
              value={notes}
              onChange={(value) => setNotes(value)}
            />
          </div>

          {error && (
            <div className="flex items-center gap-2 text-xs text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 rounded-lg px-3 py-2">
              <Info className="w-3.5 h-3.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {result && (
            <div className="flex items-center gap-2 text-xs text-emerald-700 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-900 rounded-lg px-3 py-2">
              <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
              <span>
                {t(result.alreadyKnown ? 'register.resultWithSkipped' : 'register.result', { registered: result.registered, skipped: result.alreadyKnown })}
              </span>
            </div>
          )}

          <div className="pt-4 border-t border-slate-200 dark:border-slate-800 flex items-center justify-end gap-3">
            <button
              type="button"
              onClick={onBack}
              className="px-4 py-2 border border-slate-200 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300 text-sm font-medium hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors cursor-pointer"
            >
              {t('shared:done')}
            </button>
            <button
              type="submit"
              disabled={busy}
              className="px-5 py-2 bg-[#0B7285] hover:bg-[#095C6B] text-white rounded-lg text-sm font-medium shadow-xs flex items-center gap-2 transition-colors cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed"
            >
              <span>{busy ? t('register.registering') : t('register.submit')}</span>
              <ArrowRight className="w-4 h-4" />
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
