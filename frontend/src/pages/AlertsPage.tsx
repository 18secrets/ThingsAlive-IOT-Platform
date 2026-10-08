import React, { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, Sparkles } from 'lucide-react';
import { usePageHeader } from '../lib/PageHeaderContext';
import { FleetFilters, DEFAULT_FLEET_SCOPE, matchingFleet } from '../components/fleet/FleetFilters';
import { RuleCard } from '../components/fleet/RuleCard';
import { RuleBuilderModal } from '../components/fleet/RuleBuilderModal';
import { FLEET, isBreaching } from '../data/fleetMockData';
import { ConfiguredRule, rulesByOutcome } from '../data/configuredRulesMockData';

export const AlertsPage: React.FC = () => {
  usePageHeader({ title: 'Alerts', subtitle: 'Fleet Attention Feed' });
  const navigate = useNavigate();
  const [scope, setScope] = useState(DEFAULT_FLEET_SCOPE);
  const [selectedId, setSelectedId] = useState('all');
  const [builderRule, setBuilderRule] = useState<ConfiguredRule | 'new' | null>(null);

  const matching = useMemo(() => matchingFleet(FLEET, scope), [scope]);
  const breaching = useMemo(
    () => matching.filter(isBreaching).filter((t) => selectedId === 'all' || t.id === selectedId),
    [matching, selectedId],
  );
  const alertRules = rulesByOutcome('alert');

  return (
    <div id="alerts-view" className="space-y-3">
      <div className="bg-gradient-to-r from-sky-600 to-cyan-600 rounded-xl p-6 text-white space-y-1">
        <h2 className="text-xl font-bold">Things Alerts</h2>
        <p className="text-sm text-sky-100">From machine signals to your next best action.</p>
      </div>

      <FleetFilters scope={scope} onChange={setScope} things={matching} selectedId={selectedId} onSelectId={setSelectedId} />

      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 shadow-xs">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-semibold text-slate-900 dark:text-white text-base">Configured alert rules</h3>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setBuilderRule('new')}
              className="px-3.5 py-2 text-sm font-medium rounded-lg bg-sky-600 text-white hover:bg-sky-700"
            >
              Create alert
            </button>
            {/* Testing only — shows the AI Assistant + Work Flow canvas flow
                side by side with the form-based one above, for team review
                before deciding which to keep. See AlertAgentPage.tsx. */}
            <button
              onClick={() => navigate('/alert-agent', { state: { view: 'assistant', backTo: '/alerts' } })}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-sm font-medium rounded-lg border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:border-sky-300"
            >
              <Sparkles className="w-4 h-4" /> Create alert with AI
            </button>
          </div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {alertRules.map((r) => <RuleCard key={r.id} rule={r} onEdit={setBuilderRule} />)}
        </div>
      </div>

      <div>
        <h3 className="font-semibold text-slate-900 dark:text-white text-base mb-1">Things Alerts</h3>
        <p className="text-sm text-slate-500 dark:text-slate-400 mb-4">{breaching.length} active range alerts</p>

        {breaching.length === 0 ? (
          <div className="py-10 text-center text-slate-400 text-sm bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl">
            No active range alerts for this selection.
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {breaching.map((t) => (
              <div key={t.id} className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 shadow-xs space-y-2">
                <span className="inline-flex items-center gap-1.5 text-xs font-medium text-amber-700 dark:text-amber-400">
                  <AlertTriangle className="w-4 h-4" /> Range exceeded
                </span>
                <h4 className="font-semibold text-slate-900 dark:text-white text-base">Coolant temperature</h4>
                <p className="text-sm text-slate-500 dark:text-slate-400">{t.name}</p>
                <div className="text-2xl font-bold font-mono text-amber-600 dark:text-amber-400">{t.coolantNowC.toFixed(2)} °C</div>
                <p className="text-xs text-slate-400 dark:text-slate-500 leading-relaxed">
                  Demo range: 0–{t.coolantLimitC} °C · threshold breach, not a diagnosed fault.
                </p>
                <p className="text-xs text-slate-400 dark:text-slate-500 leading-relaxed">
                  Financial impact: see Cost Administration.
                </p>
                <button
                  onClick={() => navigate('/work-orders')}
                  className="mt-1 px-3.5 py-2 text-sm font-medium rounded-lg bg-sky-600 text-white hover:bg-sky-700"
                >
                  Create work order
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <RuleBuilderModal
        isOpen={builderRule !== null}
        onClose={() => setBuilderRule(null)}
        rule={builderRule !== 'new' ? builderRule ?? undefined : undefined}
        defaultOutcome="alert"
      />
    </div>
  );
};
