import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { shieldStatusLabel } from '../components/shield/shieldStatusLabel';
import { AlertCircle, ChevronRight, ShieldCheck, ShieldAlert, Info, Siren } from 'lucide-react';
import { usePageHeader } from '../lib/PageHeaderContext';
import { DEFAULT_EQUIPMENT_FILTER_SCOPE, EquipmentFilters } from '../components/common/EquipmentFilters';
import { Chip } from '../components/common/Chip';
import { ListTable } from '../components/common/ListTable';
import { LIST_PANEL, TablePagination, usePagination } from '../components/common/TablePagination';
import { ViewModeToggle, useViewMode } from '../components/common/ViewModeToggle';
import {
  ApiError, Plant, SHIELD_CATEGORIES, ShieldMachine, ShieldStatus, ShieldSummary,
  apiGetShieldSummary, apiListPlants,
} from '../lib/api';

const PAGE_SIZE = 12;

const STATUS_TONE: Record<ShieldStatus, 'emerald' | 'amber' | 'rose' | 'slate'> = {
  current: 'emerald', due_soon: 'amber', overdue: 'rose', action_required: 'rose', not_recorded: 'slate',
};

const needsAttention = (m: ShieldMachine) =>
  SHIELD_CATEGORIES.some((c) => ['action_required', 'overdue'].includes(m.categories[c].status));

export const ThingsShieldPage: React.FC = () => {
  const { t } = useTranslation('shield');
  const [viewMode, setViewMode] = useViewMode('things-shield');
  usePageHeader({ title: 'ThingsShield', subtitle: t('page.subtitle') });
  const navigate = useNavigate();
  const [summary, setSummary] = useState<ShieldSummary | null>(null);
  const [plants, setPlants] = useState<Plant[]>([]);
  const [error, setError] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [scope, setScope] = useState(DEFAULT_EQUIPMENT_FILTER_SCOPE);
  const [selectedKey, setSelectedKey] = useState('all');

  useEffect(() => {
    let live = true;
    apiListPlants().then((p) => { if (live) setPlants(p); }).catch(() => {});
    apiGetShieldSummary()
      .then((s) => { if (live) { setSummary(s); setError(undefined); } })
      .catch((err) => { if (live) setError(err instanceof ApiError ? err.message : t('page.loadFailed')); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, []);

  const machines = summary?.machines ?? [];
  const classes = useMemo(
    () => [...new Set(machines.map((m) => m.machine.classSlug).filter((s): s is string => !!s))].sort(),
    [machines],
  );
  const equipmentOptions = useMemo(
    () => machines.map((m) => ({ sourceSystem: m.machine.sourceSystem, externalId: m.machine.externalId, label: `${m.machine.name ?? m.machine.externalId} (${m.machine.externalId})` })),
    [machines],
  );

  const matching = useMemo(() => {
    const term = scope.query.trim().toLowerCase();
    return machines.filter((m) => {
      const key = `${m.machine.sourceSystem}|${m.machine.externalId}`;
      return (selectedKey === 'all' || key === selectedKey)
        && (scope.plantId === 'all' || m.machine.plantId === scope.plantId)
        && (scope.classSlug === 'all' || m.machine.classSlug === scope.classSlug)
        && (!term || (m.machine.name ?? '').toLowerCase().includes(term) || m.machine.externalId.toLowerCase().includes(term));
    });
  }, [machines, scope, selectedKey]);

  // Recounted over the filtered machines so the tiles always describe the cards below
  // them; the backend's own `counts` cover the whole account.
  const totals = useMemo(() => {
    const n: Record<ShieldStatus, number> = { action_required: 0, overdue: 0, due_soon: 0, current: 0, not_recorded: 0 };
    for (const m of matching) for (const c of SHIELD_CATEGORIES) n[m.categories[c].status] += 1;
    return n;
  }, [matching]);

  // The shared rsuite pager, as every other list; back to page 1 when the filters change the count.
  const { pageItems, ...pager } = usePagination(matching, PAGE_SIZE);
  const open = (m: ShieldMachine) => navigate(`/things-shield/${encodeURIComponent(m.machine.sourceSystem)}/${encodeURIComponent(m.machine.externalId)}`);

  return (
    <div id="things-shield-view" className="space-y-3">
      <div className="bg-gradient-to-r from-sky-600 to-cyan-600 rounded-xl p-6 text-white space-y-1">
        <div className="flex items-center gap-1.5">
          <span className="text-xs font-semibold tracking-wider uppercase text-sky-100">{t('page.eyebrow')}</span>
          <span title={t('page.info')}>
            <Info className="w-4 h-4 text-sky-200" />
          </span>
        </div>
        <h2 className="text-xl font-bold">{t('page.heading')}</h2>
      </div>

      {error && (
        <div className="flex items-center gap-2 text-xs text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 rounded-lg px-3 py-2">
          <AlertCircle className="w-3.5 h-3.5 shrink-0" /><span>{error}</span>
        </div>
      )}

      <EquipmentFilters
        showConnection={false}
        scope={scope}
        onChange={setScope}
        plants={plants}
        classes={classes}
        equipmentOptions={equipmentOptions}
        selectedKey={selectedKey}
        onSelect={setSelectedKey}
      />

      <div className="grid grid-cols-2 sm:grid-cols-5 gap-4">
        <KpiTile label={t('status.action_required')} value={totals.action_required} tone="bad" />
        <KpiTile label={t('status.overdue')} value={totals.overdue} tone="bad" />
        <KpiTile label={t('status.due_soon')} value={totals.due_soon} tone="warn" />
        <KpiTile label={t('status.current')} value={totals.current} tone="good" />
        <KpiTile label={t('status.not_recorded')} value={totals.not_recorded} />
      </div>
      <p className="text-[11px] text-slate-400">{t('page.countNote')}</p>

      <div>
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-semibold text-slate-900 dark:text-white text-base">{t('page.machines')}</h3>
          <div className="flex items-center gap-3">
            <span className="text-sm text-slate-400 dark:text-slate-500">{t('page.machineCount', { count: matching.length })}</span>
            <ViewModeToggle mode={viewMode} onChange={setViewMode} />
          </div>
        </div>

        <div className={LIST_PANEL}>
          {loading ? (
            <p className="p-4 text-sm text-slate-500">{t('page.loading')}</p>
          ) : pageItems.length === 0 ? (
            <div className="py-10 text-center text-slate-400 text-sm">
              {t('page.noMatch')}
            </div>
          ) : viewMode === 'list' ? (
            <ListTable bare
              columns={[{ label: t('listCol.machine') }, ...SHIELD_CATEGORIES.map((c) => ({ label: t(`category.${c}`) }))]}
              rows={pageItems}
              rowKey={(m) => `${m.machine.sourceSystem}/${m.machine.externalId}`}
              cells={(m) => [
                <span className="inline-flex items-center gap-2">
                  {needsAttention(m)
                    ? <ShieldAlert className="w-4 h-4 text-rose-600 dark:text-rose-400 shrink-0" />
                    : <ShieldCheck className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" />}
                  <span className="font-medium">{m.machine.name ?? m.machine.externalId}</span>
                  <span className="text-slate-400">{m.machine.externalId}</span>
                </span>,
                ...SHIELD_CATEGORIES.map((c) => (
                  <Chip tone={STATUS_TONE[m.categories[c].status]}>{shieldStatusLabel(t, m.categories[c])}</Chip>
                )),
              ]}
              onOpen={open}
            />
          ) : (
            <div className="p-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {pageItems.map((m) => (
                <ShieldCard key={`${m.machine.sourceSystem}/${m.machine.externalId}`} machine={m} onOpen={() => open(m)} />
              ))}
            </div>
          )}

          <TablePagination pinToBottom {...pager} />
        </div>
      </div>

      {/* Incidents have their own backend and page; the mock section that used to sit
          here showed invented incidents beside real evidence. */}
      <button
        onClick={() => navigate('/incident-management')}
        className="w-full flex items-center justify-between gap-3 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 shadow-xs hover:border-sky-300 cursor-pointer text-left"
      >
        <span className="flex items-center gap-2 text-sm font-semibold text-slate-800 dark:text-slate-100">
          <Siren className="w-4 h-4 text-amber-500" /> {t('page.incidentsLink')}
        </span>
        <ChevronRight className="w-4 h-4 text-slate-400" />
      </button>
    </div>
  );
};

const KpiTile: React.FC<{ label: string; value: number; tone?: 'good' | 'bad' | 'warn' }> = ({ label, value, tone }) => {
  const toneClass = tone === 'good' ? 'text-emerald-600 dark:text-emerald-400' : tone === 'bad' ? 'text-rose-600 dark:text-rose-400' : tone === 'warn' ? 'text-amber-600 dark:text-amber-400' : 'text-slate-800 dark:text-slate-100';
  return (
    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 shadow-xs">
      <div className={`text-2xl font-bold ${toneClass}`}>{value}</div>
      <div className="text-sm text-slate-400 dark:text-slate-500 mt-0.5">{label}</div>
    </div>
  );
};

const ShieldCard: React.FC<{ machine: ShieldMachine; onOpen: () => void }> = ({ machine, onOpen }) => {
  const { t } = useTranslation('shield');
  const alert = needsAttention(machine);
  const style = alert
    ? 'border-rose-200 dark:border-rose-900 bg-rose-50/60 dark:bg-rose-950/20'
    : 'border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900';
  return (
    <button onClick={onOpen} className={`text-left w-full border rounded-xl p-4 shadow-xs space-y-2.5 hover:shadow-md transition-shadow cursor-pointer group ${style}`}>
      <div className="flex items-center gap-2">
        <span title={alert ? t('card.needsAttention') : t('card.allClear')}>
          {alert ? <ShieldAlert className="w-6 h-6 text-rose-600 dark:text-rose-400 shrink-0" /> : <ShieldCheck className="w-6 h-6 text-emerald-600 dark:text-emerald-400 shrink-0" />}
        </span>
        <div className="min-w-0 flex-1">
          <h4 className="font-semibold text-slate-900 dark:text-white text-base truncate" title={machine.machine.name ?? machine.machine.externalId}>
            {machine.machine.name ?? machine.machine.externalId}
          </h4>
          <p className="text-sm text-slate-500 dark:text-slate-400 truncate">{machine.machine.externalId}{machine.machine.classSlug ? ` · ${machine.machine.classSlug}` : ''}</p>
        </div>
      </div>
      <div className="flex items-center justify-between pt-2 border-t border-slate-200/70 dark:border-slate-800">
        <div className="flex items-center gap-1.5 flex-wrap">
          {SHIELD_CATEGORIES.map((c) => (
            <Chip key={c} tone={STATUS_TONE[machine.categories[c].status]} title={`${t(`category.${c}`)}: ${shieldStatusLabel(t, machine.categories[c])}`}>
              {t(`category.${c}`)}
            </Chip>
          ))}
        </div>
        <span className="inline-flex items-center gap-0.5 text-xs font-medium text-sky-600 dark:text-sky-400 group-hover:gap-1.5 transition-all">
          {t('card.details')} <ChevronRight className="w-3.5 h-3.5" />
        </span>
      </div>
    </button>
  );
};
