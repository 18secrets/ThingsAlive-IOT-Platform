import React, { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Clock3, AlertTriangle, Bell, Plus } from 'lucide-react';
import { usePageHeader } from '../lib/PageHeaderContext';
import { FleetFilters, DEFAULT_FLEET_SCOPE, matchingFleet } from '../components/fleet/FleetFilters';
import { FLEET, findThing } from '../data/fleetMockData';
import { productionSummaryFor } from '../data/productionMockData';
import { FeatureCrossLinks } from '../components/fleet/FeatureCrossLinks';
import { RingGauge } from '../components/common/RingGauge';
import { Chip } from '../components/common/Chip';

export const ProductionMonitoringDetailPage: React.FC = () => {
  const { thingId } = useParams<{ thingId: string }>();
  const navigate = useNavigate();
  const thing = thingId ? findThing(thingId) : undefined;
  const [scope, setScope] = useState(DEFAULT_FLEET_SCOPE);
  const matching = useMemo(() => matchingFleet(FLEET, scope), [scope]);
  usePageHeader({
    title: thing ? thing.name : 'Thing not found',
    subtitle: 'Production Monitoring Detail',
    onBack: () => navigate('/production-monitoring'),
  });

  if (!thing) {
    return (
      <div className="space-y-4">
        <FleetFilters scope={scope} onChange={setScope} things={matching} selectedId="all" onSelectId={(id) => navigate(`/production-monitoring/${id}`)} />
        <p className="text-sm text-slate-500">This Thing could not be found.</p>
      </div>
    );
  }

  const summary = productionSummaryFor(thing);
  const gaugeColor = summary.oeePercent >= 75 ? 'text-emerald-500 dark:text-emerald-400' : summary.oeePercent >= 60 ? 'text-amber-500 dark:text-amber-400' : 'text-rose-500 dark:text-rose-400';

  return (
    <div className="space-y-3">
      <div className="bg-gradient-to-r from-sky-600 to-cyan-600 rounded-xl p-6 text-white space-y-1">
        <span className="text-[11px] font-semibold tracking-wider uppercase text-sky-100">Production Wellbeing</span>
        <h2 className="text-xl font-bold">Production Monitoring &amp; Performance</h2>
      </div>

      <FleetFilters scope={scope} onChange={setScope} things={matching} selectedId={thing.id} onSelectId={(id) => navigate(id === 'all' ? '/production-monitoring' : `/production-monitoring/${id}`)} />

      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 shadow-xs space-y-4">
        <div className="flex items-center gap-4">
          <span title="Illustrative OEE — uses the existing demonstration assumptions.">
            <RingGauge value={summary.oeePercent} size={64} colorClass={gaugeColor} />
          </span>
          <div className="min-w-0 flex-1">
            <h3 className="font-semibold text-slate-900 dark:text-white text-sm truncate">{thing.name}</h3>
            <p className="text-[12px] text-slate-500 dark:text-slate-400 truncate">{thing.id} · {thing.location}</p>
            <div className="flex flex-wrap items-center gap-1.5 mt-2">
              <Chip icon={Clock3} title="Uptime hours">{summary.uptimeHours.toFixed(0)}h up</Chip>
              <Chip icon={AlertTriangle} tone={summary.downtimeHours > 0 ? 'amber' : 'slate'} title="Downtime hours">{summary.downtimeHours.toFixed(0)}h down</Chip>
              <Chip icon={Bell} tone={summary.activeAlerts > 0 ? 'amber' : 'slate'} title="Active configured range alerts">{summary.activeAlerts} alerts</Chip>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-slate-100 dark:border-slate-800">
          <button onClick={() => navigate('/work-orders')} className="inline-flex items-center gap-1.5 px-3.5 py-2 text-sm font-medium rounded-lg bg-sky-600 text-white hover:bg-sky-700">
            <Plus className="w-3.5 h-3.5" /> Create work order
          </button>
        </div>

        <FeatureCrossLinks thingId={thing.id} current="production-monitoring" />
      </div>
    </div>
  );
};
