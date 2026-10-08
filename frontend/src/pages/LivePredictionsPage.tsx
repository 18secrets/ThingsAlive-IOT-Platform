import React, { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Sparkles } from 'lucide-react';
import { usePageHeader } from '../lib/PageHeaderContext';
import { FleetFilters, DEFAULT_FLEET_SCOPE, matchingFleet } from '../components/fleet/FleetFilters';
import { RuleCard } from '../components/fleet/RuleCard';
import { RuleBuilderModal } from '../components/fleet/RuleBuilderModal';
import { FLEET, predictionFor } from '../data/fleetMockData';
import { ConfiguredRule, rulesByOutcome } from '../data/configuredRulesMockData';

export const LivePredictionsPage: React.FC = () => {
  usePageHeader({ title: 'Live Predictions', subtitle: 'Automated Dispatch' });
  const navigate = useNavigate();
  const [scope, setScope] = useState(DEFAULT_FLEET_SCOPE);
  const [selectedId, setSelectedId] = useState('all');
  const [builderRule, setBuilderRule] = useState<ConfiguredRule | 'new' | null>(null);

  const matching = useMemo(() => matchingFleet(FLEET, scope), [scope]);
  const visible = useMemo(() => matching.filter((t) => selectedId === 'all' || t.id === selectedId), [matching, selectedId]);
  const predictionRules = rulesByOutcome('prediction');

  return (
    <div id="live-predictions-view" className="space-y-3">
      <div className="bg-gradient-to-r from-sky-600 to-cyan-600 rounded-xl p-6 text-white space-y-1">
        <h2 className="text-xl font-bold">Things Predictions</h2>
        <p className="text-sm text-sky-100">From machine signals to your next best action.</p>
      </div>

      <FleetFilters scope={scope} onChange={setScope} things={matching} selectedId={selectedId} onSelectId={setSelectedId} />

      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 shadow-xs">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-semibold text-slate-900 dark:text-white text-base">Prediction scenarios</h3>
          <button
            onClick={() => setBuilderRule('new')}
            className="px-3.5 py-2 text-sm font-medium rounded-lg bg-sky-600 text-white hover:bg-sky-700"
          >
            Create prediction scenario
          </button>
        </div>
        {predictionRules.length ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {predictionRules.map((r) => <RuleCard key={r.id} rule={r} onEdit={setBuilderRule} />)}
          </div>
        ) : (
          <p className="text-sm text-slate-400">No configured prediction outcomes for this selection.</p>
        )}
      </div>

      <RuleBuilderModal
        isOpen={builderRule !== null}
        onClose={() => setBuilderRule(null)}
        rule={builderRule !== 'new' ? builderRule ?? undefined : undefined}
        defaultOutcome="prediction"
      />

      <div>
        <h3 className="font-semibold text-slate-900 dark:text-white text-base">Prediction KPIs</h3>
        <p className="text-sm text-slate-500 dark:text-slate-400 mb-4">Trend visibility with explicit limits on forecast confidence</p>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {visible.map((t) => {
            const f = predictionFor(t);
            return (
              <div key={t.id} className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 shadow-xs space-y-2">
                <span className="inline-flex px-2 py-0.5 text-[10px] font-medium rounded border bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 border-slate-200 dark:border-slate-700">
                  PLANNING ESTIMATE · {f.priority.toUpperCase()}
                </span>
                <h4 className="font-semibold text-slate-900 dark:text-white text-base">{t.name}</h4>
                <div className="text-2xl font-bold font-mono text-slate-800 dark:text-slate-100">{f.fuelL.toFixed(1)} L</div>
                <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
                  Next 8h · from {f.samples} recent samples, same load assumed.
                </p>
                <p className="text-xs text-slate-500 dark:text-slate-400">Idle share {(f.idleShare * 100).toFixed(1)}% · {f.action}</p>
                {t.offline && <p className="text-xs text-slate-400 dark:text-slate-500">Offline — using recorded history.</p>}
                <p className="text-xs text-slate-400 dark:text-slate-500">Planning estimate, not a validated prediction.</p>
                <div className="flex items-center gap-3 pt-1">
                  <button onClick={() => navigate('/work-orders')} className="inline-flex items-center gap-1 text-xs font-medium text-sky-700 dark:text-sky-400 hover:underline">
                    <Sparkles className="w-3.5 h-3.5" /> Create work order
                  </button>
                </div>
              </div>
            );
          })}
        </div>

        {visible.length === 0 && (
          <div className="py-10 text-center text-slate-400 text-sm bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl">
            No Things match this filter.
          </div>
        )}
      </div>
    </div>
  );
};
