import React, { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Box, Clock3, FileImage, GitBranch, ImageOff, Plus, Sparkles, Wrench } from 'lucide-react';
import { usePageHeader } from '../lib/PageHeaderContext';
import { FLEET, findThing, isBreaching, predictionFor, sensorsFor, weeklyPerformanceFor } from '../data/fleetMockData';
import { SensorGraphCard } from '../components/fleet/SensorGraphCard';
import { FleetFilters, DEFAULT_FLEET_SCOPE, matchingFleet } from '../components/fleet/FleetFilters';
import { COST_FIELD_LABELS, CostField, MOCK_WORK_ORDERS, costFields, resolveCostsFor } from '../data/clientOpsMockData';

const FORMULAS = [
  { name: 'Engine working hours', detail: 'Last cumulative engine runtime · first available reading', value: '112.00 hrs' },
  { name: 'Availability', detail: '(Scheduled hours − breakdown hours) ÷ 112', value: 'Awaiting data' },
  { name: 'Fuel savings', detail: '(Baseline L/h × working hours − consumed litres) × fuel price', value: 'Awaiting data' },
  { name: 'SOE', detail: 'Availability × performance × actual output ÷ quality', value: 'Awaiting data' },
];

export const ThingDetailPage: React.FC = () => {
  const { thingId } = useParams<{ thingId: string }>();
  const navigate = useNavigate();
  const thing = thingId ? findThing(thingId) : undefined;
  const [scope, setScope] = useState(DEFAULT_FLEET_SCOPE);
  const matching = useMemo(() => matchingFleet(FLEET, scope), [scope]);
  usePageHeader({ title: thing ? thing.name : 'Thing not found', subtitle: 'Equipment Detail', onBack: () => navigate('/dashboard') });

  if (!thing) {
    return (
      <div className="space-y-4">
        <FleetFilters scope={scope} onChange={setScope} things={matching} selectedId="all" onSelectId={(id) => navigate(`/dashboard/${id}`)} />
        <p className="text-sm text-slate-500">This Thing could not be found.</p>
      </div>
    );
  }

  const perf = weeklyPerformanceFor(thing);
  const sensors = sensorsFor(thing);
  const prediction = predictionFor(thing);
  const breach = isBreaching(thing);
  const cost = resolveCostsFor('2026-09-23', thing.location, thing.id);
  const orders = MOCK_WORK_ORDERS.filter((o) => o.equipmentCode === thing.id);

  return (
    <div className="space-y-3">
      <FleetFilters scope={scope} onChange={setScope} things={matching} selectedId={thing.id} onSelectId={(id) => navigate(id === 'all' ? '/dashboard' : `/dashboard/${id}`)} />

      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 shadow-xs space-y-2">
        <h3 className="font-semibold text-slate-900 dark:text-white text-sm">Cost &amp; ROI · {thing.name}</h3>
        <p className="text-[12px] text-slate-500 dark:text-slate-400">Applicable rates at 2026-09-23 · {cost.currency || 'Currency not configured'}</p>
        <p className="text-[12px] text-slate-400 dark:text-slate-500">Fuel savings need a fuel price, fuel/hour baseline and working-hour history.</p>
        <p className="text-[12px] text-slate-400 dark:text-slate-500">
          Breakdown exposure: {cost.values.downtimePerHour != null ? `${(perf.breakdownHours * cost.values.downtimePerHour).toFixed(2)} ${cost.currency}` : 'requires downtime rate and recorded breakdown hours'}. This is estimated loss, not avoided downtime savings.
        </p>
        <ul className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 text-[12px] text-slate-500 dark:text-slate-400 pt-1">
          {costFields.map((f) => <li key={f}>{COST_FIELD_LABELS[f as CostField]}: {cost.values[f as CostField] ?? 'Not configured'}</li>)}
        </ul>
      </div>

      <div className="bg-sky-50 dark:bg-sky-950/30 border border-sky-100 dark:border-sky-900 rounded-xl p-4 flex items-center gap-4 flex-wrap">
        <span className="w-11 h-11 rounded-lg bg-white dark:bg-slate-900 text-sky-700 dark:text-sky-400 flex items-center justify-center shrink-0"><Box className="w-5 h-5" /></span>
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-semibold text-slate-900 dark:text-white">{thing.name}</h2>
          <p className="text-[13px] text-slate-500 dark:text-slate-400">{thing.id} · {thing.location} · {thing.category}</p>
        </div>
        <span className={`px-2.5 py-1 text-[11px] font-medium rounded-full ${thing.offline ? 'bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-400' : 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-400'}`}>
          {thing.offline ? 'Offline' : 'Online'}
        </span>
        <button onClick={() => navigate('/work-orders')} className="px-3 py-1.5 text-xs font-medium rounded-lg bg-sky-600 text-white hover:bg-sky-700 inline-flex items-center gap-1.5">
          <Plus className="w-3.5 h-3.5" /> Create work order
        </button>
      </div>

      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 shadow-xs">
        <h3 className="font-semibold text-slate-900 dark:text-white text-sm mb-3">Equipment record &amp; weekly performance</h3>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          {[
            { label: 'Working hours', value: `${perf.workingHours} h` },
            { label: 'Availability', value: `${perf.availability.toFixed(2)} %` },
            { label: 'Performance', value: `${perf.performance.toFixed(2)} %` },
            { label: 'Quality', value: `${perf.quality.toFixed(2)} %` },
            { label: 'Breakdown hours', value: `${perf.breakdownHours} h` },
            { label: 'Scheduled hours', value: `${perf.scheduledHours} h` },
            { label: 'Productive hours', value: `${perf.productiveHours} h` },
            { label: 'Idle hours', value: `${perf.idleHours} h` },
            { label: 'Fuel used', value: `${perf.fuelUsedL} L` },
            { label: 'Fuel / hour', value: `${perf.fuelPerHour} L/h` },
          ].map((s) => (
            <div key={s.label} className="border border-slate-100 dark:border-slate-800 rounded-lg p-3">
              <div className="text-base font-bold text-slate-800 dark:text-slate-100">{s.value}</div>
              <div className="text-[11px] text-slate-400 dark:text-slate-500 mt-0.5">{s.label}</div>
            </div>
          ))}
        </div>
      </div>

      <details className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 shadow-xs">
        <summary className="font-semibold text-slate-900 dark:text-white text-sm cursor-pointer">Default KPIs &amp; formulas</summary>
        <p className="text-[12px] text-slate-500 dark:text-slate-400 mt-2 mb-3">Sample data. Awaiting data on the connected inventory. Values require configured rates, predictions require enough historical history.</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {FORMULAS.map((f) => (
            <div key={f.name} className="border border-slate-100 dark:border-slate-800 rounded-lg p-3">
              <div className="flex items-center justify-between">
                <h5 className="text-[13px] font-semibold text-slate-800 dark:text-slate-100">{f.name}</h5>
                <span className="text-[13px] font-mono text-slate-600 dark:text-slate-300">{f.value}</span>
              </div>
              <p className="text-[11px] text-slate-400 dark:text-slate-500 mt-1">{f.detail}</p>
            </div>
          ))}
        </div>
      </details>

      <details className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 shadow-xs">
        <summary className="font-semibold text-slate-900 dark:text-white text-sm cursor-pointer flex items-center gap-1.5"><FileImage className="w-4 h-4" /> Actual equipment photo</summary>
        <div className="mt-3 h-40 rounded-lg bg-slate-100 dark:bg-slate-800 flex flex-col items-center justify-center gap-2 text-slate-400">
          <ImageOff className="w-7 h-7" />
          <span className="text-[12px]">No equipment photo uploaded</span>
        </div>
      </details>

      <div>
        <h3 className="font-semibold text-slate-900 dark:text-white text-sm">Operational KPIs</h3>
        <p className="text-[12px] text-slate-500 dark:text-slate-400 mb-3">Sensor readings · 165 history steps</p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {sensors.map((s) => <SensorGraphCard key={s.key} sensor={s} />)}
        </div>
      </div>

      <div>
        <h3 className="font-semibold text-slate-900 dark:text-white text-sm">Prediction KPIs</h3>
        <p className="text-[12px] text-slate-500 dark:text-slate-400 mb-3">Trend visibility with explicit limits on forecast confidence</p>
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 shadow-xs space-y-2 max-w-md">
          <span className="inline-flex px-2 py-0.5 text-[10px] font-medium rounded border bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 border-slate-200 dark:border-slate-700">
            PLANNING ESTIMATE · {prediction.priority.toUpperCase()}
          </span>
          <h4 className="font-semibold text-slate-900 dark:text-white text-sm">{thing.name}</h4>
          <div className="text-xl font-bold font-mono text-slate-800 dark:text-slate-100">{prediction.fuelL.toFixed(1)} L</div>
          <p className="text-[11px] text-slate-500 dark:text-slate-400">Next 8 running hours · fuel estimate from {prediction.samples} recent running-hour samples. Assumes the same load and idle pattern.</p>
          <p className="text-[11px] text-slate-500 dark:text-slate-400">Recent idle share: {(prediction.idleShare * 100).toFixed(1)}%. {prediction.action}</p>
          <p className="text-[11px] text-slate-400 dark:text-slate-500">Rule-based planning estimate; not a validated failure prediction or remaining-life estimate.</p>
          <button onClick={() => navigate('/work-orders')} className="inline-flex items-center gap-1 text-[12px] font-medium text-sky-700 dark:text-sky-400 hover:underline">
            <Sparkles className="w-3 h-3" /> Create work order
          </button>
        </div>
      </div>

      <div>
        <h3 className="font-semibold text-slate-900 dark:text-white text-sm">Things Alerts</h3>
        <p className="text-[12px] text-slate-500 dark:text-slate-400 mb-3">{breach ? '1' : '0'} active range alerts</p>
        {breach ? (
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 shadow-xs space-y-2 max-w-md">
            <h4 className="font-semibold text-slate-900 dark:text-white text-sm">Coolant temperature</h4>
            <p className="text-[12px] text-slate-500 dark:text-slate-400">{thing.name}</p>
            <div className="text-xl font-bold font-mono text-amber-600 dark:text-amber-400">{thing.coolantNowC.toFixed(2)} °C</div>
            <p className="text-[11px] text-slate-400 dark:text-slate-500">Demonstration range: 0–{thing.coolantLimitC} °C. This indicates a threshold breach, not a diagnosed fault.</p>
            <button onClick={() => navigate('/work-orders')} className="px-3 py-1.5 text-xs font-medium rounded-lg bg-sky-600 text-white hover:bg-sky-700">Create work order</button>
          </div>
        ) : (
          <p className="text-[13px] text-slate-400">No active range alerts for this Thing.</p>
        )}
      </div>

      <div>
        <div className="flex items-center justify-between mb-3">
          <div>
            <h3 className="font-semibold text-slate-900 dark:text-white text-sm">Things Scenarios</h3>
            <p className="text-[12px] text-slate-500 dark:text-slate-400">Evaluated against the readings above</p>
          </div>
          <button onClick={() => navigate('/scenarios')} className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:border-sky-300">
            <GitBranch className="w-3.5 h-3.5" /> Recommend new
          </button>
        </div>
        <p className="text-[13px] text-slate-400">No scenarios for this Thing yet. See Scenarios for the fleet-wide list.</p>
      </div>

      <div>
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-semibold text-slate-900 dark:text-white text-sm">Work Orders</h3>
          <button onClick={() => navigate('/work-orders')} className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-sky-600 text-white hover:bg-sky-700">
            <Plus className="w-3.5 h-3.5" /> Create work order
          </button>
        </div>
        {orders.length ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {orders.map((o) => (
              <div key={o.id} className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-3.5 space-y-1">
                <div className="flex items-center gap-2"><Wrench className="w-4 h-4 text-slate-400" /><span className="text-[12px] font-medium text-slate-500 dark:text-slate-400">{o.status}</span></div>
                <h5 className="text-sm font-semibold text-slate-800 dark:text-slate-100">{o.title}</h5>
                {o.notes && <p className="text-[11px] text-slate-400 dark:text-slate-500">{o.notes}</p>}
                <small className="block text-[11px] text-slate-400 dark:text-slate-500 flex items-center gap-1 pt-1"><Clock3 className="w-3 h-3" />{new Date(o.createdAt).toLocaleString()}</small>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-[13px] text-slate-400">No work orders for this Thing yet.</p>
        )}
      </div>
    </div>
  );
};
