import React, { useEffect, useMemo, useState } from 'react';
import {
  Search, Plus, CheckCircle2, Clock, Building2, Wrench, ListChecks, RotateCw, AlertCircle, ChevronRight,
} from 'lucide-react';
import { Input, SelectPicker } from 'rsuite';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import {
  ApiError, EquipmentProfile, MachineOnboarding, ONBOARDING_STEPS, OnboardingStepState,
  OnboardingSummary, SiteOnboarding, apiGetMachineOnboarding, apiGetOnboardingSummary, apiListEquipment,
} from '../../lib/api';
import { Chip } from '../common/Chip';
import { Modal } from '../common/Modal';

/**
 * Real onboarding progress (QONBOARD-STATUS), in place of the mock session list.
 *
 * A site is the "session" (§2 of the task): its machines, how many are fully onboarded,
 * and for each of the seven steps how many machines have it done. Nothing is stored —
 * every count is read from the table that owns the fact, so claiming a device on the
 * Devices page moves this list the same as anything done here would.
 */

// Step labels, their one-word chip forms, reasons, site statuses and step states are
// key maps in onboarding.json (step.*, stepShort.*, reason.*, siteStatus.*, stepState.*).

const STATE_TONE: Record<OnboardingStepState, 'emerald' | 'amber' | 'slate'> = {
  done: 'emerald', pending: 'amber', blocked: 'slate',
};

const SITE_STATUS: Record<SiteOnboarding['status'], { style: string }> = {
  completed: {
    style: 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800',
  },
  in_progress: {
    style: 'bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-800',
  },
  no_equipment: {
    style: 'bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 border-slate-200 dark:border-slate-700',
  },
};

const siteKey = (s: SiteOnboarding) => s.site?.id ?? 'no-site';
const siteName = (s: SiteOnboarding, t: TFunction<'onboarding'>) => (s.site ? s.site.name : t('progress.noSite'));

interface OnboardingProgressProps {
  /** Opens the AI setup chat, which stays a front-end assistant with no backend of its own. */
  onAddNew: () => void;
}

export const OnboardingProgress: React.FC<OnboardingProgressProps> = ({ onAddNew }) => {
  const { t } = useTranslation('onboarding');
  const [summary, setSummary] = useState<OnboardingSummary | null>(null);
  const [equipment, setEquipment] = useState<EquipmentProfile[]>([]);
  const [error, setError] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedStatus, setSelectedStatus] = useState<'All' | SiteOnboarding['status']>('All');
  const [viewing, setViewing] = useState<SiteOnboarding | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      // The summary carries counts only; the machine list comes from the register so a
      // site's View can list the machines those counts are about.
      const [s, e] = await Promise.all([apiGetOnboardingSummary(), apiListEquipment()]);
      setSummary(s);
      setEquipment(e);
      setError(undefined);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('progress.loadFailed'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const sites = summary?.sites ?? [];
  const filtered = useMemo(() => {
    const term = searchTerm.toLowerCase();
    return sites.filter((s) => {
      const matchesSearch = !term || siteName(s, t).toLowerCase().includes(term) || (s.site?.code.toLowerCase().includes(term) ?? false);
      return matchesSearch && (selectedStatus === 'All' || s.status === selectedStatus);
    });
  }, [sites, searchTerm, selectedStatus, t]);

  const completedCount = sites.filter((s) => s.status === 'completed').length;
  const inProgressCount = sites.filter((s) => s.status === 'in_progress').length;

  const machinesOf = (s: SiteOnboarding) => equipment.filter((e) => (e.plantId ?? null) === (s.site?.id ?? null));

  return (
    <div id="onboarding-list-view" className="space-y-3">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <MetricCard label={t('progress.sites')} value={sites.length} icon={<Building2 className="w-5 h-5" />} tone="sky" />
        <MetricCard label={t('siteStatus.completed')} value={completedCount} icon={<CheckCircle2 className="w-5 h-5" />} tone="emerald" />
        <MetricCard label={t('siteStatus.in_progress')} value={inProgressCount} icon={<Clock className="w-5 h-5" />} tone="amber" />
      </div>

      <div className="bg-white dark:bg-slate-900 p-4 rounded-xl border border-slate-200 dark:border-slate-800 shadow-xs flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex flex-1 items-center gap-3 flex-wrap">
          <div className="relative flex-1 min-w-[240px] max-w-md">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 z-10" />
            <Input
              value={searchTerm}
              onChange={(value) => setSearchTerm(value)}
              placeholder={t('progress.search')}
              size="sm"
              className="pl-9!"
            />
          </div>
          <SelectPicker
            data={[
              { label: t('progress.allStatuses'), value: 'All' },
              { label: t('siteStatus.completed'), value: 'completed' },
              { label: t('siteStatus.in_progress'), value: 'in_progress' },
              { label: t('siteStatus.no_equipment'), value: 'no_equipment' },
            ]}
            value={selectedStatus}
            onChange={(value) => setSelectedStatus((value ?? 'All') as typeof selectedStatus)}
            searchable={false}
            cleanable={false}
            size="sm"
          />
          <button
            onClick={load}
            disabled={loading}
            className="p-2 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-500 hover:text-sky-600 hover:border-sky-300 disabled:opacity-50 cursor-pointer"
            title={t('progress.refresh')}
          >
            <RotateCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>

        <button
          id="add-onboarding-btn"
          onClick={onAddNew}
          className="w-full sm:w-auto px-5 py-2.5 bg-sky-600 hover:bg-sky-700 text-white rounded-lg text-xs font-semibold shadow-xs flex items-center justify-center gap-2 transition-colors shrink-0 cursor-pointer"
        >
          <Plus className="w-4 h-4" />
          <span>{t('progress.newOnboarding')}</span>
        </button>
      </div>

      {error && (
        <div className="flex items-center gap-2 text-xs text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 rounded-lg px-3 py-2">
          <AlertCircle className="w-3.5 h-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-xs overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs whitespace-nowrap">
            <thead className="bg-slate-50 dark:bg-slate-800/60 border-b border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-400 font-semibold text-xs">
              <tr>
                <th className="py-3 px-4">{t('progress.col.site')}</th>
                <th className="py-3 px-4">{t('progress.col.equipment')}</th>
                <th className="py-3 px-4">{t('progress.col.onboarded')}</th>
                <th className="py-3 px-4">{t('progress.col.steps')}</th>
                <th className="py-3 px-4">{t('progress.col.status')}</th>
                <th className="py-3 px-4 text-center">{t('progress.col.view')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800 font-medium text-slate-800 dark:text-slate-200">
              {loading && !summary ? (
                <tr><td colSpan={6} className="py-8 text-center text-slate-400">{t('progress.loading')}</td></tr>
              ) : filtered.length > 0 ? (
                filtered.map((s) => {
                  const pctDone = s.machines.total ? Math.round((s.machines.done / s.machines.total) * 100) : 0;
                  return (
                    <tr key={siteKey(s)} className="hover:bg-slate-50/60 dark:hover:bg-slate-800/40 transition-colors">
                      <td className="py-3 px-4">
                        <div className="flex items-center gap-2">
                          <div className="w-7 h-7 rounded-full bg-sky-50 dark:bg-sky-950/60 text-sky-600 dark:text-sky-400 flex items-center justify-center shrink-0">
                            <Building2 className="w-3.5 h-3.5" />
                          </div>
                          <div>
                            <p className="font-semibold text-slate-900 dark:text-white">{siteName(s, t)}</p>
                            {s.site && <p className="text-[11px] text-slate-400 font-mono">{s.site.code}</p>}
                          </div>
                        </div>
                      </td>
                      <td className="py-3 px-4 text-slate-600 dark:text-slate-400">
                        <span className="flex items-center gap-1.5"><Wrench className="w-3.5 h-3.5 text-slate-400" />{s.machines.total}</span>
                      </td>
                      <td className="py-3 px-4">
                        <div className="flex items-center gap-2 min-w-[140px]">
                          <div className="flex-1 h-1.5 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
                            <div className="h-full bg-emerald-500" style={{ width: `${pctDone}%` }} />
                          </div>
                          <span className="text-[11px] text-slate-500">{s.machines.done}/{s.machines.total}</span>
                        </div>
                      </td>
                      <td className="py-3 px-4">
                        <div className="flex gap-1">
                          {ONBOARDING_STEPS.map((step) => {
                            const c = s.steps[step];
                            const allDone = s.machines.total > 0 && c.done === s.machines.total;
                            return (
                              <span
                                key={step}
                                title={t('progress.stepTitle', { step: t(`step.${step}`), done: c.done, pending: c.pending, blocked: c.blocked })}
                                className={`px-1.5 py-0.5 rounded text-[10px] font-semibold border ${allDone
                                  ? 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800'
                                  : 'bg-slate-50 dark:bg-slate-800 text-slate-500 dark:text-slate-400 border-slate-200 dark:border-slate-700'}`}
                              >
                                {t(`stepShort.${step}`)} {c.done}/{s.machines.total}
                              </span>
                            );
                          })}
                        </div>
                      </td>
                      <td className="py-3 px-4">
                        <span className={`inline-flex items-center px-2 py-0.5 text-[10px] font-semibold uppercase rounded border ${SITE_STATUS[s.status].style}`}>
                          {t(`siteStatus.${s.status}`)}
                        </span>
                      </td>
                      <td className="py-3 px-4 text-center">
                        <button
                          onClick={() => setViewing(s)}
                          disabled={s.machines.total === 0}
                          className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-sky-600 dark:text-sky-400 hover:bg-sky-50 dark:hover:bg-sky-950/40 hover:border-sky-300 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                          title={t('progress.viewMachines')}
                        >
                          <ListChecks className="w-4 h-4" />
                        </button>
                      </td>
                    </tr>
                  );
                })
              ) : (
                <tr><td colSpan={6} className="py-8 text-center text-slate-400 font-sans">{t('progress.noMatch')}</td></tr>
              )}
            </tbody>
          </table>
        </div>
        {summary && (
          <div className="px-6 py-3 border-t border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/30 text-[11px] text-slate-500 dark:text-slate-400">
            {t('progress.asOf', { date: new Date(summary.asOf).toLocaleString() })}
          </div>
        )}
      </div>

      <Modal
        isOpen={!!viewing}
        onClose={() => setViewing(null)}
        title={viewing ? siteName(viewing, t) : ''}
        subtitle={t('progress.stepsPerMachine')}
        maxWidth="max-w-3xl"
      >
        {viewing && <SiteMachines key={siteKey(viewing)} machines={machinesOf(viewing)} />}
      </Modal>
    </div>
  );
};

const MetricCard: React.FC<{ label: string; value: number; icon: React.ReactNode; tone: 'sky' | 'emerald' | 'amber' }> = ({ label, value, icon, tone }) => {
  const toneClass = {
    sky: 'bg-sky-50 dark:bg-sky-950/60 text-sky-600 dark:text-sky-400',
    emerald: 'bg-emerald-50 dark:bg-emerald-950/60 text-emerald-600 dark:text-emerald-400',
    amber: 'bg-amber-50 dark:bg-amber-950/60 text-amber-600 dark:text-amber-400',
  }[tone];
  return (
    <div className="bg-white dark:bg-slate-900 p-5 rounded-xl border border-slate-200 dark:border-slate-800 shadow-xs flex items-center justify-between">
      <div>
        <div className="text-xs font-semibold text-slate-500 dark:text-slate-400">{label}</div>
        <div className="text-2xl font-bold text-slate-900 dark:text-white mt-1">{value}</div>
      </div>
      <div className={`w-11 h-11 rounded-xl flex items-center justify-center ${toneClass}`}>{icon}</div>
    </div>
  );
};

/** One row per machine on the site; its seven steps load when it is opened, one call
 *  each, so a large site does not fetch every machine's detail up front. */
const SiteMachines: React.FC<{ machines: EquipmentProfile[] }> = ({ machines }) => {
  const { t } = useTranslation('onboarding');
  const [open, setOpen] = useState<string | null>(machines.length === 1 ? `${machines[0].sourceSystem}|${machines[0].externalId}` : null);

  if (machines.length === 0) return <p className="text-sm text-slate-400">{t('progress.noMachines')}</p>;

  return (
    <div className="space-y-2">
      {machines.map((m) => {
        const key = `${m.sourceSystem}|${m.externalId}`;
        return (
          <div key={key} className="border border-slate-200 dark:border-slate-800 rounded-lg">
            <button
              onClick={() => setOpen(open === key ? null : key)}
              className="w-full flex items-center justify-between gap-2 px-3 py-2.5 text-left cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/40"
            >
              <span className="text-sm font-semibold text-slate-800 dark:text-slate-100">
                {m.name ?? m.externalId} <span className="font-normal text-xs text-slate-400">{m.externalId}</span>
              </span>
              <ChevronRight className={`w-4 h-4 text-slate-400 transition-transform ${open === key ? 'rotate-90' : ''}`} />
            </button>
            {open === key && <MachineSteps sourceSystem={m.sourceSystem} externalId={m.externalId} />}
          </div>
        );
      })}
    </div>
  );
};

const MachineSteps: React.FC<{ sourceSystem: string; externalId: string }> = ({ sourceSystem, externalId }) => {
  const { t } = useTranslation('onboarding');
  const [data, setData] = useState<MachineOnboarding | null>(null);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    let live = true;
    apiGetMachineOnboarding(sourceSystem, externalId)
      .then((d) => { if (live) setData(d); })
      .catch((err) => { if (live) setError(err instanceof ApiError ? err.message : t('progress.machineLoadFailed')); });
    return () => { live = false; };
  }, [sourceSystem, externalId]);

  if (error) return <p className="px-3 pb-3 text-xs text-rose-600 dark:text-rose-400">{error}</p>;
  if (!data) return <p className="px-3 pb-3 text-xs text-slate-400">{t('progress.loading')}</p>;

  return (
    <div className="px-3 pb-3 space-y-1.5">
      <p className="text-[11px] text-slate-400">
        {data.overall === 'done' ? t('progress.fullyOnboarded') : t('progress.inProgress')}{data.machine.classSlug ? ` · ${t('progress.class', { slug: data.machine.classSlug })}` : ''}
      </p>
      <ol className="space-y-1">
        {data.steps.map((s, i) => (
          <li key={s.step} className="flex items-start justify-between gap-3 text-xs border-t border-slate-100 dark:border-slate-800 pt-1.5">
            <div className="min-w-0">
              <p className="text-slate-700 dark:text-slate-200 font-medium">{i + 1}. {t(`step.${s.step}`)}</p>
              {s.state !== 'done' && (
                <p className="text-[11px] text-slate-400">
                  {s.blockedBy ? t('progress.waitingOn', { step: t(`step.${s.blockedBy}`) }) : s.reason ? t(`reason.${s.reason}`, { defaultValue: s.reason }) : null}
                </p>
              )}
            </div>
            <Chip tone={STATE_TONE[s.state]}>{t(`stepState.${s.state}`)}</Chip>
          </li>
        ))}
      </ol>
    </div>
  );
};
