import React, { useRef, useState } from 'react';
import { AlertCircle, AlertTriangle, CheckCircle2, Cpu, Download, FileSpreadsheet, Wrench, XCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  ApiError, FleetImportConflictReason, FleetImportPlan,
  apiApplyFleetImport, apiDownloadFleetImportTemplate, apiPlanFleetImport,
} from '../../lib/api';
import { Modal } from '../common/Modal';

/**
 * Bulk upload of one client's machines and logger fittings from a workbook (/fleet-import).
 * The plan is read from the file and written nowhere; apply sends the same file again and
 * the server rebuilds the plan itself, so it does what the data says at that moment. Row
 * errors block the whole apply; conflicts are listed and left alone, each a decision for
 * a person. Loggers must already be assigned to the client: the Devices sheet fits them
 * to machines, it does not register them.
 */
export const FleetImportModal: React.FC<{
  client: { id: string; clientName: string } | null;
  onClose: () => void;
}> = ({ client, onClose }) => {
  const { t } = useTranslation('accounts');
  return (
    <Modal isOpen={!!client} onClose={onClose} title={t('fleetImport.title')} subtitle={client?.clientName} maxWidth="max-w-2xl">
      {client && <FleetImportBody key={client.id} tenantId={client.id} />}
    </Modal>
  );
};

const FleetImportBody: React.FC<{ tenantId: string }> = ({ tenantId }) => {
  const { t } = useTranslation('accounts');
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [plan, setPlan] = useState<FleetImportPlan | null>(null);
  const [busy, setBusy] = useState<'template' | 'plan' | 'apply' | null>(null);
  const [error, setError] = useState<string | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);

  const fail = (err: unknown, fallback: string) => setError(err instanceof ApiError ? err.message : fallback);

  const downloadTemplate = async () => {
    setBusy('template');
    setError(undefined);
    try {
      const blob = await apiDownloadFleetImportTemplate();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'fleet-import-template.xlsx';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      fail(err, t('fleetImport.templateFailed'));
    } finally {
      setBusy(null);
    }
  };

  const readPlan = async (chosen: File) => {
    setBusy('plan');
    setError(undefined);
    try {
      setPlan(await apiPlanFleetImport(chosen, tenantId));
    } catch (err) {
      setPlan(null);
      fail(err, t('fleetImport.readFailed'));
    } finally {
      setBusy(null);
    }
  };

  const choose = (chosen: File | undefined) => {
    if (!chosen) return;
    setFile(chosen);
    setNotice(undefined);
    readPlan(chosen);
  };

  const toAdd = plan ? plan.equipment.create.length + plan.devices.claim.length : 0;
  const errors = plan
    ? [...plan.equipment.errors.map((e) => ({ ...e, sheet: 'Equipment' })), ...plan.devices.errors.map((e) => ({ ...e, sheet: 'Devices' }))]
    : [];

  const apply = async () => {
    if (!file || !plan) return;
    if (!window.confirm(t('fleetImport.confirm', {
      machines: t('fleetImport.machineCount', { count: plan.equipment.create.length }),
      fittings: t('fleetImport.fittingCount', { count: plan.devices.claim.length }),
    }))) return;
    setBusy('apply');
    setError(undefined);
    try {
      const done = await apiApplyFleetImport(file, tenantId);
      setNotice(t('fleetImport.applied', {
        machines: t('fleetImport.machineCount', { count: done.equipment.create.length }),
        fittings: t('fleetImport.fittingCount', { count: done.devices.claim.length }),
      }));
      // Read again, so the preview shows the register as it now stands: all unchanged.
      setPlan(await apiPlanFleetImport(file, tenantId));
    } catch (err) {
      fail(err, t('fleetImport.applyFailed'));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-4 text-xs">
      <p className="text-slate-500 dark:text-slate-400">{t('fleetImport.intro')}</p>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={downloadTemplate}
          disabled={busy !== null}
          className="px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 font-semibold flex items-center gap-1.5 disabled:opacity-50 cursor-pointer"
        >
          <Download className="w-3.5 h-3.5" />{t('fleetImport.downloadTemplate')}
        </button>
        <button
          type="button"
          onClick={() => input.current?.click()}
          disabled={busy !== null}
          className="px-3 py-2 rounded-lg border border-sky-300 dark:border-sky-800 text-sky-700 dark:text-sky-300 hover:bg-sky-50 dark:hover:bg-sky-950/40 font-semibold flex items-center gap-1.5 disabled:opacity-50 cursor-pointer"
        >
          <FileSpreadsheet className="w-3.5 h-3.5" />{file ? t('fleetImport.chooseAnother') : t('fleetImport.chooseFile')}
        </button>
        <input
          ref={input}
          type="file"
          accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          className="hidden"
          // Reset so choosing the same file again (after fixing it) reads it again.
          onChange={(e) => { choose(e.target.files?.[0]); e.target.value = ''; }}
        />
        {file && <span className="text-slate-500 dark:text-slate-400 truncate max-w-[220px]">{file.name}</span>}
        {file && (
          <button type="button" onClick={() => readPlan(file)} disabled={busy !== null} className="text-sky-600 dark:text-sky-400 hover:underline disabled:opacity-50 cursor-pointer">
            {t('fleetImport.recheck')}
          </button>
        )}
      </div>

      {busy === 'plan' && <p className="text-slate-500">{t('fleetImport.reading')}</p>}

      {error && (
        <div className="flex items-start gap-2 text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 rounded-lg px-3 py-2">
          <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" /><span>{error}</span>
        </div>
      )}
      {notice && (
        <div className="flex items-start gap-2 text-emerald-700 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-900 rounded-lg px-3 py-2">
          <CheckCircle2 className="w-3.5 h-3.5 shrink-0 mt-0.5" /><span>{notice}</span>
        </div>
      )}

      {plan && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Stat label={t('fleetImport.stat.machinesToAdd')} value={plan.equipment.create.length} />
            <Stat label={t('fleetImport.stat.loggersToFit')} value={plan.devices.claim.length} />
            <Stat label={t('fleetImport.stat.unchanged')} value={plan.equipment.unchanged + plan.devices.alreadyClaimed} muted />
            <Stat label={t('fleetImport.stat.errors')} value={errors.length} tone={errors.length ? 'rose' : undefined} />
          </div>

          {errors.length > 0 && (
            <Section icon={<XCircle className="w-3.5 h-3.5 text-rose-500" />} title={t('fleetImport.errorsSection', { count: errors.length })}>
              {errors.map((e, i) => (
                <div key={`${e.sheet}-${e.row}-${i}`} className="border-t border-slate-100 dark:border-slate-800 pt-1.5">
                  <p className="text-rose-700 dark:text-rose-300">{t('fleetImport.rowRef', { sheet: e.sheet, row: e.row })}</p>
                  <p className="text-[11px] text-slate-500 dark:text-slate-400">{e.message}</p>
                </div>
              ))}
            </Section>
          )}

          {plan.equipment.create.length > 0 && (
            <Section icon={<Wrench className="w-3.5 h-3.5" />} title={t('fleetImport.machinesSection')}>
              {plan.equipment.create.map((m) => (
                <Row
                  key={`m-${m.row}`}
                  left={`${m.code} · ${m.name}`}
                  right={[m.siteCode && t('fleetImport.atSite', { site: m.siteCode }), m.equipmentClassSlug ?? t('fleetImport.unclassified')].filter(Boolean).join(' · ')}
                />
              ))}
            </Section>
          )}

          {plan.devices.claim.length > 0 && (
            <Section icon={<Cpu className="w-3.5 h-3.5" />} title={t('fleetImport.loggersSection')}>
              {plan.devices.claim.map((d) => <Row key={`d-${d.row}`} left={d.imei} right={t('fleetImport.fitTo', { machine: d.equipmentCode })} />)}
            </Section>
          )}

          {plan.equipment.conflicts.length + plan.devices.conflicts.length > 0 && (
            <Section
              icon={<AlertTriangle className="w-3.5 h-3.5 text-amber-500" />}
              title={t('fleetImport.conflictsSection', { count: plan.equipment.conflicts.length + plan.devices.conflicts.length })}
            >
              {plan.equipment.conflicts.map((c) => (
                <div key={`ec-${c.row}`} className="border-t border-slate-100 dark:border-slate-800 pt-1.5">
                  <p className="text-slate-700 dark:text-slate-200">
                    <span className="font-mono">{c.code}</span> · {t('fleetImport.differs', { fields: c.fields.join(', ') })}
                  </p>
                  <p className="text-[11px] text-slate-400">{c.detail}</p>
                </div>
              ))}
              {plan.devices.conflicts.map((c) => (
                <div key={`dc-${c.row}`} className="border-t border-slate-100 dark:border-slate-800 pt-1.5">
                  <p className="text-slate-700 dark:text-slate-200"><span className="font-mono">{c.imei}</span> · {conflictLabel(t, c.reason)}</p>
                  <p className="text-[11px] text-slate-400">{c.detail}</p>
                </div>
              ))}
            </Section>
          )}

          <div className="pt-3 border-t border-slate-100 dark:border-slate-800 flex items-center justify-between gap-3">
            <span className="text-[11px] text-slate-400">
              {!plan.canApply ? t('fleetImport.fixErrors') : toAdd === 0 ? t('fleetImport.nothingToAdd') : t('fleetImport.changesToAdd', { count: toAdd })}
            </span>
            <button
              onClick={apply}
              disabled={!plan.canApply || toAdd === 0 || busy !== null}
              className="px-4 py-2 rounded-lg bg-sky-600 hover:bg-sky-700 text-white text-sm font-semibold disabled:opacity-50 cursor-pointer"
            >
              {busy === 'apply' ? t('fleetImport.applying') : t('fleetImport.apply')}
            </button>
          </div>
        </>
      )}
    </div>
  );
};

// Labels live under fleetImport.conflict.<reason>; the raw reason shows if a new one appears.
const conflictLabel = (t: (key: string, opts?: { defaultValue: string }) => string, reason: FleetImportConflictReason) =>
  t(`fleetImport.conflict.${reason}`, { defaultValue: reason });

const Stat: React.FC<{ label: string; value: number; muted?: boolean; tone?: 'rose' }> = ({ label, value, muted, tone }) => (
  <div className="border border-slate-200 dark:border-slate-800 rounded-lg p-3">
    <div className={`text-xl font-bold ${tone === 'rose' ? 'text-rose-600 dark:text-rose-400' : muted ? 'text-slate-400' : 'text-slate-800 dark:text-slate-100'}`}>{value}</div>
    <div className="text-[11px] text-slate-400">{label}</div>
  </div>
);

const Section: React.FC<{ icon: React.ReactNode; title: string; children: React.ReactNode }> = ({ icon, title, children }) => (
  <div className="space-y-1.5">
    <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400">{icon}{title}</p>
    <div className="space-y-1.5 max-h-48 overflow-y-auto pr-1">{children}</div>
  </div>
);

const Row: React.FC<{ left: string; right: string }> = ({ left, right }) => (
  <div className="flex items-center justify-between gap-2 border-t border-slate-100 dark:border-slate-800 pt-1.5">
    <span className="text-slate-700 dark:text-slate-200 font-mono">{left}</span>
    <span className="text-slate-400 text-right">{right}</span>
  </div>
);
