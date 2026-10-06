import React, { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { usePageHeader } from '../lib/PageHeaderContext';
import { FleetFilters, DEFAULT_FLEET_SCOPE, matchingFleet } from '../components/fleet/FleetFilters';
import { FLEET, findThing } from '../data/fleetMockData';
import { productionSummaryFor } from '../data/productionMockData';
import { FeatureCrossLinks } from '../components/fleet/FeatureCrossLinks';

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

  return (
    <div className="space-y-6">
      <div className="bg-gradient-to-r from-sky-600 to-cyan-600 rounded-xl p-6 text-white space-y-1">
        <span className="text-[11px] font-semibold tracking-wider uppercase text-sky-100">Production Wellbeing</span>
        <h2 className="text-xl font-bold">Production Monitoring &amp; Performance</h2>
        <p className="text-sm text-sky-100">Output, quality, equipment availability and next-shift planning.</p>
      </div>

      <FleetFilters scope={scope} onChange={setScope} things={matching} selectedId={thing.id} onSelectId={(id) => navigate(id === 'all' ? '/production-monitoring' : `/production-monitoring/${id}`)} />

      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 shadow-xs space-y-4">
        <div className="flex items-start justify-between">
          <div>
            <h3 className="font-semibold text-slate-900 dark:text-white text-sm">{thing.name}</h3>
            <p className="text-[12px] text-slate-500 dark:text-slate-400">{thing.id} · {thing.location}</p>
          </div>
          <span className="text-[11px] text-slate-300 dark:text-slate-600 cursor-not-allowed" title="Not available in this demo">Sample history</span>
        </div>

        <div>
          <h4 className="font-semibold text-slate-800 dark:text-slate-100 text-sm mb-3">Production &amp; machine wellbeing</h4>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <StatTile label="OEE" value={`${summary.oeePercent.toFixed(1)}%`} />
            <StatTile label="Uptime" value={`${summary.uptimeHours.toFixed(0)} h`} />
            <StatTile label="Downtime" value={`${summary.downtimeHours.toFixed(0)} h`} />
          </div>
        </div>

        <ul className="list-disc list-inside text-[12px] text-slate-500 dark:text-slate-400 space-y-1">
          <li>OEE uses the existing construction demonstration assumptions.</li>
          <li>Production forecast: requires timestamped output and an operating calendar.</li>
          <li>Machine wellbeing: {summary.activeAlerts} active configured alerts.</li>
        </ul>

        <div className="flex flex-wrap items-center gap-2">
          <button onClick={() => navigate('/work-orders')} className="px-3.5 py-2 text-sm font-medium rounded-lg bg-sky-600 text-white hover:bg-sky-700">
            Create work order
          </button>
        </div>

        <FeatureCrossLinks thingId={thing.id} current="production-monitoring" />
      </div>
    </div>
  );
};

const StatTile: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="border border-slate-100 dark:border-slate-800 rounded-lg p-3">
    <div className="text-lg font-bold text-slate-800 dark:text-slate-100">{value}</div>
    <div className="text-[11px] text-slate-400 dark:text-slate-500 mt-0.5">{label}</div>
  </div>
);
