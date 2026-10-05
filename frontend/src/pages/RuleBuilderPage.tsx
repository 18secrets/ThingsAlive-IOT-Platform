import React, { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { usePageHeader } from '../lib/PageHeaderContext';
import { ConfiguredRule, RuleOutcome, RuleSeverity, MOCK_RULES, upsertRule } from '../data/configuredRulesMockData';
import { FLEET, SENSOR_SPECS, evaluateRuleForThing } from '../data/fleetMockData';

interface NavState {
  /** Present when reached via a RuleCard's "Edit / assign" — pre-fills the
   *  form and pre-checks this rule's own machine in the review step. */
  rule?: ConfiguredRule;
  /** Where this flow started (Alerts/Predictions/Scenarios/a Thing detail
   *  page) — both Cancel and a successful Confirm return here. */
  backTo: string;
  defaultOutcome?: RuleOutcome;
}

interface Draft {
  name: string;
  sensorKey: string;
  operator: '>' | '<';
  threshold: number;
  severity: RuleSeverity;
  outcomes: RuleOutcome[];
  horizonHours: number;
  enabled: boolean;
}

function draftFrom(rule: ConfiguredRule | undefined, defaultOutcome: RuleOutcome | undefined): Draft {
  if (rule) {
    return {
      name: rule.name, sensorKey: rule.sensorKey, operator: rule.operator, threshold: rule.threshold,
      severity: rule.severity, outcomes: rule.outcomes, horizonHours: rule.horizonHours, enabled: rule.enabled,
    };
  }
  return {
    name: 'New scenario', sensorKey: SENSOR_SPECS[0].key, operator: '>', threshold: 0,
    severity: 'Warning', outcomes: [defaultOutcome ?? 'kpi'], horizonHours: 8, enabled: true,
  };
}

const fieldClass = 'w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-sm text-slate-700 dark:text-slate-200';
const labelClass = 'text-xs font-medium text-slate-600 dark:text-slate-300';

export const RuleBuilderPage: React.FC = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const navState = location.state as NavState | null;
  const backTo = navState?.backTo ?? '/alerts';
  const existingRule = navState?.rule;

  const [step, setStep] = useState<'form' | 'review'>('form');
  const [draft, setDraft] = useState<Draft>(() => draftFrom(existingRule, navState?.defaultOutcome));
  const [selected, setSelected] = useState<Record<string, boolean>>(() => (existingRule ? { [existingRule.equipmentId]: true } : {}));
  const [inputs, setInputs] = useState<Record<string, number>>({});
  const [reviewedFingerprint, setReviewedFingerprint] = useState('');

  const fingerprint = JSON.stringify({ draft, selected, inputs });
  const selectedIds = Object.keys(selected).filter((id) => selected[id]);
  const sensor = SENSOR_SPECS.find((s) => s.key === draft.sensorKey) ?? SENSOR_SPECS[0];

  usePageHeader(
    step === 'review'
      ? { title: existingRule ? 'Edit Alert Rule' : 'Create Alert Rule', subtitle: 'Simulate & Confirm', onBack: () => setStep('form') }
      : { title: existingRule ? 'Edit Alert Rule' : 'Create Alert Rule', subtitle: 'Rule Details', onBack: () => navigate(backTo) },
  );

  function update(change: Partial<Draft>) {
    setDraft((d) => ({ ...d, ...change }));
  }

  function toggleOutcome(outcome: RuleOutcome) {
    update({ outcomes: draft.outcomes.includes(outcome) ? draft.outcomes.filter((o) => o !== outcome) : [...draft.outcomes, outcome] });
  }

  function confirm() {
    for (const equipmentId of selectedIds) {
      const thing = FLEET.find((t) => t.id === equipmentId);
      if (!thing) continue;
      const result = evaluateRuleForThing(thing, draft, inputs[equipmentId]);
      const isOriginal = existingRule?.equipmentId === equipmentId;
      const id = isOriginal ? existingRule!.id : crypto.randomUUID();
      const revision = isOriginal ? existingRule!.revision + 1 : 1;
      upsertRule({
        id, name: draft.name, equipmentId, sensorKey: draft.sensorKey, operator: draft.operator, threshold: draft.threshold,
        unit: sensor.unit, severity: draft.severity, horizonHours: draft.horizonHours, enabled: draft.enabled, revision,
        outcomes: draft.outcomes,
        kpiValue: draft.outcomes.includes('kpi') ? result.value : undefined,
        alertOutcome: draft.outcomes.includes('alert') ? (result.triggered ? 'Breach' : 'No breach') : undefined,
        predictionText: draft.outcomes.includes('prediction') ? `${result.predicted} ${sensor.unit} over ${draft.horizonHours} h. Linear planning projection, not a failure model.` : undefined,
      });
    }
    navigate(backTo);
  }

  if (step === 'review') {
    return (
      <div className="space-y-6">
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 shadow-xs space-y-4">
          <div>
            <h3 className="font-semibold text-slate-900 dark:text-white text-sm">Simulate and review changes</h3>
            <p className="text-[12px] text-slate-500 dark:text-slate-400 mt-1">Select affected machines. Test values affect this preview only; active rules and readings remain unchanged.</p>
          </div>

          <div className="border-t border-slate-100 dark:border-slate-800 pt-3">
            <h4 className="font-semibold text-slate-800 dark:text-slate-100 text-sm">{draft.name}</h4>
            <p className="text-[12px] text-slate-500 dark:text-slate-400 mt-0.5">
              {draft.sensorKey} {draft.operator} {draft.threshold} {sensor.unit} · {draft.outcomes.join(', ')} · {draft.enabled ? 'Enabled' : 'Disabled'}
            </p>
          </div>

          <div className="max-h-[420px] overflow-y-auto space-y-2 -mx-1 px-1">
            {FLEET.map((t) => {
              const checked = !!selected[t.id];
              const value = inputs[t.id] ?? evaluateRuleForThing(t, draft).value;
              const before = MOCK_RULES.find((r) => r.equipmentId === t.id && r.sensorKey === draft.sensorKey && r.id !== existingRule?.id);
              const result = evaluateRuleForThing(t, draft, inputs[t.id]);
              return (
                <div key={t.id} className="border border-slate-100 dark:border-slate-800 rounded-lg p-3 space-y-2">
                  <label className="flex items-center gap-2 text-[13px] text-slate-700 dark:text-slate-200">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={(e) => { setSelected({ ...selected, [t.id]: e.target.checked }); setReviewedFingerprint(''); }}
                    />
                    {t.name} · {t.id}
                  </label>
                  {checked && (
                    <>
                      <label className="block space-y-1 max-w-xs">
                        <span className={labelClass}>Preview reading ({sensor.unit})</span>
                        <input
                          type="number" step="any" value={value}
                          onChange={(e) => { setInputs({ ...inputs, [t.id]: Number(e.target.value) }); setReviewedFingerprint(''); }}
                          className={fieldClass}
                        />
                      </label>
                      <p className="text-[11px] text-slate-400 dark:text-slate-500">
                        Before: {before ? `${before.operator} ${before.threshold} ${before.unit} · revision ${before.revision}` : 'Not assigned'} → Proposed: {draft.operator} {draft.threshold} {sensor.unit}
                      </p>
                      {reviewedFingerprint === fingerprint && (
                        <p className="text-[11px] text-slate-500 dark:text-slate-400">
                          Evaluated · KPI {result.value} {sensor.unit} · Alert {result.triggered ? 'would trigger' : 'would not trigger'} · Prediction {result.predicted} {sensor.unit}
                        </p>
                      )}
                    </>
                  )}
                </div>
              );
            })}
          </div>

          <div className="flex items-center gap-2 pt-2">
            <button onClick={() => setReviewedFingerprint(fingerprint)} disabled={!selectedIds.length} className="px-3.5 py-2 text-sm font-medium rounded-lg bg-sky-600 text-white hover:bg-sky-700 disabled:opacity-40 disabled:cursor-not-allowed">
              Run simulation &amp; review impact
            </button>
            <button onClick={confirm} disabled={!selectedIds.length || reviewedFingerprint !== fingerprint} className="px-3.5 py-2 text-sm font-medium rounded-lg bg-sky-600 text-white hover:bg-sky-700 disabled:opacity-40 disabled:cursor-not-allowed">
              Confirm selected machines
            </button>
            <button onClick={() => navigate(backTo)} className="px-3.5 py-2 text-sm font-medium text-slate-500 hover:text-slate-800 dark:hover:text-slate-200">Cancel</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-2xl">
      <form
        className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-4 shadow-xs"
        onSubmit={(e) => { e.preventDefault(); setStep('review'); }}
      >
        <label className="block space-y-1">
          <span className={labelClass}>Name</span>
          <input required value={draft.name} onChange={(e) => update({ name: e.target.value })} className={fieldClass} />
        </label>
        <label className="block space-y-1">
          <span className={labelClass}>Sensor</span>
          <select value={draft.sensorKey} onChange={(e) => update({ sensorKey: e.target.value })} className={fieldClass}>
            {SENSOR_SPECS.map((s) => <option key={s.key} value={s.key}>{s.label} ({s.unit})</option>)}
          </select>
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block space-y-1">
            <span className={labelClass}>Condition</span>
            <select value={draft.operator} onChange={(e) => update({ operator: e.target.value as '>' | '<' })} className={fieldClass}>
              <option value=">">Greater than</option>
              <option value="<">Less than</option>
            </select>
          </label>
          <label className="block space-y-1">
            <span className={labelClass}>Threshold</span>
            <input type="number" step="any" required value={draft.threshold} onChange={(e) => update({ threshold: Number(e.target.value) })} className={fieldClass} />
          </label>
        </div>
        <label className="block space-y-1">
          <span className={labelClass}>Severity</span>
          <select value={draft.severity} onChange={(e) => update({ severity: e.target.value as RuleSeverity })} className={fieldClass}>
            <option value="Warning">Warning</option>
            <option value="Critical">Critical</option>
          </select>
        </label>
        <fieldset className="space-y-1.5">
          <legend className={labelClass}>Outcomes</legend>
          <div className="flex items-center gap-5">
            {(['kpi', 'alert', 'prediction'] as RuleOutcome[]).map((o) => (
              <label key={o} className="flex items-center gap-1.5 text-sm text-slate-700 dark:text-slate-200">
                <input type="checkbox" checked={draft.outcomes.includes(o)} onChange={() => toggleOutcome(o)} /> {o}
              </label>
            ))}
          </div>
        </fieldset>
        <label className="block space-y-1 max-w-xs">
          <span className={labelClass}>Prediction horizon (hours)</span>
          <input type="number" min={1} max={168} value={draft.horizonHours} onChange={(e) => update({ horizonHours: Number(e.target.value) })} className={fieldClass} />
        </label>
        <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200">
          <input type="checkbox" checked={draft.enabled} onChange={(e) => update({ enabled: e.target.checked })} /> Enabled
        </label>
        <div className="flex items-center gap-2 pt-2">
          <button type="submit" disabled={!draft.outcomes.length} className="px-3.5 py-2 text-sm font-medium rounded-lg bg-sky-600 text-white hover:bg-sky-700 disabled:opacity-40 disabled:cursor-not-allowed">
            Choose machines &amp; preview
          </button>
          <button type="button" onClick={() => navigate(backTo)} className="px-3.5 py-2 text-sm font-medium text-slate-500 hover:text-slate-800 dark:hover:text-slate-200">Cancel</button>
        </div>
      </form>
    </div>
  );
};
