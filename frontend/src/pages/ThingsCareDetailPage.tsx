import React, { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Plus, Wrench, Clock3, AlertTriangle, CheckCircle2, WifiOff, Bell, ShieldAlert } from 'lucide-react';
import { usePageHeader } from '../lib/PageHeaderContext';
import { FleetFilters, DEFAULT_FLEET_SCOPE, matchingFleet } from '../components/fleet/FleetFilters';
import { SensorGraphCard } from '../components/fleet/SensorGraphCard';
import { FeatureCrossLinks } from '../components/fleet/FeatureCrossLinks';
import { FLEET, findThing, healthTrendFor, sensorsFor, thingsCareFor } from '../data/fleetMockData';
import { MOCK_WORK_ORDERS } from '../data/clientOpsMockData';
import { RingGauge } from '../components/common/RingGauge';
import { Chip } from '../components/common/Chip';

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
  const gaugeColor = state === 'healthy' ? 'text-emerald-500 dark:text-emerald-400' : state === 'at-risk' ? 'text-amber-500 dark:text-amber-400' : 'text-slate-400';

  return (
    <div className="space-y-3">
      <div className="bg-gradient-to-r from-sky-600 to-cyan-600 rounded-xl p-6 text-white space-y-1">
        <span className="text-[11px] font-semibold tracking-wider uppercase text-sky-100">Machine Wellbeing</span>
        <h2 className="text-xl font-bold">ThingsCare: Health &amp; Prognostics</h2>
      </div>

      <FleetFilters scope={scope} onChange={setScope} things={matching} selectedId={thing.id} onSelectId={(id) => navigate(id === 'all' ? '/things-care' : `/things-care/${id}`)} />

      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 shadow-xs">
        <div className="flex items-center gap-4">
          <span title="Sample health index">
            <RingGauge value={status.health} size={64} colorClass={gaugeColor} />
          </span>
          <div className="min-w-0 flex-1">
            <h3 className="font-semibold text-slate-900 dark:text-white text-sm truncate">{thing.name}</h3>
            <p className="text-[12px] text-slate-500 dark:text-slate-400 truncate">{thing.id} · {thing.location}</p>
            <div className="flex flex-wrap items-center gap-1.5 mt-2">
              <Chip icon={ShieldAlert} tone={status.riskPct != null && status.riskPct >= 20 ? 'rose' : 'slate'} title="Illustrative failure risk">
                {status.riskPct != null ? `${status.riskPct}% risk` : 'Not validated'}
              </Chip>
              <Chip icon={Clock3} title="Illustrative remaining useful life">
                {status.rulHours != null ? `${status.rulHours}h RUL` : 'Model required'}
              </Chip>
              <Chip icon={Bell} tone={status.alertCount > 0 ? 'amber' : 'slate'} title="Active configured range alerts">{status.alertCount} alerts</Chip>
            </div>
          </div>
        </div>
      </div>

      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 shadow-xs space-y-2">
        <h3 className="font-semibold text-slate-900 dark:text-white text-sm">Diagnostics</h3>
        {state === 'offline' && (
          <Chip icon={WifiOff} tone="slate" title="Health, risk and RUL cannot be assessed until the device reconnects.">Telemetry offline</Chip>
        )}
        {state === 'at-risk' && (
          <div className="flex flex-wrap gap-1.5">
            <Chip icon={AlertTriangle} tone="amber" title="Review cooling system and coolant level before the next shift.">
              Coolant {thing.coolantNowC.toFixed(1)}°C / {thing.coolantLimitC}°C limit
            </Chip>
          </div>
        )}
        {state === 'healthy' && (
          <Chip icon={CheckCircle2} tone="emerald">No active range alerts</Chip>
        )}
      </div>

      <div>
        <h3 className="font-semibold text-slate-900 dark:text-white text-sm mb-3">Sensor readings</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {sensors.map((s) => <SensorGraphCard key={s.key} sensor={s} />)}
        </div>
      </div>

      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 shadow-xs space-y-2">
        <h3 className="font-semibold text-slate-900 dark:text-white text-sm">Sample health trend</h3>
        {trend ? (
          <>
            <TrendSparkline values={trend} />
            <p className="text-[11px] text-slate-400 dark:text-slate-500" title="Fixture formula: 94 − 16 per active configured range alert, minimum 30.">
              Fixture trend, not a measured decline.
            </p>
          </>
        ) : state === 'offline' ? (
          <Chip icon={WifiOff} tone="slate">No trend while offline</Chip>
        ) : (
          <Chip icon={CheckCircle2} tone="emerald">Stable at baseline</Chip>
        )}
      </div>

      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 shadow-xs space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="font-semibold text-slate-900 dark:text-white text-sm">Next action</h3>
          <button onClick={() => navigate('/work-orders')} className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-sky-600 text-white hover:bg-sky-700">
            <Plus className="w-3.5 h-3.5" /> Create work order
          </button>
        </div>
        <div>
          <h4 className="text-[12px] font-medium text-slate-600 dark:text-slate-300 mb-2">Maintenance history</h4>
          {orders.length ? (
            <div className="space-y-2">
              {orders.map((o) => (
                <div key={o.id} className="border border-slate-100 dark:border-slate-800 rounded-lg p-3 flex items-start gap-2">
                  <Wrench className="w-4 h-4 text-slate-400 mt-0.5 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <p className="text-[12px] font-medium text-slate-700 dark:text-slate-200">{o.title} · {o.status}</p>
                    {o.notes && <p className="text-[11px] text-slate-400 dark:text-slate-500 truncate" title={o.notes}>{o.notes}</p>}
                    <small className="flex items-center gap-1 text-[11px] text-slate-400 dark:text-slate-500 pt-0.5">
                      <Clock3 className="w-3 h-3" />{new Date(o.createdAt).toLocaleDateString()}
                    </small>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-[12px] text-slate-400">No maintenance history yet.</p>
          )}
        </div>
      </div>

      <FeatureCrossLinks thingId={thing.id} current="things-care" />
    </div>
  );
};
