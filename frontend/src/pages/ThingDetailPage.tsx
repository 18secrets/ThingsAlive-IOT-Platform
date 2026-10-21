import React, { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Bell, CheckCircle2, Clock3, FileImage, GitBranch, ImageOff, Plus, Sparkles, Wrench } from 'lucide-react';
import { usePageHeader } from '../lib/PageHeaderContext';
import { FLEET, findThing, isBreaching, predictionFor, sensorsFor, weeklyPerformanceFor } from '../data/fleetMockData';
import { FleetFilters, DEFAULT_FLEET_SCOPE, matchingFleet } from '../components/fleet/FleetFilters';
import { COST_FIELD_LABELS, CostField, MOCK_WORK_ORDERS, costFields, resolveCostsFor } from '../data/clientOpsMockData';
import { RingGauge } from '../components/common/RingGauge';
import { Chip } from '../components/common/Chip';

export const ThingDetailPage: React.FC = () => {
  const { thingId } = useParams<{ thingId: string }>();
  const navigate = useNavigate();
  const { t } = useTranslation(['dashboard', 'fleet']);
  const thing = thingId ? findThing(thingId) : undefined;
  const [scope, setScope] = useState(DEFAULT_FLEET_SCOPE);
  const matching = useMemo(() => matchingFleet(FLEET, scope), [scope]);
  usePageHeader({ title: thing ? thing.name : t('thing.notFoundTitle'), subtitle: t('thing.subtitle'), onBack: () => navigate('/dashboard') });

  if (!thing) {
    return (
      <div className="space-y-4">
        <FleetFilters scope={scope} onChange={setScope} things={matching} selectedId="all" onSelectId={(id) => navigate(`/dashboard/${id}`)} />
        <p className="text-sm text-slate-500">{t('thing.notFound')}</p>
      </div>
    );
  }

  const perf = weeklyPerformanceFor(thing);
  const sensors = sensorsFor(thing);
  const prediction = predictionFor(thing);
  const breach = isBreaching(thing);
  const cost = resolveCostsFor('2026-09-23', thing.location, thing.id);
  const orders = MOCK_WORK_ORDERS.filter((o) => o.equipmentCode === thing.id);
  const oeePercent = (perf.availability / 100) * (perf.performance / 100) * (perf.quality / 100) * 100;
  const formulas = [
    { name: t('thing.formula.engineHours'), detail: t('thing.formula.engineHoursDetail'), value: '112.00 hrs' },
    { name: t('common.availability'), detail: t('thing.formula.availabilityDetail'), value: t('thing.awaitingData') },
    { name: t('thing.formula.fuelSavings'), detail: t('thing.formula.fuelSavingsDetail'), value: t('thing.awaitingData') },
    { name: t('thing.formula.soe'), detail: t('thing.formula.soeDetail'), value: t('thing.awaitingData') },
  ];
  const gaugeColor = oeePercent >= 75 ? 'text-emerald-500 dark:text-emerald-400' : oeePercent >= 60 ? 'text-amber-500 dark:text-amber-400' : 'text-rose-500 dark:text-rose-400';

  return (
    <div className="space-y-3">
      <div className="bg-gradient-to-r from-sky-600 to-cyan-600 rounded-xl p-6 text-white space-y-1">
        <span className="text-xs font-semibold tracking-wider uppercase text-sky-100">{t('thing.fleetOverview')}</span>
        <h2 className="text-xl font-bold">{t('thing.heading')}</h2>
      </div>

      <FleetFilters scope={scope} onChange={setScope} things={matching} selectedId={thing.id} onSelectId={(id) => navigate(id === 'all' ? '/dashboard' : `/dashboard/${id}`)} />

      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 shadow-xs space-y-4">
        <div className="flex items-center gap-4">
          <span title={t('thing.oeeTooltip')}>
            <RingGauge value={oeePercent} size={72} colorClass={gaugeColor} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="font-semibold text-slate-900 dark:text-white text-base truncate">{thing.name}</h3>
              <span className={`shrink-0 px-2 py-0.5 text-[10px] font-semibold uppercase rounded-full ${thing.offline ? 'bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-400' : 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-400'}`}>
                {thing.offline ? t('common.offline') : t('common.online')}
              </span>
            </div>
            <p className="text-sm text-slate-500 dark:text-slate-400 truncate">{thing.id} · {thing.location} · {thing.category}</p>
            <div className="flex flex-wrap items-center gap-1.5 mt-2">
              <Chip icon={Clock3} title={t('common.uptimeHours')} size="md">{t('thing.hoursUp', { value: perf.workingHours })}</Chip>
              <Chip icon={AlertTriangle} tone={perf.breakdownHours > 0 ? 'amber' : 'slate'} title={t('common.breakdownHours')} size="md">{t('thing.hoursDown', { value: perf.breakdownHours })}</Chip>
              <Chip icon={Bell} tone={breach ? 'amber' : 'slate'} title={t('thing.activeRangeAlertsTitle')} size="md">{t('thing.alertsCount', { count: breach ? 1 : 0 })}</Chip>
            </div>
          </div>
        </div>
      </div>

      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 shadow-xs space-y-2">
        <h3 className="font-semibold text-slate-900 dark:text-white text-base">{t('thing.costRoi')}</h3>
        <p className="text-sm text-slate-500 dark:text-slate-400">{t('thing.ratesAt', { date: '2026-09-23', currency: cost.currency || t('thing.currencyNotConfigured') })}</p>
        <p className="text-xs text-slate-400 dark:text-slate-500">{t('thing.fuelSavingsNeed')}</p>
        <p className="text-xs text-slate-400 dark:text-slate-500">
          {t('thing.breakdownExposure', { value: cost.values.downtimePerHour != null ? `${(perf.breakdownHours * cost.values.downtimePerHour).toFixed(2)} ${cost.currency}` : t('thing.exposureNeeds') })}
        </p>
        <ul className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 text-xs text-slate-500 dark:text-slate-400 pt-1">
          {costFields.map((f) => <li key={f}>{t(`thing.costField.${f}`, { defaultValue: COST_FIELD_LABELS[f as CostField] })}: {cost.values[f as CostField] ?? t('thing.notConfigured')}</li>)}
        </ul>
      </div>

      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 shadow-xs">
        <h3 className="font-semibold text-slate-900 dark:text-white text-base mb-3">{t('thing.recordTitle')}</h3>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          {[
            { label: t('thing.stat.workingHours'), value: `${perf.workingHours} h` },
            { label: t('common.availability'), value: `${perf.availability.toFixed(2)} %` },
            { label: t('common.performance'), value: `${perf.performance.toFixed(2)} %` },
            { label: t('common.quality'), value: `${perf.quality.toFixed(2)} %` },
            { label: t('common.breakdownHours'), value: `${perf.breakdownHours} h` },
            { label: t('thing.stat.scheduledHours'), value: `${perf.scheduledHours} h` },
            { label: t('thing.stat.productiveHours'), value: `${perf.productiveHours} h` },
            { label: t('thing.stat.idleHours'), value: `${perf.idleHours} h` },
            { label: t('thing.stat.fuelUsed'), value: `${perf.fuelUsedL} L` },
            { label: t('thing.stat.fuelPerHour'), value: `${perf.fuelPerHour} L/h` },
          ].map((s) => (
            <div key={s.label} className="border border-slate-100 dark:border-slate-800 rounded-lg p-3">
              <div className="text-lg font-bold text-slate-800 dark:text-slate-100">{s.value}</div>
              <div className="text-xs text-slate-400 dark:text-slate-500 mt-0.5">{s.label}</div>
            </div>
          ))}
        </div>
      </div>

      <details className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 shadow-xs">
        <summary className="font-semibold text-slate-900 dark:text-white text-base cursor-pointer">{t('thing.defaultKpis')}</summary>
        <p className="text-sm text-slate-500 dark:text-slate-400 mt-2 mb-3">{t('thing.sampleNote')}</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {formulas.map((f) => (
            <div key={f.name} className="border border-slate-100 dark:border-slate-800 rounded-lg p-3">
              <div className="flex items-center justify-between">
                <h5 className="text-sm font-semibold text-slate-800 dark:text-slate-100">{f.name}</h5>
                <span className="text-sm font-mono text-slate-600 dark:text-slate-300">{f.value}</span>
              </div>
              <p className="text-xs text-slate-400 dark:text-slate-500 mt-1">{f.detail}</p>
            </div>
          ))}
        </div>
      </details>

      <details className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 shadow-xs">
        <summary className="font-semibold text-slate-900 dark:text-white text-base cursor-pointer flex items-center gap-1.5"><FileImage className="w-4 h-4" /> {t('thing.photo')}</summary>
        <div className="mt-3 h-40 rounded-lg bg-slate-100 dark:bg-slate-800 flex flex-col items-center justify-center gap-2 text-slate-400">
          <ImageOff className="w-8 h-8" />
          <span className="text-sm">{t('thing.noPhoto')}</span>
        </div>
      </details>

      <div>
        <h3 className="font-semibold text-slate-900 dark:text-white text-base mb-1">{t('thing.operationalKpis')}</h3>
        <p className="text-sm text-slate-500 dark:text-slate-400 mb-3">{t('thing.sensorReadings', { count: 165 })}</p>
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
          {sensors.map((s) => {
            const sensorBreach = s.key === 'coolant_temperature' && s.current > s.max;
            return (
              <div key={s.key} className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 shadow-xs">
                <h4 className="text-slate-500 dark:text-white text-md">{t(`fleet:sensor.${s.key}`, { defaultValue: s.label })}</h4>
                <div className="text-2xl font-bold font-mono text-slate-800 dark:text-slate-100 mt-1">
                  {s.current.toFixed(2)} <span className="text-sm font-normal text-slate-400">{s.unit}</span>
                </div>
                <p className={`text-xs font-medium mt-1.5 ${sensorBreach ? 'text-rose-600 dark:text-rose-400' : 'text-slate-400 dark:text-slate-500'}`}>
                  {sensorBreach ? t('thing.outsideConfiguredRange', { max: s.max, unit: s.unit }) : t('thing.noAlertRule')}
                </p>
              </div>
            );
          })}
        </div>
      </div>

      <div>
        <h3 className="font-semibold text-slate-900 dark:text-white text-base mb-1">{t('thing.predictionKpis')}</h3>
        <p className="text-sm text-slate-500 dark:text-slate-400 mb-3">{t('thing.predictionHint')}</p>
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 shadow-xs space-y-2 max-w-md">
          <span className="inline-flex px-2 py-0.5 text-[10px] font-medium rounded border bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 border-slate-200 dark:border-slate-700">
            {t('thing.planningEstimate', { priority: prediction.priority.toUpperCase() })}
          </span>
          <h4 className="font-semibold text-slate-900 dark:text-white text-base">{thing.name}</h4>
          <div className="text-2xl font-bold font-mono text-slate-800 dark:text-slate-100">{prediction.fuelL.toFixed(1)} L</div>
          <p className="text-xs text-slate-500 dark:text-slate-400">{t('thing.nextHours', { count: prediction.samples })}</p>
          <p className="text-xs text-slate-500 dark:text-slate-400">{t('thing.idleShare', { value: (prediction.idleShare * 100).toFixed(1) })} {prediction.action}</p>
          <p className="text-xs text-slate-400 dark:text-slate-500">{t('thing.ruleBased')}</p>
          <button onClick={() => navigate('/work-orders')} className="inline-flex items-center gap-1 text-xs font-medium text-sky-700 dark:text-sky-400 hover:underline">
            <Sparkles className="w-3.5 h-3.5" /> {t('common.createWorkOrder')}
          </button>
        </div>
      </div>

      <div>
        <h3 className="font-semibold text-slate-900 dark:text-white text-base mb-1">{t('thing.thingsAlerts')}</h3>
        <p className="text-sm text-slate-500 dark:text-slate-400 mb-3">{t('thing.activeRangeAlerts', { count: breach ? 1 : 0 })}</p>
        {breach ? (
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 shadow-xs space-y-2 max-w-md">
            <div className="flex items-center justify-between">
              <h4 className="font-semibold text-slate-900 dark:text-white text-base">{t('thing.coolantTemperature')}</h4>
              <Chip icon={AlertTriangle} tone="amber" size="md">{t('thing.outsideRange')}</Chip>
            </div>
            <p className="text-sm text-slate-500 dark:text-slate-400">{thing.name}</p>
            <div className="text-2xl font-bold font-mono text-amber-600 dark:text-amber-400">{thing.coolantNowC.toFixed(2)} °C</div>
            <p className="text-xs text-slate-400 dark:text-slate-500">{t('thing.demoRange', { max: thing.coolantLimitC })}</p>
            <button onClick={() => navigate('/work-orders')} className="px-3.5 py-2 text-sm font-medium rounded-lg bg-sky-600 text-white hover:bg-sky-700">{t('common.createWorkOrder')}</button>
          </div>
        ) : (
          <Chip icon={CheckCircle2} tone="emerald" size="md">{t('thing.noActiveRangeAlerts')}</Chip>
        )}
      </div>

      <div>
        <div className="flex items-center justify-between mb-3">
          <div>
            <h3 className="font-semibold text-slate-900 dark:text-white text-base">{t('thing.thingsScenarios')}</h3>
            <p className="text-sm text-slate-500 dark:text-slate-400">{t('thing.evaluated')}</p>
          </div>
          <button onClick={() => navigate('/scenarios')} className="inline-flex items-center gap-1.5 px-3.5 py-2 text-sm font-medium rounded-lg border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:border-sky-300">
            <GitBranch className="w-4 h-4" /> {t('thing.recommendNew')}
          </button>
        </div>
        <p className="text-sm text-slate-400">{t('thing.noScenarios')}</p>
      </div>

      <div>
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-semibold text-slate-900 dark:text-white text-base">{t('thing.workOrders')}</h3>
          <button onClick={() => navigate('/work-orders')} className="inline-flex items-center gap-1.5 px-3.5 py-2 text-sm font-medium rounded-lg bg-sky-600 text-white hover:bg-sky-700">
            <Plus className="w-4 h-4" /> {t('common.createWorkOrder')}
          </button>
        </div>
        {orders.length ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {orders.map((o) => (
              <div key={o.id} className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-3.5 space-y-1">
                <div className="flex items-center gap-2"><Wrench className="w-4 h-4 text-slate-400" /><span className="text-xs font-medium text-slate-500 dark:text-slate-400">{t(`thing.woStatus.${o.status}`, { defaultValue: o.status })}</span></div>
                <h5 className="text-sm font-semibold text-slate-800 dark:text-slate-100">{o.title}</h5>
                {o.notes && <p className="text-xs text-slate-400 dark:text-slate-500">{o.notes}</p>}
                <small className="flex items-center gap-1 text-xs text-slate-400 dark:text-slate-500 pt-1"><Clock3 className="w-3.5 h-3.5" />{new Date(o.createdAt).toLocaleString()}</small>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-slate-400">{t('thing.noWorkOrders')}</p>
        )}
      </div>
    </div>
  );
};
