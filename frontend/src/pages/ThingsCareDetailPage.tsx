import React, { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Plus, Wrench, Clock3 } from 'lucide-react';
import { usePageHeader } from '../lib/PageHeaderContext';
import { FleetFilters, DEFAULT_FLEET_SCOPE, matchingFleet } from '../components/fleet/FleetFilters';
import { SensorGraphCard } from '../components/fleet/SensorGraphCard';
import { FeatureCrossLinks } from '../components/fleet/FeatureCrossLinks';
import { FLEET, findThing, healthTrendFor, sensorsFor, thingsCareFor } from '../data/fleetMockData';
import { MOCK_WORK_ORDERS } from '../data/clientOpsMockData';

function TrendSparkline({ values }: { values: number[] }) {
  const low = Math.min(...values) - 2;
  const high = Math.max(...values) + 2;
  const points = values.map((v, i) => `${8 + (i * 284) / Math.max(1, values.length - 1)},${90 - ((v - low) / (high - low || 1)) * 70}`).join(' ');
  return (
    <svg viewBox="0 0 300 100" className="w-full h-20" role="img" aria-label="Sample health trend">
      <polyline points={points} fill="none" stroke="#d97706" strokeWidth="2.5" strokeLinejoin="round" />
    </svg>
  );
}

export const ThingsCareDetailPage: React.FC = () => {
  const { thingId } = useParams<{ thingId: string }>();
  const navigate = useNavigate();
  const thing = thingId ? findThing(thingId) : undefined;
  const [scope, setScope] = useState(DEFAULT_FLEET_SCOPE);
  const matching = useMemo(() => matchingFleet(FLEET, scope), [scope]);
  usePageHeader({
    title: thing ? thing.name : 'Thing not found',
    subtitle: 'ThingsCare Detail',
    onBack: () => navigate('/things-care'),
  });

  if (!thing) {
    return (
      <div className="space-y-4">
        <FleetFilters scope={scope} onChange={setScope} things={matching} selectedId="all" onSelectId={(id) => navigate(`/things-care/${id}`)} />
        <p className="text-sm text-slate-500">This Thing could not be found.</p>
      </div>
    );
  }

  const status = thingsCareFor(thing);
  const trend = healthTrendFor(thing);
  const sensors = sensorsFor(thing);
  const orders = MOCK_WORK_ORDERS.filter((o) => o.equipmentCode === thing.id);
  const state: 'healthy' | 'at-risk' | 'offline' = status.health == null ? 'offline' : status.alertCount > 0 ? 'at-risk' : 'healthy';

  const diagnostics =
    state === 'offline'
      ? ['Telemetry offline — health, risk and RUL cannot be assessed until the device reconnects.', 'Last known readings are shown below for reference only; they are not current.']
      : state === 'at-risk'
        ? [
            `Coolant temperature range alert active — ${thing.coolantNowC.toFixed(2)} °C against a demonstration limit of ${thing.coolantLimitC} °C.`,
            `Sample health index: ${status.health}% (baseline 94%, −16 per active configured range alert).`,
            `Sample failure risk: ${status.riskPct}% · Illustrative RUL: ${status.rulHours} h.`,
            'Review cooling system and coolant level before the next shift.',
          ]
        : [
            'No active range alerts. All configured sensor ranges are within their demonstration envelope.',
            `Sample health index: ${status.health}% (baseline, no deductions applied).`,
            `Sample failure risk: ${status.riskPct}% · Illustrative RUL: ${status.rulHours} h.`,
          ];

  return (
    <div className="space-y-6">
      <div className="bg-gradient-to-r from-sky-600 to-cyan-600 rounded-xl p-6 text-white space-y-1">
        <span className="text-[11px] font-semibold tracking-wider uppercase text-sky-100">Machine Wellbeing</span>
        <h2 className="text-xl font-bold">ThingsCare: Health &amp; Prognostics</h2>
        <p className="text-sm text-sky-100">Condition, degradation, sample prognosis and maintenance priorities.</p>
      </div>

      <FleetFilters scope={scope} onChange={setScope} things={matching} selectedId={thing.id} onSelectId={(id) => navigate(id === 'all' ? '/things-care' : `/things-care/${id}`)} />

      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 shadow-xs">
        <div className="flex items-start justify-between">
          <div>
            <h3 className="font-semibold text-slate-900 dark:text-white text-sm">{thing.name}</h3>
            <p className="text-[12px] text-slate-500 dark:text-slate-400">{thing.id} · {thing.location}</p>
          </div>
          <span className="text-[11px] text-slate-300 dark:text-slate-600 cursor-not-allowed" title="Not available in this demo">Sample history</span>
        </div>
      </div>

      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 shadow-xs space-y-2">
        <h3 className="font-semibold text-slate-900 dark:text-white text-sm">Diagnostics</h3>
        <ul className="list-disc list-inside text-[12px] text-slate-500 dark:text-slate-400 space-y-1">
          {diagnostics.map((d, i) => <li key={i}>{d}</li>)}
        </ul>
      </div>

      <div>
        <h3 className="font-semibold text-slate-900 dark:text-white text-sm mb-1">Sensor readings</h3>
        <p className="text-[12px] text-slate-500 dark:text-slate-400 mb-3">Coolant temperature drives today's ThingsCare assessment; the rest are shown for context.</p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {sensors.map((s) => <SensorGraphCard key={s.key} sensor={s} />)}
        </div>
      </div>

      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 shadow-xs space-y-2">
        <h3 className="font-semibold text-slate-900 dark:text-white text-sm">Sample health trend</h3>
        {trend ? (
          <>
            <TrendSparkline values={trend} />
            <p className="text-[11px] text-slate-400 dark:text-slate-500">Fixture formula: 94 − 16 per active configured range alert, minimum 30.</p>
          </>
        ) : state === 'offline' ? (
          <p className="text-[12px] text-slate-500 dark:text-slate-400">No trend available while telemetry is offline.</p>
        ) : (
          <p className="text-[12px] text-slate-500 dark:text-slate-400">Stable at baseline — no active alerts to trend against.</p>
        )}
      </div>

      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 shadow-xs space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="font-semibold text-slate-900 dark:text-white text-sm">Diagnostics &amp; next action</h3>
          <button onClick={() => navigate('/work-orders')} className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-sky-600 text-white hover:bg-sky-700">
            <Plus className="w-3.5 h-3.5" /> Create diagnostic work order
          </button>
        </div>
        <div>
          <h4 className="text-[12px] font-medium text-slate-600 dark:text-slate-300 mb-2">Maintenance history</h4>
          {orders.length ? (
            <div className="space-y-2">
              {orders.map((o) => (
                <div key={o.id} className="border border-slate-100 dark:border-slate-800 rounded-lg p-3 flex items-start gap-2">
                  <Wrench className="w-4 h-4 text-slate-400 mt-0.5 shrink-0" />
                  <div className="min-w-0">
                    <p className="text-[12px] font-medium text-slate-700 dark:text-slate-200">{o.title} · {o.status}</p>
                    {o.notes && <p className="text-[11px] text-slate-400 dark:text-slate-500">{o.notes}</p>}
                    <small className="flex items-center gap-1 text-[11px] text-slate-400 dark:text-slate-500 pt-0.5">
                      <Clock3 className="w-3 h-3" />{new Date(o.createdAt).toLocaleString()}
                    </small>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-[12px] text-slate-400">No maintenance history for this Thing yet.</p>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button onClick={() => navigate('/work-orders')} className="px-3.5 py-2 text-sm font-medium rounded-lg bg-sky-600 text-white hover:bg-sky-700">
          Create work order
        </button>
      </div>

      <FeatureCrossLinks thingId={thing.id} current="things-care" />
    </div>
  );
};
