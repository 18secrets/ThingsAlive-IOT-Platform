import React, { useState } from 'react';
import { usePageHeader } from '../lib/PageHeaderContext';
import { RuleCard } from '../components/fleet/RuleCard';
import { RuleBuilderModal } from '../components/fleet/RuleBuilderModal';
import { ConfiguredRule, MOCK_RULES } from '../data/configuredRulesMockData';

// No Thing-filter bar here — matches the client-ui-new demo, which hides its
// equivalent filter bar on this one tab since a workflow belongs to a single
// Thing, not a filtered fleet view.
export const ScenariosPage: React.FC = () => {
  usePageHeader({ title: 'Scenarios', subtitle: 'Monitoring Workflows' });
  const [builderRule, setBuilderRule] = useState<ConfiguredRule | 'new' | null>(null);

  return (
    <div id="scenarios-view" className="space-y-6">
      <div className="bg-gradient-to-r from-sky-600 to-cyan-600 rounded-xl p-6 text-white space-y-1">
        <h2 className="text-xl font-bold">Things Scenarios</h2>
        <p className="text-sm text-sky-100">From machine signals to your next best action.</p>
      </div>

      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 shadow-xs">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-semibold text-slate-900 dark:text-white text-sm">Reusable workflows &amp; outcomes</h3>
          <button
            onClick={() => setBuilderRule('new')}
            className="px-3 py-1.5 text-xs font-medium rounded-lg bg-sky-600 text-white hover:bg-sky-700"
          >
            Create workflow
          </button>
        </div>
        {MOCK_RULES.length ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {MOCK_RULES.map((r) => <RuleCard key={r.id} rule={r} onEdit={setBuilderRule} />)}
          </div>
        ) : (
          <p className="text-[13px] text-slate-400">No configured outcomes yet. Create a rule in Alert Agent.</p>
        )}
      </div>

      <RuleBuilderModal
        isOpen={builderRule !== null}
        onClose={() => setBuilderRule(null)}
        rule={builderRule !== 'new' ? builderRule ?? undefined : undefined}
      />
    </div>
  );
};
