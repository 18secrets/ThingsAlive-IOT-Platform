import React, { useEffect, useState } from 'react';
import { Checkbox, CheckPicker, Input, InputNumber, SelectPicker } from 'rsuite';
import { Modal } from '../common/Modal';
import { ConfiguredRule, RuleOutcome, RuleSeverity, MOCK_RULES, upsertRule } from '../../data/configuredRulesMockData';
import { FLEET, SENSOR_SPECS, evaluateRuleForThing } from '../../data/fleetMockData';

interface RuleBuilderModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Present when reached via a RuleCard's "Edit / assign" — pre-fills the
   *  form and pre-checks this rule's own machine in the review step. */
  rule?: ConfiguredRule;
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

const labelClass = 'text-xs font-medium text-slate-600 dark:text-slate-300';

// Was a standalone routed page (RuleBuilderPage, reached via navigate('/rule-builder', {state})).
// Converted to a modal so Alerts/Predictions/Scenarios and a RuleCard's "Edit / assign" open it
// in place instead of leaving the page — see the task that asked for forms to stop being separate
// pages or same-page drilldowns.
export const RuleBuilderModal: React.FC<RuleBuilderModalProps> = ({ isOpen, onClose, rule: existingRule, defaultOutcome }) => {
  const [step, setStep] = useState<'form' | 'review'>('form');
  const [draft, setDraft] = useState<Draft>(() => draftFrom(existingRule, defaultOutcome));
  const [selected, setSelected] = useState<Record<string, boolean>>(() => (existingRule ? { [existingRule.equipmentId]: true } : {}));
  const [inputs, setInputs] = useState<Record<string, number>>({});
  const [reviewedFingerprint, setReviewedFingerprint] = useState('');

  // Re-seed everything each time the modal opens, rather than leaving stale
  // state from a previous rule around for the next one it's opened with.
  useEffect(() => {
    if (!isOpen) return;
    setStep('form');
    setDraft(draftFrom(existingRule, defaultOutcome));
    setSelected(existingRule ? { [existingRule.equipmentId]: true } : {});
    setInputs({});
    setReviewedFingerprint('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, existingRule?.id]);

  const fingerprint = JSON.stringify({ draft, selected, inputs });
  const selectedIds = Object.keys(selected).filter((id) => selected[id]);
  const sensor = SENSOR_SPECS.find((s) => s.key === draft.sensorKey) ?? SENSOR_SPECS[0];

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
    onClose();
  }

  const title = existingRule ? 'Edit Alert Rule' : 'Create Alert Rule';

  if (step === 'review') {
    return (
      <Modal isOpen={isOpen} onClose={onClose} title={title} subtitle="Simulate & Confirm" maxWidth="max-w-2xl">
        <div className="space-y-4">
          <p className="text-xs text-slate-500 dark:text-slate-400">Select machines. Test values affect this preview only.</p>

          <div className="border-t border-slate-100 dark:border-slate-800 pt-3">
            <h4 className="font-semibold text-slate-800 dark:text-slate-100 text-sm">{draft.name}</h4>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              {draft.sensorKey} {draft.operator} {draft.threshold} {sensor.unit} · {draft.outcomes.join(', ')} · {draft.enabled ? 'Enabled' : 'Disabled'}
            </p>
          </div>

          <div className="max-h-[360px] overflow-y-auto space-y-2 -mx-1 px-1">
            {FLEET.map((t) => {
              const checked = !!selected[t.id];
              const value = inputs[t.id] ?? evaluateRuleForThing(t, draft).value;
              const before = MOCK_RULES.find((r) => r.equipmentId === t.id && r.sensorKey === draft.sensorKey && r.id !== existingRule?.id);
              const result = evaluateRuleForThing(t, draft, inputs[t.id]);
              return (
                <div key={t.id} className={`border rounded-lg p-3 space-y-2 transition-colors ${checked ? 'border-sky-300 dark:border-sky-800 bg-sky-50/50 dark:bg-sky-950/20' : 'border-slate-100 dark:border-slate-800'}`}>
                  <Checkbox
                    checked={checked}
                    onChange={(_, isChecked) => { setSelected({ ...selected, [t.id]: isChecked }); setReviewedFingerprint(''); }}
                  >
                    <span className="text-sm text-slate-700 dark:text-slate-200">{t.name} · {t.id}</span>
                  </Checkbox>
                  {checked && (
                    <>
                      <label className="block space-y-1 max-w-xs">
                        <span className={labelClass}>Preview reading ({sensor.unit})</span>
                        <InputNumber
                          value={value}
                          onChange={(value) => { setInputs({ ...inputs, [t.id]: Number(value) }); setReviewedFingerprint(''); }}
                          className="w-full"
                        />
                      </label>
                      <p className="text-xs text-slate-400 dark:text-slate-500">
                        Before: {before ? `${before.operator} ${before.threshold} ${before.unit} · rev ${before.revision}` : 'Not assigned'} → Proposed: {draft.operator} {draft.threshold} {sensor.unit}
                      </p>
                      {reviewedFingerprint === fingerprint && (
                        <p className="text-xs text-slate-500 dark:text-slate-400">
                          KPI {result.value} {sensor.unit} · Alert {result.triggered ? 'triggers' : 'no trigger'} · Predicted {result.predicted} {sensor.unit}
                        </p>
                      )}
                    </>
                  )}
                </div>
              );
            })}
          </div>

          <div className="pt-3 border-t border-slate-100 dark:border-slate-800 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <button onClick={() => setStep('form')} className="text-sm text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 self-start">Back</button>
            <div className="flex flex-wrap items-center justify-end gap-2">
              <button type="button" onClick={onClose} className="px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 text-sm font-semibold hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors">
                Cancel
              </button>
              <button onClick={() => setReviewedFingerprint(fingerprint)} disabled={!selectedIds.length} className="px-4 py-2 text-sm font-semibold rounded-lg border border-sky-300 dark:border-sky-800 text-sky-700 dark:text-sky-400 hover:bg-sky-50 dark:hover:bg-sky-950/40 disabled:opacity-40 disabled:cursor-not-allowed">
                Run simulation
              </button>
              <button onClick={confirm} disabled={!selectedIds.length || reviewedFingerprint !== fingerprint} className="px-4 py-2 rounded-lg bg-sky-600 hover:bg-sky-700 text-white text-sm font-semibold transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
                Confirm &amp; save
              </button>
            </div>
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={title} subtitle="Rule Details" maxWidth="max-w-xl">
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); setStep('review'); }}>
        <label className="block space-y-1">
          <span className={labelClass}>Name</span>
          <Input required value={draft.name} onChange={(value) => update({ name: value })} />
        </label>
        <div className="block space-y-1">
          <span className={labelClass}>Sensor</span>
          <SelectPicker
            data={SENSOR_SPECS.map((s) => ({ label: `${s.label} (${s.unit})`, value: s.key }))}
            value={draft.sensorKey}
            onChange={(value) => update({ sensorKey: value ?? SENSOR_SPECS[0].key })}
            searchable={false}
            cleanable={false}
            block
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="block space-y-1">
            <span className={labelClass}>Condition</span>
            <SelectPicker
              data={[{ label: 'Greater than', value: '>' }, { label: 'Less than', value: '<' }]}
              value={draft.operator}
              onChange={(value) => update({ operator: (value ?? '>') as '>' | '<' })}
              searchable={false}
              cleanable={false}
              block
            />
          </div>
          <label className="block space-y-1">
            <span className={labelClass}>Threshold</span>
            <InputNumber required value={draft.threshold} onChange={(value) => update({ threshold: Number(value) })} className="w-full" />
          </label>
        </div>
        <div className="block space-y-1">
          <span className={labelClass}>Severity</span>
          <SelectPicker
            data={[{ label: 'Warning', value: 'Warning' }, { label: 'Critical', value: 'Critical' }]}
            value={draft.severity}
            onChange={(value) => update({ severity: (value ?? 'Warning') as RuleSeverity })}
            searchable={false}
            cleanable={false}
            block
          />
        </div>
        <fieldset className="space-y-1.5">
          <legend className={labelClass}>Outcomes</legend>
          <CheckPicker
            data={(['kpi', 'alert', 'prediction'] as RuleOutcome[]).map((o) => ({ label: o, value: o }))}
            value={draft.outcomes}
            onChange={(values) => update({ outcomes: values ?? [] })}
            searchable={false}
            block
          />
        </fieldset>
        <label className="block space-y-1 max-w-xs">
          <span className={labelClass}>Prediction horizon (hours)</span>
          <InputNumber min={1} max={168} value={draft.horizonHours} onChange={(value) => update({ horizonHours: Number(value) })} className="w-full" />
        </label>
        <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200">
          <input type="checkbox" checked={draft.enabled} onChange={(e) => update({ enabled: e.target.checked })} /> Enabled
        </label>
        <div className="pt-3 border-t border-slate-100 dark:border-slate-800 flex items-center justify-end gap-3">
          <button type="button" onClick={onClose} className="px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 text-sm font-semibold hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors">
            Cancel
          </button>
          <button type="submit" disabled={!draft.outcomes.length} className="px-4 py-2 rounded-lg bg-sky-600 hover:bg-sky-700 text-white text-sm font-semibold transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
            Choose machines &amp; preview
          </button>
        </div>
      </form>
    </Modal>
  );
};
