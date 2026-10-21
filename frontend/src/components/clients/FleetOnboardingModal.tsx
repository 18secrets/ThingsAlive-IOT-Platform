import React, { useEffect, useState } from 'react';
import { AlertCircle, AlertTriangle, CheckCircle2, Cpu, Wrench } from 'lucide-react';
import { ApiError, FleetConflictReason, FleetOnboardingPlan, apiApplyFleetOnboarding, apiGetFleetOnboardingPlan } from '../../lib/api';
import { useTranslation } from 'react-i18next';
import { Modal } from '../common/Modal';

// Labels live under fleet.conflict.<reason>; the raw reason shows if a new one appears.
const conflictLabel = (t: (key: string, opts?: { defaultValue: string }) => string, reason: FleetConflictReason) =>
  t(`fleet.conflict.${reason}`, { defaultValue: reason });

/**
 * Bringing one client's existing 1.0 fleet into 2.0's register (QONBOARD1): the plan
 * first, written nowhere, then apply. Apply recomputes the plan itself and only ever
 * adds, so what it does can differ from the preview only by what changed in between.
 * Conflicts are shown, never resolved here — each is a decision for a person.
 */
export const FleetOnboardingModal: React.FC<{
  client: { id: string; clientName: string } | null;
  onClose: () => void;
}> = ({ client, onClose }) => {
  const { t } = useTranslation('accounts');
  return (
    <Modal isOpen={!!client} onClose={onClose} title={t('fleet.title')} subtitle={client?.clientName} maxWidth="max-w-2xl">
      {client && <FleetOnboardingBody key={client.id} tenantId={client.id} />}
    </Modal>
  );
};

const FleetOnboardingBody: React.FC<{ tenantId: string }> = ({ tenantId }) => {
  const { t } = useTranslation('accounts');
  const [plan, setPlan] = useState<FleetOnboardingPlan | null>(null);
  const [error, setError] = useState<string | undefined>(undefined);
  const [applying, setApplying] = useState(false);
  const [notice, setNotice] = useState<string | undefined>(undefined);

  const load = () => apiGetFleetOnboardingPlan(tenantId)
    .then((p) => { setPlan(p); setError(undefined); })
    .catch((err) => setError(err instanceof ApiError ? err.message : t('fleet.readFailed')));

  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [tenantId]);

  if (error && !plan) return <p className="text-sm text-rose-600 dark:text-rose-400">{error}</p>;
  if (!plan) return <p className="text-sm text-slate-500">{t('fleet.reading')}</p>;

  const toDo = plan.createMachines.length + plan.registerDevices.length + plan.claimDevices.length;

  async function apply() {
    if (!window.confirm(t('fleet.confirm', {
      machines: t('fleet.machineCount', { count: plan!.createMachines.length }),
      fittings: t('fleet.fittingCount', { count: plan!.registerDevices.length + plan!.claimDevices.length }),
    }))) return;
    setApplying(true);
    setError(undefined);
    try {
      const r = await apiApplyFleetOnboarding(tenantId);
      setNotice(t('fleet.applied', {
        machines: t('fleet.machineCount', { count: r.createMachines.length }),
        loggers: t('fleet.loggerCount', { count: r.registerDevices.length }),
        fitted: r.claimDevices.length,
      }));
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('fleet.applyFailed'));
    } finally {
      setApplying(false);
    }
  }

  return (
    <div className="space-y-4 text-xs">
      <p className="text-slate-500 dark:text-slate-400">
        {t('fleet.intro')}
      </p>

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

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Stat label={t('fleet.stat.machinesToAdd')} value={plan.createMachines.length} />
        <Stat label={t('fleet.stat.loggersToRegister')} value={plan.registerDevices.length} />
        <Stat label={t('fleet.stat.loggersToFit')} value={plan.claimDevices.length} />
        <Stat label={t('fleet.stat.alreadyOnboarded')} value={plan.alreadyOnboarded} muted />
      </div>

      {plan.createMachines.length > 0 && (
        <Section icon={<Wrench className="w-3.5 h-3.5" />} title={t('fleet.machinesSection')}>
          {plan.createMachines.map((m) => (
            <Row key={`${m.sourceSystem}/${m.externalId}`} left={m.name ?? m.externalId} right={`${m.sourceSystem}/${m.externalId}`} />
          ))}
        </Section>
      )}

      {plan.registerDevices.length + plan.claimDevices.length > 0 && (
        <Section icon={<Cpu className="w-3.5 h-3.5" />} title={t('fleet.loggersSection')}>
          {plan.registerDevices.map((d) => <Row key={`r-${d.imei}`} left={d.imei} right={t('fleet.registerAndFit', { machine: d.equipmentExternalId })} />)}
          {plan.claimDevices.map((d) => <Row key={`c-${d.imei}`} left={d.imei} right={t('fleet.claimAndFit', { machine: d.equipmentExternalId })} />)}
        </Section>
      )}

      {plan.conflicts.length > 0 && (
        <Section icon={<AlertTriangle className="w-3.5 h-3.5 text-amber-500" />} title={t('fleet.conflictsSection', { count: plan.conflicts.length })}>
          {plan.conflicts.map((c, i) => (
            <div key={`${c.imei}-${i}`} className="border-t border-slate-100 dark:border-slate-800 pt-1.5">
              <p className="text-slate-700 dark:text-slate-200"><span className="font-mono">{c.imei}</span> · {conflictLabel(t, c.reason)}</p>
              <p className="text-[11px] text-slate-400">{c.detail}</p>
            </div>
          ))}
        </Section>
      )}

      <div className="pt-3 border-t border-slate-100 dark:border-slate-800 flex items-center justify-between gap-3">
        <span className="text-[11px] text-slate-400">
          {toDo === 0 ? t('fleet.nothingToAdd') : t('fleet.changesToAdd', { count: toDo })}
        </span>
        <button
          onClick={apply}
          disabled={toDo === 0 || applying}
          className="px-4 py-2 rounded-lg bg-sky-600 hover:bg-sky-700 text-white text-sm font-semibold disabled:opacity-50 cursor-pointer"
        >
          {applying ? t('fleet.applying') : t('fleet.apply')}
        </button>
      </div>
    </div>
  );
};

const Stat: React.FC<{ label: string; value: number; muted?: boolean }> = ({ label, value, muted }) => (
  <div className="border border-slate-200 dark:border-slate-800 rounded-lg p-3">
    <div className={`text-xl font-bold ${muted ? 'text-slate-400' : 'text-slate-800 dark:text-slate-100'}`}>{value}</div>
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
