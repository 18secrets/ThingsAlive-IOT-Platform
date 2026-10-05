import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Pencil, Wrench } from 'lucide-react';
import { ConfiguredRule } from '../../data/configuredRulesMockData';
import { findThing } from '../../data/fleetMockData';

// Read-only summary card for a configured rule. "Edit / assign" opens this
// rule in RuleBuilderPage's form + simulate/confirm flow — the same place a
// new rule is created — with its back arrow returning here rather than to
// Alert Agent's own list, which this flow never visits.
export const RuleCard: React.FC<{ rule: ConfiguredRule; backTo: string }> = ({ rule, backTo }) => {
  const navigate = useNavigate();
  const thing = findThing(rule.equipmentId);

  return (
    <div className="border border-slate-200 dark:border-slate-800 rounded-lg p-3.5 space-y-2">
      <span className="inline-flex px-2 py-0.5 text-[10px] font-medium rounded border bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 border-slate-200 dark:border-slate-700">
        Revision {rule.revision} · {rule.enabled ? 'Enabled' : 'Disabled'}
      </span>
      <h4 className="font-semibold text-slate-900 dark:text-white text-sm">{rule.name}</h4>
      <p className="text-[12px] text-slate-500 dark:text-slate-400">{thing?.name ?? rule.equipmentId} · {rule.equipmentId}</p>
      <p className="text-[12px] font-mono text-slate-600 dark:text-slate-300">{rule.sensorKey} {rule.operator} {rule.threshold} {rule.unit}</p>

      {rule.outcomes.includes('kpi') && rule.kpiValue !== undefined && (
        <p className="text-[12px] font-semibold text-slate-800 dark:text-slate-100">KPI: {rule.kpiValue} {rule.unit}</p>
      )}
      {rule.outcomes.includes('alert') && (
        <p className={`text-[12px] font-medium ${rule.alertOutcome === 'Breach' ? (rule.severity === 'Critical' ? 'text-rose-600 dark:text-rose-400' : 'text-amber-600 dark:text-amber-400') : 'text-slate-500 dark:text-slate-400'}`}>
          Alert: {rule.alertOutcome === 'Breach' ? rule.severity : (rule.alertOutcome ?? 'No breach')}
        </p>
      )}
      {rule.outcomes.includes('prediction') && (
        <p className="text-[12px] text-slate-500 dark:text-slate-400">Prediction: {rule.predictionText}</p>
      )}

      <div className="flex items-center gap-3 pt-1">
        <button
          onClick={() => navigate('/rule-builder', { state: { rule, backTo } })}
          className="inline-flex items-center gap-1 text-[12px] font-medium text-sky-700 dark:text-sky-400 hover:underline"
        >
          <Pencil className="w-3 h-3" /> Edit / assign
        </button>
        <button onClick={() => navigate('/work-orders')} className="inline-flex items-center gap-1 text-[12px] font-medium text-sky-700 dark:text-sky-400 hover:underline">
          <Wrench className="w-3 h-3" /> Create work order
        </button>
      </div>
    </div>
  );
};
